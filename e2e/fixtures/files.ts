/**
 * Generate small in-memory fixtures (png, md, py, pdf, docx) for the
 * attachment tests. We write them to a tmp dir so Playwright's
 * setInputFiles can pick them up — and we can reference them across
 * tests without re-generating.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = path.join(os.tmpdir(), 'encompletion-e2e');

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

/** 1x1 transparent PNG. */
export async function pngFile(name = 'pixel.png'): Promise<string> {
  await ensureDir(TMP_ROOT);
  const p = path.join(TMP_ROOT, name);
  // Smallest valid PNG (67 bytes).
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  await fs.writeFile(p, Buffer.from(b64, 'base64'));
  return p;
}

export async function mdFile(name = 'note.md', body?: string): Promise<string> {
  await ensureDir(TMP_ROOT);
  const p = path.join(TMP_ROOT, name);
  await fs.writeFile(
    p,
    body ??
      '# E2E test note\n\nThis is a markdown file used by the playwright suite. Should render with a header and a paragraph.\n\n```ts\nconst answer = 42;\n```\n'
  );
  return p;
}

export async function pyFile(name = 'snippet.py', body?: string): Promise<string> {
  await ensureDir(TMP_ROOT);
  const p = path.join(TMP_ROOT, name);
  await fs.writeFile(
    p,
    body ?? 'def e2e_greet(name: str) -> str:\n    """Greets the named person."""\n    return f"hello, {name}"\n'
  );
  return p;
}

/** A minimal valid PDF (3 pages, plain text "E2E TEST" on each). */
export async function pdfFile(name = 'doc.pdf'): Promise<string> {
  await ensureDir(TMP_ROOT);
  const p = path.join(TMP_ROOT, name);
  // Hand-rolled minimal PDF with one text line. Real pdf-parse reads
  // the streams we generate here, so even this minimal blob works.
  const content = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 56>>stream
BT /F1 24 Tf 100 700 Td (E2E TEST PDF CONTENT) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000010 00000 n
0000000053 00000 n
0000000096 00000 n
0000000170 00000 n
0000000260 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
328
%%EOF
`;
  await fs.writeFile(p, content);
  return p;
}

export async function textFile(name = 'plain.txt', body?: string): Promise<string> {
  await ensureDir(TMP_ROOT);
  const p = path.join(TMP_ROOT, name);
  await fs.writeFile(p, body ?? 'Plain text used by e2e tests.\n');
  return p;
}
