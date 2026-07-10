/**
 * Skill loader for the LLM runner.
 *
 * Mirrors the Claude CLI convention of `~/.claude/skills/<name>/SKILL.md`
 * but instead of letting the CLI auto-inject skill content into the
 * prompt, we expose two tool calls (`Skill.list` + `Skill.read`) so
 * the model can discover the catalog and pull what it needs.
 *
 * That's slower than CLI auto-discovery (extra round-trip per skill
 * load) but explicit, audit-friendly, and the round-trip cost is
 * usually offset by a much smaller system prompt.
 *
 * Read paths are validated via `safeName` so a malicious name string
 * can never escape the skills root.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SKILLS_ROOT =
  process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), ".claude", "skills");

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_SKILL_BYTES = 32 * 1024;

function safeName(name) {
  if (typeof name !== "string") return null;
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) return null;
  return name;
}

function listSkills() {
  try {
    fs.mkdirSync(SKILLS_ROOT, { recursive: true });
  } catch (e) {
    return { root: SKILLS_ROOT, error: e.message, skills: [] };
  }
  let entries;
  try { entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true }); }
  catch { return { root: SKILLS_ROOT, skills: [] }; }
  const skills = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(SKILLS_ROOT, e.name);
    const md = path.join(dir, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    let content;
    try { content = fs.readFileSync(md, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(content);
    skills.push({
      name: e.name,
      description: fm.description || null,
      size: Buffer.byteLength(content, "utf8"),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { root: SKILLS_ROOT, skills };
}

function readSkill(name) {
  const safe = safeName(name);
  if (!safe) return { error: "invalid skill name" };
  const md = path.join(SKILLS_ROOT, safe, "SKILL.md");
  let stat;
  try { stat = fs.statSync(md); } catch { return { error: "skill not found" }; }
  if (!stat.isFile()) return { error: "skill not found" };
  if (stat.size > MAX_SKILL_BYTES) {
    return { error: `skill too large (${stat.size} > ${MAX_SKILL_BYTES} bytes); not loading` };
  }
  let content;
  try { content = fs.readFileSync(md, "utf8"); }
  catch (e) { return { error: e.message }; }
  const fm = parseFrontmatter(content);
  return {
    name: safe,
    description: fm.description || null,
    content: content.slice(0, MAX_SKILL_BYTES),
  };
}

/**
 * Tiny YAML-frontmatter reader. Strictly supports the shape the
 * editor writes — a `---` block at the top of the file, single key:
 * single value per line, optional spaces. Anything fancier (lists,
 * nested keys) is ignored — editors won't write those.
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { raw: null, description: null };
  const body = m[1];
  const lines = body.split(/\r?\n/);
  let description = null;
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "description") description = value;
  }
  return { raw: body, description };
}

export const skillTools = [
  {
    type: "function",
    function: {
      name: "Skill.list",
      description: "List installed skills (name + one-line description). Use this before reading a skill to confirm the catalog.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "Skill.read",
      description: "Read a skill's full instruction file by name. Returns the SKILL.md content. Use after Skill.list when you need the full procedure for a task the description hints at.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill directory name (e.g. deploy-app)." },
        },
        required: ["name"],
      },
    },
  },
];

export async function runSkillTool(name, args) {
  if (name === "Skill.list") return { text: JSON.stringify(listSkills(), null, 2) };
  if (name === "Skill.read") return readSkill(args?.name || "");
  return { error: `unknown skill tool: ${name}` };
}
