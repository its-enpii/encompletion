/**
 * Extractors — turn uploaded binary buffers into plain text so the LLM can
 * reason about the content inline.
 *
 *   extractText({ buffer, mimeType, fileName }) → string | null
 *
 * Returns null when the file is not a supported type or extraction failed.
 * Throws only on programmer error (missing dep); runtime failures resolve
 * to null with an explanatory error message cached on the caller side.
 *
 * Supported:
 *   text/* + common code/data extensions (cheap utf-8 read)
 *   application/pdf (text-only via pdfjs-dist; image-only via tesseract OCR)
 *   docx (via mammoth)
 *   xlsx + xls + csv (via xlsx)
 *   pptx (slide text via zip + slide XML; legacy .ppt not supported)
 *
 * Not supported:
 *   odt, rtf, legacy .ppt, audio, video — the LLM gets [binary: name] only.
 */

import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import yauzl from 'yauzl';
import { createWorker } from 'tesseract.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/x-sh'];
const CODE_EXT_RE = /\.(txt|md|markdown|json|ya?ml|xml|html?|css|scss|sass|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|sql|sh|bash|zsh|ps1|env|ini|toml|cfg|conf|log|csv|tsv|vue|svelte|astro|mdx|tex|groovy|dart|lua|gradle|dockerfile|gitignore|gitattributes|editorconfig|htaccess|yaml|lock)$/i;

const INLINE_LIMIT = 200_000;

function looksLikeText(mime = '', name = '') {
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  return CODE_EXT_RE.test(name);
}

async function extractPlainText(buffer, mimeType, fileName) {
  if (!looksLikeText(mimeType, fileName)) return null;
  const text = buffer.toString('utf8');
  if (text.length === 0) return null;
  return text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + '\n\n[truncated]' : text;
}

async function extractDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  if (!value || value.trim().length === 0) return null;
  return value.length > INLINE_LIMIT ? value.slice(0, INLINE_LIMIT) + '\n\n[truncated]' : value;
}

async function extractXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      out.push(`# Sheet: ${name}\n${csv}`);
    }
  }
  if (out.length === 0) return null;
  const text = out.join('\n\n');
  return text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + '\n\n[truncated]' : text;
}

/**
 * PPTX is a ZIP of OOXML. Pull a:t text nodes from ppt/slides/slideN.xml
 * (and optional notes). No image OCR — text-only, same ceiling as other extractors.
 */
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
    });
}

/** Collect text runs from OOXML (`a:t` nodes). */
function stripXmlText(xml) {
  const parts = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const t = decodeXmlEntities(m[1]).trim();
    if (t) parts.push(t);
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readZipEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

async function extractPptx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  // PK zip magic
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return null;

  const entries = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const found = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (
          /^ppt\/slides\/slide\d+\.xml$/i.test(name) ||
          /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)
        ) {
          found.push(entry);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve({ zipfile, found }));
      zipfile.on('error', reject);
    });
  });

  const { zipfile, found } = entries;
  const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/i;
  const notesRe = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/i;
  const slides = new Map(); // n -> { body, notes }
  try {
    for (const entry of found) {
      const name = entry.fileName.replace(/\\/g, '/');
      const xml = await readZipEntry(zipfile, entry);
      const text = stripXmlText(xml);
      if (!text) continue;
      let m = name.match(slideRe);
      if (m) {
        const n = Number(m[1]);
        const cur = slides.get(n) || { body: '', notes: '' };
        cur.body = text;
        slides.set(n, cur);
        continue;
      }
      m = name.match(notesRe);
      if (m) {
        const n = Number(m[1]);
        const cur = slides.get(n) || { body: '', notes: '' };
        cur.notes = text;
        slides.set(n, cur);
      }
    }
  } finally {
    try { zipfile.close(); } catch { /* ignore */ }
  }

  if (slides.size === 0) return null;
  const nums = [...slides.keys()].sort((a, b) => a - b);
  const out = [];
  for (const n of nums) {
    const s = slides.get(n);
    const parts = [`## Slide ${n}`];
    if (s.body) parts.push(s.body);
    if (s.notes) parts.push(`Notes:\n${s.notes}`);
    out.push(parts.join('\n'));
  }
  const text = out.join('\n\n');
  return text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + '\n\n[truncated]' : text;
}

