/**
 * Memory facts — per-user persistent facts that flow into every system
 * prompt. v1 is manual-only via /api/memory endpoints. Auto-extract via
 * LLM at session end is on the roadmap.
 *
 * Facts are stored in `user_memory_facts` keyed by (user_id, key) with a
 * unique constraint, so updates collapse to a single row instead of
 * accumulating duplicates. The render function emits a bullet list inside
 * a <system> tag so the model treats the block as ground-truth user
 * context.
 */

import db from './db/index.js';

const FACT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const MAX_VALUE_LEN = 2000;
const MAX_FACTS_PER_USER = 100;

export function listFacts(userId) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT id, user_id, key, value, source, created_at, updated_at
         FROM user_memory_facts
        WHERE user_id = ?
        ORDER BY key ASC`
    )
    .all(userId);
}

export function upsertFact(userId, key, value, source = "manual") {
  if (!userId) throw new Error('user_id required');
  if (!FACT_KEY_RE.test(key || '')) {
    throw new Error(
      'key must be alphanumeric (letters, digits, underscore, dash; ≤ 40 chars; must start with letter)'
    );
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LEN) {
    throw new Error(`value must be 1..${MAX_VALUE_LEN} chars`);
  }
  // source: only the two whitelisted values reach the DB. Default is manual
  // so callers that don't care (the /api/memory/facts/:key PUT route) keep
  // existing behavior.
  const safeSource = source === "auto" ? "auto" : "manual";
  const trimmed = value.trim();

  // Limit per-user fact count to prevent runaway storage. The check
  // happens before insert only; updates are exempt since they replace
  // an existing row, not add a new one.
  const existing = db
    .prepare(`SELECT id FROM user_memory_facts WHERE user_id = ? AND key = ?`)
    .get(userId, key);
  if (!existing) {
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM user_memory_facts WHERE user_id = ?`)
      .get(userId).n;
    if (count >= MAX_FACTS_PER_USER) {
      throw new Error(`max ${MAX_FACTS_PER_USER} facts per user`);
    }
  }

  if (existing) {
    // On update we preserve the row's existing source — manual edits to
    // a fact that was originally auto-extracted keep the [auto] badge
    // accurate. To "promote" a fact from auto to manual the user must
    // delete and recreate, which is intentional (the audit story for
    // auto-memory is "the model learned this", not "the user typed it").
    db.prepare(
      `UPDATE user_memory_facts
          SET value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(trimmed, existing.id);
    return db.prepare(`SELECT * FROM user_memory_facts WHERE id = ?`).get(existing.id);
  }
  const info = db
    .prepare(
      `INSERT INTO user_memory_facts (user_id, key, value, source) VALUES (?, ?, ?, ?)`
    )
    .run(userId, key, trimmed, safeSource);
  return db
    .prepare(`SELECT * FROM user_memory_facts WHERE id = ?`)
    .get(info.lastInsertRowid);
}

export function deleteFact(userId, id) {
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = db
    .prepare(`DELETE FROM user_memory_facts WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return r.changes > 0;
}

/**
 * Render the user's facts as a <system>-tagged block for injection
 * into the model context. Returns empty string when the user has no
 * facts — caller decides whether to skip the <system> wrapper.
 *
 * Format: a bullet list keyed by fact.key so the model can reference
 * facts in conversation by name (e.g. user asks "apa preferensiku?"
 * and the model reads "lokasi: jakarta"). Each value is newline-
 * collapsed and capped at 240 chars to keep the block bounded.
 */
export function renderMemoryFactsBlock(userId) {
  const facts = listFacts(userId);
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const safeValue = String(f.value).replace(/\n+/g, ' ').slice(0, 240);
    return `- ${f.key}: ${safeValue}`;
  });
  return `<system>\nUser facts (persistent across all sessions):\n${lines.join(
    '\n'
  )}\n</system>`;
}

export const _internals = { FACT_KEY_RE, MAX_VALUE_LEN, MAX_FACTS_PER_USER };