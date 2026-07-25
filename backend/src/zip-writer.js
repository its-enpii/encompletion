/**
 * Tiny ZIP writer (STORED mode, no compression).
 *
 * Writes a valid PKZIP archive where each entry's bytes are passed
 * through verbatim. The output stream can hold any number of files,
 * each named via a relative path; subdirectories are created on the
 * fly (forward slashes per spec).
 *
 * Why not `archiver` / `jszip`? Adding a dep for ~120 lines of code
 * that has no transitive native build is overkill. STORED (no
 * compression) is fine for source code: zipping text is mostly
 * dictionary compression and the savings rarely justify the CPU cost
 * for a UI download that runs once per click. If perf matters later,
 * swap the inner write for `zlib.deflateRaw` + bit-2 flag.
 */

import { Writable } from "node:stream";
import { Buffer } from "node:buffer";

// DOS time/date encoding for the local + central headers. ZIP uses
// local-time fields; we don't need to be exact — 1980-01-01 00:00:00
// is the earliest representable and is read fine by every extractor.
function dosDateTime(date = new Date()) {
  const t =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const d =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time: t >>> 0, date: d >>> 0 };
}

function crc32(buf) {
  // CRC-32 (poly 0xedb88320), precomputed table. Standard for ZIP.
  let c;
  if (!crc32.table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    crc32.table = t;
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Encode a 32-bit unsigned integer little-endian into 4 bytes. Buffer
// is reused via Buffer.allocUnsafe to avoid per-call GC churn when
// streaming many files.
const TMP32 = Buffer.alloc(4);
const TMP16 = Buffer.alloc(2);
function u32(n) {
  TMP32.writeUInt32LE(n >>> 0, 0);
  return TMP32;
}
function u16(n) {
  TMP16.writeUInt16LE(n & 0xffff, 0);
  return TMP16;
}

export class ZipWriter extends Writable {
  constructor(out) {
    super({ objectMode: false });
    this.out = out;
    this.entries = []; // {name, crc, size, offset}
    this.offset = 0;
    this._writing = Promise.resolve();
  }

  _write(chunk, _enc, cb) {
    this._writing = this._writing.then(
      () => new Promise((resolve, reject) => {
        // Pipe directly through to the underlying sink. We don't
        // buffer chunks so very large files don't OOM the server.
        const ok = this.out.write(chunk, (err) => err ? reject(err) : resolve());
        if (ok === false) this.out.once("drain", resolve);
        else resolve();
      })
    ).then(() => cb(), cb);
  }

  _final(cb) {
    // After all file entries + body bytes are written, emit the central
    // directory + EOCD record. Wrapping in the same promise chain keeps
    // ordering safe against interleaved _write() calls.
    this._writing = this._writing.then(() => this._writeCentralAndEocd()).then(
      () => new Promise((resolve) => this.out.end(resolve)),
      (err) => { try { this.out.destroy(err); } catch {} cb(err); }
    );
  }

  /**
   * Add one file to the archive. `name` is the in-zip path; `data` is
   * a Buffer (use Buffer.from(str, "utf8") for text).
   */
  async addFile(name, data) {
    if (!(data instanceof Buffer)) data = Buffer.from(String(data ?? ""), "utf8");
    // Sanitize: ZIP entries use forward slashes, no leading separator,
    // no drive letters. Defensive against bad input from upstream code
    // paths (titles, etc.) so an unwary entry name can't escape the
    // archive root.
    const safeName = String(name)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^[A-Za-z]:\//, "")
      .replace(/\0/g, "");
    const nameBuf = Buffer.from(safeName, "utf8");
    if (nameBuf.length === 0) throw new Error("zip entry name required");
    if (nameBuf.length > 0xffff) throw new Error(`zip entry name too long: ${safeName}`);
    const { time, date } = dosDateTime();
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed to extract
    lfh.writeUInt16LE(0, 6);          // general purpose bit flag
    lfh.writeUInt16LE(0, 8);          // compression method: 0 = stored
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra field length

    const headerOffset = this.offset;
    this.entries.push({
      name: safeName,
      crc, size: data.length, offset: headerOffset,
      time, date, nameBytes: nameBuf,
    });

    // Stream LFH → name → body. _write guarantees ordering through the
    // promise chain.
    await this._writeBuffer(lfh);
    await this._writeBuffer(nameBuf);
    await this._writeBuffer(data);
    this.offset += lfh.length + nameBuf.length + data.length;
  }

  _writeBuffer(buf) {
    return new Promise((resolve, reject) => {
      const ok = this.out.write(buf, (err) => err ? reject(err) : resolve());
      if (ok === false) this.out.once("drain", resolve);
      else resolve();
    });
  }

  async _writeCentralAndEocd() {
    const { time, date } = dosDateTime();
    let cdOffset = this.offset;
    let cdSize = 0;

    for (const e of this.entries) {
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);  // central dir file header signature
      cdh.writeUInt16LE(20, 4);           // version made by
      cdh.writeUInt16LE(20, 6);           // version needed to extract
      cdh.writeUInt16LE(0, 8);            // gp bit flag
      cdh.writeUInt16LE(0, 10);           // compression method
      cdh.writeUInt16LE(time, 12);
      cdh.writeUInt16LE(date, 14);
      cdh.writeUInt32LE(e.crc, 16);
      cdh.writeUInt32LE(e.size, 20);      // compressed
      cdh.writeUInt32LE(e.size, 24);      // uncompressed
      cdh.writeUInt16LE(e.nameBytes.length, 28);
      cdh.writeUInt16LE(0, 30);           // extra field length
      cdh.writeUInt16LE(0, 32);           // comment length
      cdh.writeUInt16LE(0, 34);           // disk number
      cdh.writeUInt16LE(0, 36);           // internal attrs
      cdh.writeUInt32LE(0, 38);           // external attrs
      cdh.writeUInt32LE(e.offset, 42);
      await this._writeBuffer(cdh);
      await this._writeBuffer(e.nameBytes);
      cdSize += cdh.length + e.nameBytes.length;
    }

    // End of central directory record.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);             // disk number
    eocd.writeUInt16LE(0, 6);             // start disk
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);            // comment length
    await this._writeBuffer(eocd);
  }
}
