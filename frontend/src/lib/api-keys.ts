import { authFetch } from "./auth";

export type ApiKey = {
  id: number;
  name: string;
  model: string;
  last_used_at: string | null;
  created_at: string;
};

export type CreatedApiKey = ApiKey & {
  /** Plaintext — shown only on create, never re-served by the server. */
  plaintext: string;
  prefix: string;
};

export async function listApiKeys(): Promise<ApiKey[]> {
  const r = await authFetch("/api/api-keys");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.keys || [];
}

export async function createApiKey(name: string, model: string): Promise<CreatedApiKey> {
  const r = await authFetch("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, model }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j.error) detail = j.error;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return r.json();
}

export async function deleteApiKey(id: number): Promise<void> {
  const r = await authFetch(`/api/api-keys/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/**
 * Tiny helper to copy a string to clipboard with a fallback for older
 * browsers / non-secure contexts. Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}