// pdf-parse's index.js runs a debug test on import (it tries to load
// ./test/data/05-versions-space.pdf). Import the implementation file
// directly to skip that side-effect.
let _pdfParseMod = null;
async function getPdfParse() {
  if (_pdfParseMod) return _pdfParseMod;
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  _pdfParseMod = mod.default || mod;
  return _pdfParseMod;
}

async function extractPdfText(buffer) {
  const pdfParse = await getPdfParse();
  const result = await pdfParse(buffer);
  if (!result || !result.text || result.text.trim().length === 0) return null;
  let text = result.text;
  return text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + '\n\n[truncated]' : text;
}

let _ocrWorker = null;
async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker;
  _ocrWorker = await createWorker(['eng', 'ind']);
  return _ocrWorker;
}

/**
 * Render the first N PDF pages to PNG using pdftoppm (poppler-utils).
 * Returns an array of Buffers, one per page. Falls back to an empty array
 * if the binary isn't on PATH — caller treats that as "no image content".
 */
async function renderPdfPagesToPng(buffer, pageCount) {
  const dir = await mkdtemp(join(tmpdir(), 'pdfocr-'));
  const id = crypto.randomBytes(6).toString('hex');
  const pdfPath = join(dir, `${id}.pdf`);
  await writeFile(pdfPath, buffer);
  const out = [];
  const limit = Math.min(pageCount, 5);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', String(limit), pdfPath, join(dir, id)]);
      let stderr = '';
      proc.stderr.on('data', (b) => { stderr += b.toString(); });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pdftoppm exit ${code}: ${stderr.slice(0, 200)}`)));
      proc.on('error', reject);
    });
    for (let i = 1; i <= limit; i++) {
      const p = join(dir, `${id}-${String(i).padStart(3, '0')}.png`);
      try {
        out.push(await readFile(p));
      } catch { /* missing page — ignore */ }
    }
  } finally {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return out;
}

async function extractPdfViaOcr(buffer) {
  const pages = await renderPdfPagesToPng(buffer, 5);
  if (pages.length === 0) return null;
  const worker = await getOcrWorker();
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const { data: { text } } = await worker.recognize(pages[i]);
    out.push(`--- Page ${i + 1} (OCR) ---\n${text.trim()}`);
  }
  if (out.length === 0) return null;
  const text = out.join('\n\n');
  return text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + '\n\n[truncated]' : text;
}

export async function extractText({ buffer, mimeType, fileName }) {
  try {
    if (!buffer || buffer.length === 0) return null;
    const mime = (mimeType || '').toLowerCase();
    const name = (fileName || '').toLowerCase();

    // 1. Plain text / code / data formats.
    const text = await extractPlainText(buffer, mime, name);
    if (text) return text;

    // 2. Office formats.
    if (name.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return await extractDocx(buffer);
    }
    if (
      name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv') ||
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel'
    ) {
      return await extractXlsx(buffer);
    }
    if (
      name.endsWith('.pptx') ||
      mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
      return await extractPptx(buffer);
    }

    // 3. PDF — try text first, fall back to OCR for image-only scans.
    if (mime === 'application/pdf' || name.endsWith('.pdf')) {
      let pdfText = null;
      try { pdfText = await extractPdfText(buffer); } catch { /* fall through to OCR */ }
      if (pdfText && pdfText.trim().length > 0) return pdfText;
      try { return await extractPdfViaOcr(buffer, buffer); } catch { /* OCR failed — binary only */ }
      return null;
    }
  } catch (e) {
    // Surface the failure to the caller; the LLM will still see the
    // filename via the prefix.
    console.warn('[extractors] failed', fileName, e?.message);
  }
  return null;
}

export async function shutdownExtractors() {
  if (_ocrWorker) {
    try { await _ocrWorker.terminate(); } catch { /* ignore */ }
    _ocrWorker = null;
  }
}