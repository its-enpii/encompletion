/**
 * document-writer — CreateDocument binaries.
 * XLSX: SheetJS · PDF: PDFKit (structured layout) · PPTX: pptxgenjs
 */

import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';

const MAX_ROWS = 50_000;
const MAX_CELLS = 500_000;
const MAX_PDF_CHARS = 200_000;
const MAX_SLIDES = 40;
const MAX_BULLETS = 40;

/**
 * @param {{ sheets: Array<{ name?: string, rows: any[][] }> }} input
 * @returns {Buffer}
 */
export function buildXlsx({ sheets }) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('sheets array required (at least one sheet with rows)');
  }
  const wb = XLSX.utils.book_new();
  let cellCount = 0;
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i] || {};
    const name = String(s.name || `Sheet${i + 1}`).slice(0, 31) || `Sheet${i + 1}`;
    let rows = Array.isArray(s.rows) ? s.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    for (const r of rows) {
      cellCount += Array.isArray(r) ? r.length : 1;
      if (cellCount > MAX_CELLS) throw new Error(`too many cells (>${MAX_CELLS})`);
    }
    const aoa = rows.map((r) => (Array.isArray(r) ? r.map(cellToPrimitive) : [cellToPrimitive(r)]));
    const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['']]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function cellToPrimitive(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 32_000 ? v.slice(0, 32_000) : v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Map characters that Helvetica (WinAnsi) cannot draw → readable ASCII.
 * Keeps Latin-1 (àé etc.) which Helvetica supports.
 */
function sanitizePdfText(s) {
  return String(s ?? '')
    .replace(/﻿/g, '')
    // dashes / ellipsis / quotes / bullets
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[•‣◦⁃∙]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[​-‍⁠]/g, '')
    // arrows / box drawing leftovers → simple
    .replace(/[←-⇿]/g, '->')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

/**
 * Classify a source line for layout.
 * @returns {{ kind: 'h1'|'h2'|'h3'|'bullet'|'blank'|'p', text: string }}
 */
function classifyLine(raw) {
  const line = String(raw ?? '').replace(/\s+$/g, '');
  if (!line.trim()) return { kind: 'blank', text: '' };
  const t = line.trim();
  // Markdown headings
  let m = t.match(/^(#{1,6})\s+(.+)$/);
  if (m) {
    const level = Math.min(m[1].length, 3);
    return { kind: /** @type {'h1'|'h2'|'h3'} */ (`h${level}`), text: m[2].trim() };
  }
  // Numbered section "1. TITLE" / "1) Title" all-caps-ish
  m = t.match(/^(\d+)[.)]\s+(.+)$/);
  if (m && m[2].length < 80 && !m[2].includes('. ')) {
    return { kind: 'h2', text: `${m[1]}. ${m[2].trim()}` };
  }
  // Bullets
  m = t.match(/^[-*+•]\s+(.+)$/);
  if (m) return { kind: 'bullet', text: m[1].trim() };
  m = t.match(/^\d+[.)]\s+(.+)$/);
  if (m) return { kind: 'bullet', text: m[1].trim() };
  return { kind: 'p', text: t };
}

/**
 * Parse a line array into markdown blocks, detecting GFM tables.
 * Module-scope so buildPdf/buildDocx can call it before their own bodies run.
 * @param {string[]} lines
 * @returns {Array<object>}
 */
function parseTables(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    const headerRow = lines[i];
    const sepRow = lines[i + 1];
    if (!sepRow || !sepRow.includes('|') || !sepRow.includes('-')) { i++; continue; }
    const align = sepRow.match(/:?-+:?/g) || [];
    const cells = headerRow.split('|').map(c => c.trim());
    if (cells.length < 2) { i++; continue; }
    const table = { header: cells.slice(1), align, rows: [] };
    i += 2;
    while (i < lines.length && lines[i].includes('|')) {
      const row = lines[i].split('|').map(c => c.trim());
      if (row.length > 1) table.rows.push(row.slice(1));
      i++;
    }
    blocks.push({ kind: 'table', table });
  }
  return blocks;
}

/**
 * Structured multi-page PDF via PDFKit.
 * @param {{ title?: string, lines?: string[], text?: string }} input
 * @returns {Promise<Buffer>}
 */
