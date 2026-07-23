/**
 * Detect artifacts from Claude's text response.
 *
 * Strict gate: only emit artifacts that LOOK intentional. A fenced code block
 * dropped mid-paragraph (e.g. Claude illustrating one line of syntax) is NOT
 * an artifact — the panel would get spammy. Only blocks that:
 *   - sit on their own line (not inline)
 *   - are >= 80 chars
 *   - have an "introduction phrase" in the surrounding text
 *     (e.g. "berikut", "here is", "buatkan", "tulis", "file", "panduan")
 *   - have a parseable title (first line looks like a comment header)
 *
 * Returns array of { type, language, title, content, content_hash, line_count }.
 * Sorted by length desc so the longest, highest-signal blocks float up.
 */
import crypto from 'node:crypto';

const FENCE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
const MIN_CONTENT_CHARS = 80;

// Phrases that signal "Claude is intentionally presenting code as an output".
// Match against a 200-char window immediately before the opening fence.
// Supports English + Bahasa Indonesia prompts.
const INTENT_PHRASES = [
  // EN
  /\bhere('?| i)s\b/i,
  /\bthe following\b/i,
  /\bbelow is\b/i,
  /\bsee (below|this|the)\b/i,
  /\b(create|generate|write|build|make|implement|add|update|modify|edit|refactor)\b/i,
  /\b(?:a |the )?(file|script|component|module|class|function|endpoint|template|layout|page|app|component|seeder|migration|test|spec|config|configuration|README|readme|document|doc|guide|tutorial|panduan|tutorial|dokumentasi)\b/i,
  // ID
  /\b(berikut|ini|berikutnya|silakan|buat(?:kan)?|tulis(?:kan)?|bikin(?:in)?|tambahkan|perbarui|update|ubah|edit|refaktor)\b/i,
  /\b(file|skrip|kelas|fungsi|halaman|template|komponen|konfigurasi|panduan|dokumentasi|contoh)\b/i,
];

function inferType(lang) {
  const l = (lang || '').toLowerCase().trim();
  if (l === 'html' || l === 'htm') return 'html';
  if (l === 'jsx' || l === 'react' || l === 'tsx') return 'react';
  if (l === 'svg') return 'svg';
  if (l === 'md' || l === 'markdown') return 'markdown';
  if (l === 'csv' || l === 'tsv') return 'csv';
  return 'code';
}

export { inferType as inferArtifactType };

function hashOf(type, content) {
  return crypto.createHash('sha256').update(`${type}|${content}`).digest('hex').slice(0, 16);
}

export { hashOf as hashArtifact };

function firstLineTitle(content) {
  const first = content.split('\n', 1)[0].trim();
  // Markdown heading (# …, ## …)
  const h = first.match(/^#{1,6}\s+(.+?)$/);
  if (h && h[1].length < 80) return h[1].slice(0, 80);
  // Common comment prefixes
  const m = first.match(/^(?:\/\/|#|--|<!--)\s*(.+?)(?:\s*-->)?$/);
  if (m && m[1].length < 80) return m[1].slice(0, 80);
  return first.slice(0, 80);
}

/**
 * Verdict on whether a fenced block should be saved as an artifact.
 * Returns { keep, reason } so caller can log/surface.
 *
 * `blockStart` is the absolute index of the opening fence in the source text.
 */
function evaluate(blockStart, lang, content, prevText) {
  if (!content.trim()) return { keep: false, reason: 'empty' };
  if (content.length < MIN_CONTENT_CHARS) return { keep: false, reason: 'too_short' };

  // The block must be on its own line — opening fence at start-of-line with
  // only whitespace before it. This rejects inline ```...``` and Claude
  // illustrating a tiny syntax example inside a paragraph.
  const lineStart = prevText.lastIndexOf('\n', blockStart) + 1;
  const prefix = prevText.slice(lineStart, blockStart);
  if (prefix.trim() !== '') return { keep: false, reason: 'inline' };

  const type = inferType(lang);

  // Renderable types (html, react, svg, markdown) almost always
  // represent a substantive output the user wants — drop the phrase
  // gate so casual prose like "here's a small login form" still
  // surfaces the artifact. `code` keeps the stricter check below
  // because it's the type most likely to appear as illustrative
  // snippets in explanations.
  if (type !== 'code') {
    return { keep: true, reason: 'ok' };
  }

  // For 'code' type, require an explicit signal that this is a
  // standalone artifact: an intent phrase in the preceding text OR
  // a header-looking first line. Either is enough — Claude either
  // introduced the block ("here's a config…") or commented it as a
  // titled snippet (`// api.js`).
  const window = prevText.slice(Math.max(0, blockStart - 200), blockStart);
  const phraseHit = INTENT_PHRASES.some((rx) => rx.test(window));
  const titleLine = content.split('\n', 1)[0].trim();
  const looksLikeHeader = (
    /^#{1,6}\s+\S/.test(titleLine) ||
    /^(?:\/\/|#|--|<!--)\s*\S/.test(titleLine)
  );
  if (!phraseHit && !looksLikeHeader) {
    return { keep: false, reason: 'no_intent_signal' };
  }

  return { keep: true, reason: 'ok' };
}

export function detectArtifacts(text) {
  if (!text) return [];
  const out = [];
  let m;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text)) !== null) {
    const lang = m[1] || '';
    const content = m[2].replace(/\n$/, '');
    const start = m.index;
    const prevText = text.slice(0, start);
    const verdict = evaluate(start, lang, content, prevText);
    if (!verdict.keep) continue;
    const type = inferType(lang);
    out.push({
      type,
      language: lang || null,
      title: firstLineTitle(content) || (lang ? `${lang} snippet` : 'Artifact'),
      content,
      content_hash: hashOf(type, content),
      line_count: content.split('\n').length,
    });
  }
  out.sort((a, b) => b.content.length - a.content.length);
  return out;
}

// Helper for debug / tests — exposes the gate so server can attach rejection
// reasons to info banners.
export function evaluateArtifact(text) {
  if (!text) return [];
  const all = [];
  let m;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text)) !== null) {
    const lang = m[1] || '';
    const content = m[2].replace(/\n$/, '');
    const start = m.index;
    const prevText = text.slice(0, start);
    const v = evaluate(start, lang, content, prevText);
    all.push({ lang, content, verdict: v });
  }
  return all;
}