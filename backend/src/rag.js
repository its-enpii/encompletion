/**
 * RAG — semantic search over project knowledge and per-session attachments.
 *
 * Two storage tables:
 *   - embeddings_chunk : vectors + content, indexed by (kind, source_id)
 *   - embeddings_session: maps attachment chunks to the session they were
 *     uploaded in, so we can wipe them on session delete/archive
 *
 * The active embedding dim is captured on the first embed call. If a
 * later embed returns a different dim (e.g. operator swapped providers),
 * we wipe the table and re-index from scratch. No vector ever lands in
 * the table alongside vectors from a different model.
 *
 * Retrieval is naive linear-scan cosine similarity — fine up to ~50k
 * chunks. Add sqlite-vec or a dedicated vector store if that ceiling
 * becomes a problem.
 */

import db from './db/index.js';
import { chunkText } from './chunker.js';
import { embed } from './embedder.js';

const TOPK_DEFAULT = parseInt(process.env.RAG_TOPK || '6', 10);
const SNIPPET_MAX = parseInt(process.env.RAG_SNIPPET_MAX || '600', 10);
const MAX_CHUNKS_PER_SOURCE = 200;

let activeDim = null;
let activeProviderLabel = process.env.EMBED_PROVIDER || 'local';

export function _activeState() {
  return { activeDim, activeProviderLabel };
}

export function _setProviderLabelForTests(label) {
  activeProviderLabel = label;
}

export function _setActiveDimForTests(d) {
  activeDim = d;
}

/**
 * Re-chunk and re-embed a source. Replaces any prior chunks for that
 * (kind, source_id). When `sessionId` is provided, attachment chunks are
 * also bound via embeddings_session so query() can enforce ephemeral
 * scoping.
 */
export async function indexSource({ kind, id, content, sessionId = null }) {
  if (!kind || !id) throw new Error('kind and id are required');
  if (typeof content !== 'string' || content.trim().length === 0) {
    // Nothing to embed — make sure no stale chunks remain.
    removeSource(kind, id);
    return { chunks: 0 };
  }

  const chunks = chunkText(content).slice(0, MAX_CHUNKS_PER_SOURCE);
  if (chunks.length === 0) {
    removeSource(kind, id);
    return { chunks: 0 };
  }

  const { vectors, dim } = await embed(chunks.map((c) => c.content));
  if (dim === 0) return { chunks: 0 };

  enforceDim(dim);

  // Replace in a transaction so a partial failure doesn't leave the
  // table in a half-state.
  const tx = db.transaction(() => {
    const del = db.prepare(
      `DELETE FROM embeddings_chunk WHERE source_kind = ? AND source_id = ?`
    );
    del.run(kind, id);
    const insert = db.prepare(
      `INSERT INTO embeddings_chunk
         (source_kind, source_id, chunk_index, content, vec, dim)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertSession = db.prepare(
      `INSERT INTO embeddings_session (chunk_id, session_id) VALUES (?, ?)`
    );
    for (let i = 0; i < chunks.length; i++) {
      const buf = Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength);
      let info;
      try {
        info = insert.run(kind, id, i, chunks[i].content, buf, dim);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          // Race with another writer for the same (kind, source_id,
          // chunk_index). Re-INSERT by deleting this single row first.
          db.prepare(
            `DELETE FROM embeddings_chunk WHERE source_kind = ? AND source_id = ? AND chunk_index = ?`
          ).run(kind, id, i);
          info = insert.run(kind, id, i, chunks[i].content, buf, dim);
        } else {
          throw e;
        }
      }
      if (sessionId != null && (kind === 'attachment' || kind === 'user_message')) {
        // user_message chunks also get a session link so the recall
        // path can filter out the current session (cross-session only).
        insertSession.run(info.lastInsertRowid, sessionId);
      }
    }
  });
  tx();

  return { chunks: chunks.length };
}

/**
 * Drop all chunks for a single source. Idempotent.
 */
export function removeSource(kind, id) {
  if (!kind || !id) return;
  const tx = db.transaction(() => {
    // SQLite doesn't auto-delete rows in embeddings_session because
    // we used ON DELETE CASCADE only for chunk deletion; we delete the
    // chunks directly so cascade fires.
    db.prepare(`DELETE FROM embeddings_chunk WHERE source_kind = ? AND source_id = ?`)
      .run(kind, id);
  });
  tx();
}

/**
 * Drop every attachment chunk that was uploaded into a specific session.
 * Called from DELETE /api/sessions/:id and the archive path.
 */
export function removeSession(sessionId) {
  if (!sessionId) return;
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM embeddings_chunk
         WHERE id IN (SELECT chunk_id FROM embeddings_session WHERE session_id = ?)
           AND source_kind = 'attachment'`
    ).run(sessionId);
  });
  tx();
}