export function buildPdf({ title, lines, text } = {}) {
  const heading = sanitizePdfText(String(title || 'Document').slice(0, 120));
  let rawLines = Array.isArray(lines) ? lines.map((l) => String(l ?? '')) : null;
  if (!rawLines) {
    const raw = String(text || '');
    rawLines = (raw.length > MAX_PDF_CHARS ? raw.slice(0, MAX_PDF_CHARS) : raw).split(/\r?\n/);
  }
  const blocks = parseTables(rawLines);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: heading,
        Author: 'Encompletion',
        Creator: 'Encompletion CreateDocument',
      },
      autoFirstPage: true,
    });

    // Tables already parsed at module scope (see parseTables above).
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const left = doc.page.margins.left;
    const right = doc.page.margins.right;
    const contentW = pageW - left - right;

    // Title block
    doc
      .fillColor('#1A1410')
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(heading, { width: contentW, align: 'left' });
    doc.moveDown(0.35);
    doc
      .strokeColor('#E8E5DD')
      .lineWidth(1)
      .moveTo(left, doc.y)
      .lineTo(left + contentW, doc.y)
      .stroke();
    doc.moveDown(0.8);

    for (const b of blocks) {
      const t = sanitizePdfText(b.text);
      ensureSpace(doc, b.kind === 'blank' ? 8 : 28);

      if (b.kind === 'blank') {
        doc.moveDown(0.4);
        continue;
      }
      if (b.kind === 'table') {
        const t = b.table;
        const colCount = t.header.length;
        if (colCount === 0) { i++; continue; } // skip
        const colW = Math.max(80, (contentW - 60) / colCount);
        doc.moveDown(0.2);
        // header
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#2F2E2B');
        t.header.forEach((c, j) => {
          doc.text(c, left + 20 + j * colW, doc.y, { width: colW - 10, align: 'left' });
        });
        doc.moveDown(0.15);
        // separator
        doc.strokeColor('#E8E5DD').lineWidth(0.5);
        doc.moveTo(left + 10, doc.y);
        doc.lineTo(left + contentW, doc.y);
        doc.stroke();
        doc.moveDown(0.1);
        // rows
        doc.font('Helvetica').fontSize(9.5).fillColor('#2F2E2B');
        t.rows.forEach(row => {
          row.forEach((c, j) => {
            const align = t.align[j] === ':---' ? 'left' : t.align[j] === '---:' ? 'right' : 'center';
            doc.text(c, left + 20 + j * colW, doc.y, { width: colW - 10, align });
          });
          doc.moveDown(0.12);
        });
        doc.moveDown(0.25);
        continue;
      }
      if (b.kind === 'h1') {
        doc.moveDown(0.35);
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#1A1410')
          .text(t, { width: contentW, align: 'left' });
        doc.moveDown(0.25);
        continue;
      }
      if (b.kind === 'h2') {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#2F2E2B')
          .text(t, { width: contentW, align: 'left' });
        doc.moveDown(0.2);
        continue;
      }
      if (b.kind === 'h3') {
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#3F3E3B')
          .text(t, { width: contentW, align: 'left' });
        doc.moveDown(0.15);
        continue;
      }
      if (b.kind === 'bullet') {
        const bulletX = left + 8;
        const textX = left + 22;
        const y = doc.y + 3;
        doc.circle(bulletX, y + 3, 1.4).fill('#5A574E');
        doc.font('Helvetica').fontSize(10.5).fillColor('#2F2E2B');
        doc.text(t, textX, doc.y, {
          width: contentW - 22,
          align: 'left',
          lineGap: 2,
        });
        doc.moveDown(0.15);
        continue;
      }
      // paragraph
      doc.font('Helvetica').fontSize(10.5).fillColor('#2F2E2B')
        .text(t, { width: contentW, align: 'left', lineGap: 2.5 });
      doc.moveDown(0.25);
    }

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const label = `${i + 1} / ${range.count}`;
      doc.font('Helvetica').fontSize(8).fillColor('#7A766B')
        .text(label, left, doc.page.height - 40, {
          width: contentW,
          align: 'center',
          lineBreak: false,
        });
    }

    doc.end();
  });
}

function ensureSpace(doc, need) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) doc.addPage();
}

/**
 * Build a PPTX from structured slides.
 * @param {{ title?: string, slides: Array<{ title?: string, bullets?: string[], notes?: string }> }} input
 * @returns {Promise<Buffer>}
 */
export async function buildPptx({ title, slides } = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides array required (at least one slide with title and/or bullets)');
  }
  const list = slides.slice(0, MAX_SLIDES);
  const pptx = new PptxGenJS();
  pptx.author = 'Encompletion';
  pptx.title = String(title || 'Presentation').slice(0, 120);
  pptx.subject = pptx.title;

  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const slide = pptx.addSlide();
    const slideTitle = String(s.title || `Slide ${i + 1}`).slice(0, 200);
    slide.addText(slideTitle, {
      x: 0.5,
      y: 0.35,
      w: 9,
      h: 0.7,
      fontSize: 28,
      bold: true,
      color: '1A1410',
      fontFace: 'Arial',
    });

    let bullets = Array.isArray(s.bullets)
      ? s.bullets.map((b) => String(b ?? '').trim()).filter(Boolean)
      : [];
    if (bullets.length === 0 && typeof s.body === 'string' && s.body.trim()) {
      bullets = s.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    bullets = bullets.slice(0, MAX_BULLETS).map((t) => t.slice(0, 500));

    if (bullets.length > 0) {
      slide.addText(
        bullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
        {
          x: 0.6,
          y: 1.3,
          w: 8.8,
          h: 3.8,
          fontSize: 18,
          color: '2F2E2B',
          fontFace: 'Arial',
          valign: 'top',
        }
      );
    }

    if (typeof s.notes === 'string' && s.notes.trim()) {
      slide.addNotes(s.notes.trim().slice(0, 4000));
    }
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

export function safeDocFileName(name, ext) {
  const base = String(name || 'document')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'document';
  const e = ext.startsWith('.') ? ext : `.${ext}`;
  return base.toLowerCase().endsWith(e.toLowerCase()) ? base : base + e;
}
