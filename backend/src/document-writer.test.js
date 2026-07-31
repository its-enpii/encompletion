/**
 * document-writer smoke tests.
 * Run: node --test src/document-writer.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, buildPdf, buildPptx, safeDocFileName } from './document-writer.js';
import * as XLSX from 'xlsx';
import { extractText } from './extractors.js';

test('buildXlsx produces readable workbook', () => {
  const buf = buildXlsx({
    sheets: [
      { name: 'Sales', rows: [['Name', 'Qty'], ['A', 1], ['B', 2]] },
      { name: 'Notes', rows: [['hello']] },
    ],
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100);
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Sales', 'Notes']);
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets.Sales);
  assert.match(csv, /Name,Qty/);
  assert.match(csv, /A,1/);
});

test('buildXlsx rejects empty sheets', () => {
  assert.throws(() => buildXlsx({ sheets: [] }), /sheets/);
});

test('buildPdf starts with %PDF and ends with %%EOF', async () => {
  const buf = await buildPdf({
    title: 'Report',
    lines: ['Line one', 'Line two', 'Halo dunia'],
  });
  assert.ok(Buffer.isBuffer(buf));
  const s = buf.toString('binary');
  assert.ok(s.startsWith('%PDF'));
  assert.ok(s.includes('%%EOF'));
  // PDFKit may compress streams — just ensure non-trivial size + title path works.
  assert.ok(buf.length > 400);
});

test('buildPdf wraps long text into pages', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `row ${i} lorem ipsum dolor sit amet`);
  const buf = await buildPdf({ title: 'Long', lines });
  assert.ok(buf.length > 500);
  const s = buf.toString('binary');
  assert.ok(s.startsWith('%PDF'));
});

test('buildPptx produces zip PK header and round-trips via extractPptx', async () => {
  const buf = await buildPptx({
    title: 'Demo Deck',
    slides: [
      { title: 'Welcome', bullets: ['Point A', 'Point B'] },
      { title: 'Next steps', bullets: ['Ship it'], notes: 'Speaker note' },
    ],
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000);
  assert.equal(buf[0], 0x50); // P
  assert.equal(buf[1], 0x4b); // K
  const text = await extractText({
    buffer: buf,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    fileName: 'demo.pptx',
  });
  assert.ok(text, 'extractPptx returned text');
  assert.match(text, /Welcome/);
  assert.match(text, /Point A/);
  assert.match(text, /Next steps/);
});

test('buildPptx rejects empty slides', async () => {
  await assert.rejects(() => buildPptx({ slides: [] }), /slides/);
});

test('safeDocFileName sanitizes and adds ext', () => {
  assert.equal(safeDocFileName('My Report!!', 'xlsx'), 'My_Report.xlsx');
  assert.equal(safeDocFileName('a.xlsx', 'xlsx'), 'a.xlsx');
  assert.equal(safeDocFileName('../etc/passwd', 'pdf'), '.._etc_passwd.pdf');
  assert.equal(safeDocFileName('Deck', 'pptx'), 'Deck.pptx');
});
