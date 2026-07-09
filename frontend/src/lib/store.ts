/**
 * Thin localStorage helper that prefixes storage keys (avoids leaking the
 * engine brand name into DevTools' storage panel) and reads legacy keys
 * once for backwards compatibility with already-deployed sessions.
 *
 * Each setter reads BOTH the new and legacy keys, prefers the new value,
 * and migrates by writing the new key + deleting the legacy key on next
 * persist. Quiet `catch {}` blocks mirror the surrounding pattern — local
 * storage can be blocked (privacy mode, file:// origins, etc.) and the
 * UI should never break because of it.
 */

const PREFIX = "app:";

const LEGACY: Record<string, string> = {
  "app:model": "claude-web:model",
  "app:effort": "claude-web:effort",
  "app:artifacts:open": "claude-web:artifacts:open",
  "app:token": "claude-web-token",
};

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* best-effort */
  }
}

function deleteRaw(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}

export function getStored(name: string): string | null {
  const newKey = PREFIX + name;
  const v = readRaw(newKey);
  if (v !== null) return v;
  const legacyKey = LEGACY[newKey];
  if (legacyKey && legacyKey !== newKey) {
    const legacy = readRaw(legacyKey);
    if (legacy !== null) {
      // One-shot migration: copy forward so next reads hit the new key.
      writeRaw(newKey, legacy);
      deleteRaw(legacyKey);
      return legacy;
    }
  }
  return null;
}

export function setStored(name: string, value: string): void {
  const newKey = PREFIX + name;
  writeRaw(newKey, value);
  // Once the new key is written, scrub the legacy one so DevTools only
  // surfaces the new prefix going forward.
  const legacyKey = LEGACY[newKey];
  if (legacyKey) deleteRaw(legacyKey);
}

/**
 * Erase a key from both new and legacy namespaces. Useful for logout.
 */
export function clearStored(name: string): void {
  const newKey = PREFIX + name;
  deleteRaw(newKey);
  const legacyKey = LEGACY[newKey];
  if (legacyKey) deleteRaw(legacyKey);
}
