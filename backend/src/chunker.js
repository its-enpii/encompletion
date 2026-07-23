/**
 * Text chunking for RAG.
 *
 * chunkText(text, {size=500, overlap=50, snapToParagraph=true})
 *   → [{ start, end, content }]
 *
 * Strategy: windowed char-based chunking with paragraph snap. We avoid
 * token-based splitting here so the chunker stays deterministic without
 * pulling in a tokenizer; embedding models tokenize internally and the
 * difference between 500 chars and ~120 tokens is small enough not to
 * matter for retrieval recall.
 */

const DEFAULT_SIZE = 500;
const DEFAULT_OVERLAP = 50;
const PARAGRAPH_SNAP = 80;

function chunkText(text, opts = {}) {
  const size = Math.max(64, opts.size || DEFAULT_SIZE);
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP, size - 1));
  const snapToParagraph = opts.snapToParagraph !== false;
  if (typeof text !== "string" || text.length === 0) return [];
  if (text.length <= size) {
    return [{ start: 0, end: text.length, content: text }];
  }

  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + size);
    if (snapToParagraph && end < text.length) {
      // Try to back off to the nearest paragraph break within the last
      // PARAGRAPH_SNAP chars so we don't split mid-sentence.
      const windowStart = Math.max(cursor + 1, end - PARAGRAPH_SNAP);
      const slice = text.slice(windowStart, end);
      const paraBreak = slice.lastIndexOf("\n\n");
      if (paraBreak > 0) end = windowStart + paraBreak;
    }
    const content = text.slice(cursor, end);
    chunks.push({ start: cursor, end, content });
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

export { chunkText };
