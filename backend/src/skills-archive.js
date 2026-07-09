import yauzl from 'yauzl';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// Magic-byte detection so we can give a clear error for rar instead of
// silently producing nothing. ZIPs start with "PK\x03\x04".
export function detectArchiveKind(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) {
      return 'zip';
    }
    // RAR4: 0x52 0x61 0x72 0x21 0x1A 0x07 0x00
    if (
      n >= 7 &&
      buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
      buf[4] === 0x1a && buf[5] === 0x07 && buf[6] === 0x00
    ) {
      return 'rar4';
    }
    // RAR5: 0x52 0x61 0x72 0x21 0x1A 0x07 0x01 0x00
    if (
      n >= 8 &&
      buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
      buf[4] === 0x1a && buf[5] === 0x07 && buf[6] === 0x01 && buf[7] === 0x00
    ) {
      return 'rar5';
    }
    return 'unknown';
  } finally {
    fs.closeSync(fd);
  }
}

// Reject absolute paths and entries that escape the destination. ZIPs from
// untrusted sources are the textbook zip-slip vector.
function safeEntryName(name) {
  if (typeof name !== 'string') return null;
  // Reject path separators at the root, absolute paths, parent refs.
  if (
    name.includes('\\') ||
    name.startsWith('/') ||
    name.includes('\0') ||
    name.includes('..')
  ) {
    return null;
  }
  // Trim any leading "./" segments.
  return name.replace(/^(\.\/)+/, '');
}

function isSafeTarget(destRoot, target) {
  const rel = path.relative(destRoot, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Extract a .zip archive into destDir. Returns a list of written files.
 * @param {string} zipPath
 * @param {string} destDir
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=100*1024*1024] - Per-file size cap (zip-bomb guard).
 * @param {number} [opts.maxFiles=500] - Max entries to extract.
 */
export async function extractZip(zipPath, destDir, opts = {}) {
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 500;
  fs.mkdirSync(destDir, { recursive: true });

  const written = [];
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      let fileCount = 0;
      zipfile.on('entry', (entry) => {
        try {
          if (fileCount >= maxFiles) {
            zipfile.close();
            return reject(new Error(`too many entries (>${maxFiles})`));
          }
          const safeName = safeEntryName(entry.fileName);
          if (!safeName) {
            // Skip unsafe entries silently — they're attackers' payloads.
            zipfile.readEntry();
            return;
          }
          const target = path.join(destDir, safeName);
          if (!isSafeTarget(destDir, target)) {
            zipfile.readEntry();
            return;
          }
          if (/\/$/.test(entry.fileName)) {
            // Directory entry.
            fs.mkdirSync(target, { recursive: true });
            fileCount++;
            zipfile.readEntry();
            return;
          }
          if (entry.uncompressedSize > maxBytes) {
            zipfile.close();
            return reject(
              new Error(`entry ${safeName} too large (${entry.uncompressedSize} bytes)`)
            );
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          zipfile.openReadStream(entry, (rsErr, readStream) => {
            if (rsErr) return reject(rsErr);
            const ws = fs.createWriteStream(target);
            pipeline(readStream, ws).then(
              () => {
                written.push(safeName);
                fileCount++;
                zipfile.readEntry();
              },
              (pipeErr) => {
                try { fs.unlinkSync(target); } catch {}
                reject(pipeErr);
              }
            );
          });
        } catch (e) {
          reject(e);
        }
      });
      zipfile.on('end', () => resolve(written));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

/**
 * Walk a directory and return a flat list of files relative to its root.
 * Excludes SKILL.md (the canonical entrypoint, not a supporting file).
 */
export function listSkillFiles(dir) {
  const out = [];
  function walk(d, prefix) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.isDirectory()) {
        walk(path.join(d, f.name), rel);
      } else if (f.isFile() && f.name !== 'SKILL.md') {
        const st = fs.statSync(path.join(d, f.name));
        out.push({ name: rel, size: st.size });
      }
    }
  }
  try {
    walk(dir, '');
  } catch {}
  return out;
}