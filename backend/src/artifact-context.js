import db from "./db/index.js";

export function formatArtifactManifest(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const items = rows.map((row) => {
    const lines = row.content ? String(row.content).split("\\n").length : 0;
    return `- #${row.id} ${row.title || "Artifact"}${row.version > 1 ? ` v${row.version}` : ""} (${row.type}${row.language ? `/${row.language}` : ""}, ${lines} lines${row.file_size ? `, ${row.file_size} bytes` : ""})`;
  });
  return `<system>\\n[Artifacts in this session]\\n${items.join("\\n")}\\nUse ReadArtifact with an ID when you need the exact content.\\n</system>`;
}

export function renderArtifactManifestBlock(sessionId) {
  if (!sessionId) return "";
  const rows = db.prepare(`
    SELECT id, type, language, title, version, content, file_size
      FROM artifacts a
     WHERE session_id = ? AND (dup_of IS NULL OR dup_of = 0)
       AND NOT EXISTS (
         SELECT 1 FROM artifacts newer
          WHERE newer.session_id = a.session_id
            AND LOWER(COALESCE(newer.title, '')) = LOWER(COALESCE(a.title, ''))
            AND (newer.dup_of IS NULL OR newer.dup_of = 0)
            AND (newer.version > a.version OR (newer.version = a.version AND newer.id > a.id))
       )
     ORDER BY id DESC LIMIT 12
  `).all(sessionId);
  if (!rows.length) return "";
  return formatArtifactManifest(rows.reverse());
}

export function readArtifactForSession(id, sessionId, userId) {
  if (!id || !sessionId || !userId) return null;
  return db.prepare(`
    SELECT a.id, a.type, a.title, a.language, a.content, a.file_size
      FROM artifacts a JOIN sessions s ON s.id = a.session_id
     WHERE a.id = ? AND a.session_id = ?
       AND (s.user_id = ? OR ? = 'admin')
  `).get(id, sessionId, userId, userId);
}
