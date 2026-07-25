/**
 * Project memory facts — per-project persistent facts injected as a
 * <system> block into every chat whose session belongs to the
 * project. Mirrors user_memory_facts (Phase 1) but scoped to
 * projects.id instead of users.id.
 *
 * Reuses FACT_KEY_RE + MAX_VALUE_LEN so a fact written here has
 * the same key/value constraints as a user fact. MAX_FACTS_PER_PROJECT
 * caps the project surface the same way MAX_FACTS_PER_USER caps the
 * user surface.
 *
 * Why this exists alongside projects.instructions: instructions is
 * free-form prose inlined into the user prompt per-turn by
 * buildFinalPrompt (runs.js) — wrong shape for structured facts.
 * project_memory_facts is the canonical place for key/value truth
 * the model needs across all sessions in a project.
 */

import db from './db/index.js';

const FACT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const MAX_VALUE_LEN = 2000;
const MAX_FACTS_PER_PROJECT = 100;

export function listProjectFacts(projectId) {
  if (!projectId) return [];
  return db
    .prepare(
      `SELECT id, project_id, key, value, source, created_at, updated_at
         FROM project_memory_facts
        WHERE project_id = ?
        ORDER BY key ASC`
    )
    .all(projectId);
}

export function upsertProjectFact(projectId, key, value, source = 'manual') {
  if (!projectId) throw new Error('project_id required');
  if (!FACT_KEY_RE.test(key || '')) {
    throw new Error(
      'key must be alphanumeric (letters, digits, underscore, dash; ≤ 40 chars; must start with letter)'
    );
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LEN) {
    throw new Error(`value must be 1..${MAX_VALUE_LEN} chars`);
  }
  // source: only the two whitelisted values reach the DB. Default is
  // manual so callers that don't care keep existing behavior. Phase 6
  // will pass source='auto' from the extractor.
  const safeSource = source === 'auto' ? 'auto' : 'manual';
  const trimmed = value.trim();

  // Limit per-project fact count to prevent runaway storage. The
  // check happens before insert only; updates are exempt since they
  // replace an existing row, not add a new one.
  const existing = db
    .prepare(`SELECT id FROM project_memory_facts WHERE project_id = ? AND key = ?`)
    .get(projectId, key);
  if (!existing) {
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM project_memory_facts WHERE project_id = ?`)
      .get(projectId).n;
    if (count >= MAX_FACTS_PER_PROJECT) {
      throw new Error(`max ${MAX_FACTS_PER_PROJECT} facts per project`);
    }
  }

  if (existing) {
    // On update we preserve the row's existing source — same rationale
    // as user_memory_facts (manual edit of an auto-extracted fact
    // should keep the [auto] badge accurate).
    db.prepare(
      `UPDATE project_memory_facts
          SET value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(trimmed, existing.id);
    return db.prepare(`SELECT * FROM project_memory_facts WHERE id = ?`).get(existing.id);
  }
  const info = db
    .prepare(
      `INSERT INTO project_memory_facts (project_id, key, value, source) VALUES (?, ?, ?, ?)`
    )
    .run(projectId, key, trimmed, safeSource);
  return db.prepare(`SELECT * FROM project_memory_facts WHERE id = ?`).get(info.lastInsertRowid);
}

export function deleteProjectFact(projectId, id) {
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = db
    .prepare(`DELETE FROM project_memory_facts WHERE id = ? AND project_id = ?`)
    .run(id, projectId);
  return r.changes > 0;
}

/**
 * Render the project's facts as a <system>-tagged block for injection
 * into the model context. Returns empty string when the project has
 * no facts — caller decides whether to skip the <system> wrapper.
 *
 * Format mirrors renderMemoryFactsBlock so the model sees one
 * consistent shape for "user facts" and "project facts" — a bullet
 * list keyed by fact.key. Each value is newline-collapsed and capped
 * at 240 chars to keep the block bounded.
 */
export function renderProjectMemoryFactsBlock(projectId) {
  const facts = listProjectFacts(projectId);
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const safeValue = String(f.value).replace(/\n+/g, ' ').slice(0, 240);
    return `- ${f.key}: ${safeValue}`;
  });
  return `<system>\nProject facts (persistent across all sessions in this project):\n${lines.join(
    '\n'
  )}\n</system>`;
}

export const _internals = { FACT_KEY_RE, MAX_VALUE_LEN, MAX_FACTS_PER_PROJECT };