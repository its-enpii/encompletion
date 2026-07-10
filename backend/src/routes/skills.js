import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectArchiveKind, extractZip, listSkillFiles } from '../skills-archive.js';

const router = express.Router();

// Skill directory convention: <root>/<name>/SKILL.md. Default lives at
// $HOME/.enllm/skills/ so the branch is engine-neutral — earlier this
// reused the Claude CLI path (.claude/skills) but enllm doesn't depend
// on any CLI binary. ENLLM_SKILLS_DIR overrides for tests / external
// installs.
const SKILLS_ROOT =
  process.env.ENLLM_SKILLS_DIR || path.join(os.homedir(), '.enllm', 'skills');

// Reject anything that tries to escape the root via ".." or absolute paths.
function safeName(name) {
  if (typeof name !== 'string') return null;
  // No path separators, no parent refs, no NUL, length 1-100, alnum + - _ .
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

function skillDir(name) {
  return path.join(SKILLS_ROOT, name);
}
function skillFile(name) {
  return path.join(SKILLS_ROOT, name, 'SKILL.md');
}

// Make sure the root exists. We create it on every request that needs it
// because the container may start before any volume is mounted in.
function ensureRoot() {
  try {
    fs.mkdirSync(SKILLS_ROOT, { recursive: true });
  } catch (e) {
    // Permissions / volume issue — surface as 500 to the caller.
    throw new Error(`cannot create skills dir ${SKILLS_ROOT}: ${e.message}`);
  }
}

// List all skills. Each skill = one directory containing SKILL.md.
router.get('/', (_req, res) => {
  try {
    ensureRoot();
    const entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
    const skills = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(SKILLS_ROOT, e.name);
      const md = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      const stat = fs.statSync(md);
      const content = fs.readFileSync(md, 'utf8');
      // Read frontmatter (between first pair of `---`) so the UI can show
      // description without parsing the whole body. Fall back to empty.
      const fm = parseFrontmatter(content);
      // List supporting files (everything in the skill folder except SKILL.md
      // and dotfiles). Recursive so nested folders (e.g. examples/, scripts/)
      // show as relative paths.
      const files = listSkillFiles(dir);
      skills.push({
        name: e.name,
        size: stat.size,
        updated_at: stat.mtime.toISOString(),
        description: fm.description || null,
        frontmatter: fm.raw,
        files,
      });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ root: SKILLS_ROOT, skills });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read a single skill's full content (SKILL.md body + supporting file list).
router.get('/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  try {
    ensureRoot();
    const md = skillFile(name);
    if (!fs.existsSync(md)) return res.status(404).json({ error: 'not found' });
    const content = fs.readFileSync(md, 'utf8');
    const dir = skillDir(name);
    const files = listSkillFiles(dir);
    res.json({ name, content, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a skill directly from a single upload (zip / single text file).
// Body: { dataBase64: string, fileName: string }.
//
// Resolution:
//   - zip -> extract to <root>/<derivedName>/. Skill name from the zip's
//     basename minus extension, sanitised; collisions rejected 409.
//   - .md / .markdown / .txt -> write as SKILL.md inside a new
//     <root>/<derivedName>/ folder. Skill name from the filename
//     basename minus the extension.
//   - rar4/rar5 / other -> 415 with a suggestion to re-pack.
//
// The endpoint exists so a one-shot drop of a downloaded skill
// bundle is enough to create a new skill — the editor flow is for
// refining an existing one, not the only path in.
router.post('/from-upload', async (req, res) => {
  const { dataBase64, fileName } = req.body || {};
  if (typeof dataBase64 !== 'string')
    return res.status(400).json({ error: 'dataBase64 required' });
  if (typeof fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(fileName))
    return res.status(400).json({ error: 'invalid file name' });

  let skillName = '';
  try {
    const safe = require('path').basename(fileName, require('path').extname(fileName));
    const cleaned = safeName(safe);
    if (!cleaned) return res.status(400).json({ error: 'cannot derive a skill name from this filename' });
    skillName = cleaned;

    ensureRoot();
    const target = skillDir(skillName);
    if (fs.existsSync(target))
      return res.status(409).json({ error: 'skill already exists', name: skillName });

    const buf = Buffer.from(dataBase64, 'base64');
    const kind = detectArchiveKindFromBuf(buf);

    if (kind === 'zip') {
      const tmp = require('path').join(require('os').tmpdir(), `skillnew-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
      fs.writeFileSync(tmp, buf);
      try {
        const written = await extractZip(tmp, target);
        // Make sure the extracted archive actually contains a SKILL.md;
        // without one we don't have a usable skill.
        if (!fs.existsSync(skillFile(skillName))) {
          // If SKILL.md landed at a sub-path inside the archive, fall
          // back to the first .md file we can find.
          const found = written.find((p) => p.toLowerCase().endsWith('.md') && !p.toLowerCase().endsWith('skill.md') && !p.toLowerCase().includes('node_modules'));
          if (found) {
            fs.copyFileSync(require('path').join(target, found), skillFile(skillName));
          } else {
            throw new Error('archive contains no SKILL.md');
          }
        }
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } else if (kind === 'rar4' || kind === 'rar5') {
      return res.status(415).json({ error: 'rar not supported — please re-pack as zip', kind });
    } else {
      // Plain text file. SKILL.md is the canonical entrypoint that
      // skill_loader.js reads, so always treat the uploaded text as
      // SKILL.md content regardless of the file's actual extension
      // (we accept .md / .markdown / .txt as a courtesy).
      const ext = require('path').extname(fileName).toLowerCase();
      if (!['.md', '.markdown', '.txt', ''].includes(ext)) {
        return res.status(400).json({ error: 'unsupported file type — upload .md / .zip' });
      }
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(skillFile(skillName), buf);
    }

    // Bootstrap the skill with a sane frontmatter if the extracted
    // file has none — the LLM runner depends on it for description.
    const md = fs.readFileSync(skillFile(skillName), 'utf8');
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(md)) {
      const fm = `---\ndescription: ${skillName}\n---\n\n`;
      fs.writeFileSync(skillFile(skillName), fm + md);
    }
    res.json({ ok: true, name: skillName });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'upload-create failed', name: skillName });
  }
});

// Create a new skill. Body: { name, content, files?: [{name, content}] }.
// We always overwrite SKILL.md (the canonical entrypoint). Supporting files
// are written only if explicitly listed — `content` field is base64 for binary
// safety, but for plain markdown/text we accept UTF-8 strings too.
router.post('/', (req, res) => {
  const { name, content, files = [] } = req.body || {};
  const safe = safeName(name);
  if (!safe) return res.status(400).json({ error: 'invalid name (use letters, digits, . _ -)' });
  if (typeof content !== 'string')
    return res.status(400).json({ error: 'content required' });
  try {
    ensureRoot();
    const dir = skillDir(safe);
    if (fs.existsSync(dir))
      return res.status(409).json({ error: 'skill already exists', name: safe });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(skillFile(safe), content, 'utf8');
    for (const f of files) {
      if (typeof f?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(f.name))
        continue;
      const data =
        typeof f.content === 'string'
          ? Buffer.from(f.content, 'base64')
          : Buffer.from(String(f.content || ''), 'utf8');
      fs.writeFileSync(path.join(dir, f.name), data);
    }
    res.json({ ok: true, name: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update SKILL.md (and optionally supporting files). Use this for "save"
// in the editor. Body: { content, files? }.
router.put('/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  const { content, files } = req.body || {};
  if (typeof content !== 'string')
    return res.status(400).json({ error: 'content required' });
  try {
    ensureRoot();
    const dir = skillDir(name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
    fs.writeFileSync(skillFile(name), content, 'utf8');
    if (Array.isArray(files)) {
      // Replace supporting files wholesale — caller sends the desired final set.
      const existing = fs
        .readdirSync(dir)
        .filter((f) => f !== 'SKILL.md' && !f.startsWith('.'));
      for (const f of existing) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
      for (const f of files) {
        if (typeof f?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(f.name))
          continue;
        if (f.name === 'SKILL.md') continue;
        const data =
          typeof f.content === 'string'
            ? Buffer.from(f.content, 'base64')
            : Buffer.from(String(f.content || ''), 'utf8');
        fs.writeFileSync(path.join(dir, f.name), data);
      }
    }
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a skill (its whole folder).
router.delete('/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  try {
    ensureRoot();
    const dir = skillDir(name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload one supporting file (binary-safe) into a skill folder.
// Body: { dataBase64: string, name?: string }. If `name` matches a .zip or
// .rar extension, we transparently extract into the skill folder instead of
// writing the archive as a single file. Otherwise we write the bytes verbatim
// at the relative path the user provided (basename only — folder escape is
// rejected).
router.post('/:name/files', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  const { dataBase64, name: fileName } = req.body || {};
  if (typeof dataBase64 !== 'string')
    return res.status(400).json({ error: 'dataBase64 required' });
  if (!fileName || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(fileName))
    return res.status(400).json({ error: 'invalid file name' });

  let skillPath;
  try {
    ensureRoot();
    const dir = skillDir(name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'skill not found' });

    const buf = Buffer.from(dataBase64, 'base64');
    const kind = detectArchiveKindFromBuf(buf);

    if (kind === 'zip') {
      // Stream-extract into the skill folder. Reject path traversal.
      // We persist to a temp file first so yauzl can stream-read it.
      const tmp = path.join(os.tmpdir(), `skill-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
      fs.writeFileSync(tmp, buf);
      try {
        const written = await extractZip(tmp, dir);
        // Return the fresh list so the UI updates immediately.
        skillPath = dir;
        const files = listSkillFiles(dir);
        return res.json({
          ok: true,
          extracted: true,
          kind: 'zip',
          count: written.length,
          files,
        });
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }

    if (kind === 'rar4' || kind === 'rar5') {
      return res.status(415).json({
        error: 'rar not supported — please re-pack as zip',
        kind,
      });
    }

    // Plain file path — basename only, no folders (security).
    const basename = path.basename(fileName);
    if (basename !== fileName)
      return res.status(400).json({ error: 'folders not allowed in file name' });
    if (basename === 'SKILL.md')
      return res.status(400).json({ error: 'cannot overwrite SKILL.md via upload' });
    skillPath = path.join(dir, basename);
    fs.writeFileSync(skillPath, buf);
    const files = listSkillFiles(dir);
    return res.json({
      ok: true,
      extracted: false,
      file: { name: basename, size: buf.length },
      files,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'upload failed', path: skillPath });
  }
});

// Delete a supporting file (not SKILL.md).
router.delete('/:name/files/*', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  // Express 5 syntax: req.params[0] is the wildcard. Strip leading slash.
  const sub = req.params[0] || '';
  const target = path.join(skillDir(name), sub);
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'not found' });
  const rel = path.relative(skillDir(name), target);
  if (rel.startsWith('..') || rel.includes('..')) {
    return res.status(400).json({ error: 'invalid path' });
  }
  if (path.basename(target) === 'SKILL.md') {
    return res.status(400).json({ error: 'cannot delete SKILL.md' });
  }
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
      // Clean up empty parent dirs up to skill root.
      let p = path.dirname(target);
      while (p !== skillDir(name)) {
        if (fs.existsSync(p) && fs.readdirSync(p).length === 0) {
          fs.rmdirSync(p);
          p = path.dirname(p);
        } else break;
      }
    }
    res.json({ ok: true, files: listSkillFiles(skillDir(name)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read the contents of a supporting file (binary or text).
router.get('/:name/files/:file', (req, res) => {
  const name = safeName(req.params.name);
  const file = req.params.file;
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(file)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  try {
    const dir = skillDir(name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
    const data = fs.readFileSync(p);
    res.json({
      name: file,
      content_base64: data.toString('base64'),
      size: data.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pull just the YAML frontmatter (between the first pair of `---` lines) and
// return the description field if present, plus the raw text. Frontmatter is
// the metadata header Claude uses to decide when to invoke a skill.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { description: null, raw: null };
  const block = m[1];
  const descMatch = block.match(/^description:\s*(.+?)\s*$/m);
  const nameMatch = block.match(/^name:\s*(.+?)\s*$/m);
  return {
    description: descMatch ? descMatch[1].replace(/^["']|["']$/g, '') : null,
    raw: m[0],
  };
}

// Same magic-byte check as skills-archive.js#detectArchiveKind, but on a
// Buffer we've already loaded from base64 — avoids writing the upload to
// disk just to read its first 8 bytes.
function detectArchiveKindFromBuf(buf) {
  if (buf.length < 4) return 'unknown';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) {
    return 'zip';
  }
  if (
    buf.length >= 7 &&
    buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
    buf[4] === 0x1a && buf[5] === 0x07 && buf[6] === 0x00
  ) {
    return 'rar4';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
    buf[4] === 0x1a && buf[5] === 0x07 && buf[6] === 0x01 && buf[7] === 0x00
  ) {
    return 'rar5';
  }
  return 'unknown';
}

export default router;