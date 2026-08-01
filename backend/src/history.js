const DEFAULT_HISTORY_CHARS = 24_000;

/** Keep the first user turn plus the newest turns within a text budget. */
export function selectHistoryRows(rows, maxChars = DEFAULT_HISTORY_CHARS) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const firstUser = rows.findIndex((row) => row.role === "user");
  const keep = new Set();
  let used = 0;
  if (firstUser >= 0) {
    keep.add(firstUser);
    used += String(rows[firstUser].content || "").length;
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (keep.has(i)) continue;
    const cost = String(rows[i].content || "").length;
    if (used + cost > maxChars) continue;
    keep.add(i);
    used += cost;
  }
  return rows.filter((_, index) => keep.has(index));
}

export const _internals = { DEFAULT_HISTORY_CHARS };
