/**
 * Seed built-in skills into ENLLM_SKILLS_DIR if missing.
 * Volume mounts often start empty and hide image-baked skills/, so
 * we copy from backend/skills (repo defaults) on boot — never overwrite.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.resolve(__dirname, '../skills');
const TARGET =
  process.env.ENLLM_SKILLS_DIR || path.join(os.homedir(), '.enllm', 'skills');

function copyDirIfMissing(src, dest) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(path.join(dest, 'SKILL.md'))) return false;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDirIfMissing(from, to);
    } else if (ent.isFile()) {
      if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  }
  return true;
}

export function seedBuiltinSkills() {
  if (!fs.existsSync(BUNDLED)) return { seeded: [], target: TARGET };
  fs.mkdirSync(TARGET, { recursive: true });
  const seeded = [];
  for (const ent of fs.readdirSync(BUNDLED, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const src = path.join(BUNDLED, ent.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const dest = path.join(TARGET, ent.name);
    if (copyDirIfMissing(src, dest)) seeded.push(ent.name);
  }
  return { seeded, target: TARGET };
}

export default { seedBuiltinSkills };