/**
 * Force the table to a single embedding dim. Wipes existing chunks on
 * dim change so we never end up with mixed-model vectors.
 */
function enforceDim(incomingDim) {
  if (activeDim == null) {
    activeDim = incomingDim;
    return;
  }
  if (activeDim === incomingDim) return;
  const stmt = db.prepare(`SELECT COUNT(*) AS n, MIN(dim) AS minDim, MAX(dim) AS maxDim FROM embeddings_chunk`);
  const r = stmt.get();
  console.warn(
    `[rag] dim_mismatch: wiping ${r?.n || 0} rows ` +
    `(min=${r?.minDim ?? 'null'} max=${r?.maxDim ?? 'null'}) ` +
    `→ ${incomingDim} (provider=${activeProviderLabel}). ` +
    `Sources will need to be re-indexed.`
  );
  db.prepare(`DELETE FROM embeddings_chunk`).run();
  activeDim = incomingDim;
}

/**
 * Top-K cosine-similarity retrieval.
 *
 * scopeUserId: limits to chunks the user can see. project_knowledge rows
 *   are filtered through the projects table; admin bypasses.
 * sessionId (optional): when set, attachment chunks are only returned
 *   if they were uploaded into this session (ephemeral recall).
 */
export async function query(text, { topK = TOPK_DEFAULT, scopeUserId = null, sessionId = null } = {}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return [];
  if (activeDim == null) {
    const { dim } = await embed([text]);
    if (dim === 0) return [];
    enforceDim(dim);
  } else {
    // Still embed the query so we don't run with a stale dim if the
    // operator swapped providers since last call.
    const { dim } = await embed([text]);
    if (dim !== activeDim) enforceDim(dim);
  }
  const { vectors } = await embed([text]);
  const queryVec = vectors[0];
  if (!queryVec) return [];

  // Pull candidate chunks, narrowed by scope at SQL level.
  const rows = loadCandidateChunks({ scopeUserId, sessionId });
  if (rows.length === 0) return [];

  const scored = [];
  for (const row of rows) {
    const v = bytesToFloat32(row.vec);
    const score = cosine(queryVec, v);
    scored.push({
      source_kind: row.source_kind,
      source_id: row.source_id,
      chunk_index: row.chunk_index,
      content: row.content,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => ({
    source_kind: s.source_kind,
    source_id: s.source_id,
    chunk_index: s.chunk_index,
    label: chunkLabel(s),
    content: s.content.length > SNIPPET_MAX ? s.content.slice(0, SNIPPET_MAX) + '…' : s.content,
    score: s.score,
  }));
}

function loadCandidateChunks({ scopeUserId, sessionId }) {
  // Three shapes: project_knowledge, attachment, user_message. Each
  // joined to a different owner table. We accumulate into one array
  // and post-filter for session-exclusion below.
  // Each SELECT includes c.id so the session post-filter can drop rows
  // belonging to the current session (cross-session recall only).
  const out = [];
  if (scopeUserId != null) {
    const admin = isAdmin(scopeUserId);
    if (admin) {
      const r = db.prepare(
        `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.content, c.vec
           FROM embeddings_chunk c
           WHERE c.source_kind = 'project_knowledge'`
      ).all();
      out.push(...r);
    } else {
      const r = db.prepare(
        `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.content, c.vec
           FROM embeddings_chunk c
           JOIN projects p ON p.id = c.source_id
           WHERE c.source_kind = 'project_knowledge'
             AND p.owner_type = 'user' AND p.owner_id = ?
             AND p.archived_at IS NULL`
      ).all(String(scopeUserId));
      out.push(...r);
    }
  } else {
    const r = db.prepare(
      `SELECT id, source_kind, source_id, chunk_index, content, vec
         FROM embeddings_chunk
         WHERE source_kind = 'project_knowledge'`
    ).all();
    out.push(...r);
  }

  // Attachment chunks: ephemeral, scoped to a specific session if asked.
  if (sessionId != null) {
    if (scopeUserId != null && !isAdmin(scopeUserId)) {
      const r = db.prepare(
        `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.content, c.vec
           FROM embeddings_chunk c
           JOIN embeddings_session es ON es.chunk_id = c.id
           JOIN sessions s ON s.id = es.session_id
           WHERE c.source_kind = 'attachment'
             AND es.session_id = ?
             AND s.owner_type = 'user' AND s.owner_id = ?`
      ).all(sessionId, String(scopeUserId));
      out.push(...r);
    } else {
      const r = db.prepare(
        `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.content, c.vec
           FROM embeddings_chunk c
           JOIN embeddings_session es ON es.chunk_id = c.id
           WHERE c.source_kind = 'attachment' AND es.session_id = ?`
      ).all(sessionId);
      out.push(...r);
    }
  }

  // user_message chunks (Phase 3) — past conversation turns indexed
  // by the idle-batch indexer. Cross-session recall: we always load
  // them for the scope user, then post-filter to drop rows from the
  // active session (those are already in `history`). Admin bypasses
  // the per-user filter for debugging.
  if (scopeUserId != null) {
    if (isAdmin(scopeUserId)) {
      const r = db.prepare(
        `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.content, c.vec
           FROM embeddings_chunk c
           WHERE c.source_kind = 'user_message'`
      ).all();
      out.push(...r);
    } else {
      // messages doesn't carry user_id; route through sessions.owner_id
      // (already filtered to owner_type='user'). One extra hop, but the
      // index on embeddings_session(session_id) covers it.
      const r = db.prepare(
        `SELECT c.id, c.source_kind, c.source_id, c.chunk_index, c.content, c.vec
           FROM embeddings_chunk c
           JOIN embeddings_session es ON es.chunk_id = c.id
           JOIN sessions s ON s.id = es.session_id
          WHERE c.source_kind = 'user_message'
            AND s.owner_type = 'user'
            AND s.owner_id = ?
            AND s.user_id = ?`
      ).all(String(scopeUserId), Number(scopeUserId));
      out.push(...r);
    }
  }

  // Session-exclusion post-filter for cross-session recall only.
  // The active session's chunks are already in `opts.history`; surfacing
  // them again would be redundant. The filter is scoped to user_message
  // — attachments KEEP per-session semantics (you upload a file in a
  // session and want to ask about it within that session).
  if (sessionId != null) {
    const curSessionUserMsgChunkIds = db
      .prepare(
        `SELECT es.chunk_id
           FROM embeddings_session es
           JOIN embeddings_chunk c ON c.id = es.chunk_id
          WHERE es.session_id = ? AND c.source_kind = 'user_message'`
      )
      .all(sessionId)
      .map((r) => r.chunk_id);
    const curSet = new Set(curSessionUserMsgChunkIds);
    for (let i = out.length - 1; i >= 0; i--) {
      if (curSet.has(out[i].id)) out.splice(i, 1);
    }
  }

  return out;
}

function isAdmin(userId) {
  const r = db.prepare(`SELECT role FROM users WHERE id = ?`).get(userId);
  return r?.role === 'admin';
}

function chunkLabel(row) {
  if (row.source_kind === 'project_knowledge') {
    return `project_knowledge#${row.source_id}`;
  }
  if (row.source_kind === 'attachment') {
    return `attachment#${row.source_id}`;
  }
  if (row.source_kind === 'user_message') {
    return `past#${row.source_id}`;
  }
  return `${row.source_kind}#${row.source_id}`;
}

function bytesToFloat32(buf) {
  // Stored as a plain Float32Array in little-endian. better-sqlite3 gives
  // us a Node Buffer; we slice into a copy because the underlying buffer
  // is shared with the DB page.
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function _resetForTests() {
  activeDim = null;
}

const rag = {
  indexSource,
  removeSource,
  removeSession,
  query,
  _activeState,
  _setProviderLabelForTests,
  _setActiveDimForTests,
  _resetForTests,
};
export default rag;
