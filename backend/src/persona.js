/**
 * persona — turn a tenant's persona_config + tenant_name into the
 * system-prompt supplement that's prepended to every embed prompt.
 *
 * The supplement is a [Tenant Persona] block. The model treats it as
 * ground-truth context (not user content) — the strict <system> tag
 * keeps it pinned at the top so a prompt-injection in the user
 * message can't reorder it.
 *
 * Format is intentionally small. Persona is meant to set the *vibe*,
 * not override the engine's behavior. Tools, file access, and tool
 * gating are enforced by capability_profile, not by persona text.
 *
 * Cached in-process for 60s per tenant so re-issuing many prompts
 * doesn't re-parse JSON. The cache key is tenant_id, so a tenant
 * admin updating persona_config gets the new copy within a minute.
 */

import db from './db/index.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function buildPersonaBlock(persona, tenantName) {
  const lines = [];
  if (persona.name) {
    // Bound the name length so a hostile tenant admin can't inject a
    // multi-paragraph label and blow the context window.
    const safeName = String(persona.name).slice(0, 80);
    lines.push(`You are ${safeName}, an assistant embedded in ${tenantName || 'a client application'}.`);
  } else {
    lines.push(`You are an assistant embedded in ${tenantName || 'a client application'}.`);
  }
  if (persona.tone) {
    lines.push(`Tone: ${String(persona.tone).slice(0, 200)}.`);
  }
  if (persona.avatar_url) {
    // Mentioned so the model can reference it in descriptions, but
    // never injected as a download (no <img>, just a note).
    lines.push(`Avatar: ${String(persona.avatar_url).slice(0, 200)}`);
  }
  if (persona.greeting) {
    lines.push(
      `Optional first-turn greeting style (only if the host has not already greeted and there is no prior conversation): "${String(persona.greeting).slice(0, 240)}". ` +
      `Never re-greet or re-introduce yourself after the conversation has started.`
    );
  }
  if (persona.instructions) {
    lines.push(String(persona.instructions).slice(0, 4000));
  }
  if (persona.do_not) {
    lines.push(`Never: ${String(persona.do_not).slice(0, 1000)}`);
  }
  return `<system>\n${lines.join('\n')}\n</system>`;
}

/**
 * Resolve the cached persona block for a tenant. Returns null when the
 * tenant has no persona_config OR the row is empty.
 */
export function getPersonaBlock(tenantId) {
  if (!tenantId) return null;
  const cached = cache.get(tenantId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.block;
  }
  const row = db
    .prepare(`SELECT persona_config, name FROM tenants WHERE id = ?`)
    .get(tenantId);
  if (!row || !row.persona_config) {
    cache.set(tenantId, { block: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }
  let parsed = null;
  try {
    const p = JSON.parse(row.persona_config);
    if (p && typeof p === 'object') parsed = p;
  } catch { /* corrupt — fall through as null */ }
  const block = parsed ? buildPersonaBlock(parsed, row.name) : null;
  cache.set(tenantId, { block, expiresAt: now + CACHE_TTL_MS });
  return block;
}

/**
 * Drop the persona cache for a tenant — call this from the admin PATCH
 * handler so a tenant edit takes effect immediately rather than
 * waiting up to 60s.
 */
export function invalidatePersonaCache(tenantId) {
  if (tenantId) cache.delete(tenantId);
}

/**
 * Absolute date + clock for the model so relative phrases (yesterday,
 * last week, kemarin, minggu lalu, "sekarang") resolve before tool calls.
 *
 * TZ: explicit arg, else APP_TIMEZONE, EMBED_TIMEZONE, process TZ, else UTC.
 * Date is YYYY-MM-DD; time is 24h HH:mm in that zone.
 */
export function buildTodayContextBlock(now = new Date(), timeZone) {
  const tz = timeZone
    || process.env.APP_TIMEZONE
    || process.env.EMBED_TIMEZONE
    || process.env.TZ
    || 'UTC';
  let iso;
  let weekday;
  let clock;
  try {
    iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now); // en-CA → YYYY-MM-DD
    weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    }).format(now);
    clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now); // HH:mm
  } catch {
    iso = now.toISOString().slice(0, 10);
    weekday = 'unknown';
    clock = now.toISOString().slice(11, 16);
  }
  return [
    '<system>',
    `Current date and time: ${iso} ${clock} (${weekday}, timezone ${tz}).`,
    'When the user says relative dates (yesterday, day before yesterday, last week, last month, kemarin, kemarin lusa, minggu lalu, bulan lalu, etc.), convert them to absolute YYYY-MM-DD yourself before calling any tool.',
    'Tool parameters that are dates must always be YYYY-MM-DD — never relative phrases. Use the clock above for "sekarang" / now / this morning.',
    '</system>',
  ].join('\n');
}

/**
 * Build the full final prompt string for an embed run. Persona block
 * (if any) is pinned at the top in a <system> tag. Caller-supplied
 * system_prompt (if any — sessions.system_prompt override) is appended
 * as a second <system> tag so order is predictable.
 *
 * A fresh "today" context block is always injected so relative-date
 * resolution stays in the LLM, not in tenant tool backends.
 */
export function buildEmbedPrompt({ personaBlock, systemPromptOverride, userPrompt, now, timeZone }) {
  const blocks = [];
  if (personaBlock) blocks.push(personaBlock);
  blocks.push(buildTodayContextBlock(now, timeZone));
  if (systemPromptOverride) {
    blocks.push(`<system>\n${String(systemPromptOverride).slice(0, 8000)}\n</system>`);
  }
  if (blocks.length) {
    return `${blocks.join('\n\n')}\n\n${userPrompt}`;
  }
  return userPrompt;
}

export function _resetCacheForTests() {
  cache.clear();
}

export default { getPersonaBlock, invalidatePersonaCache, buildEmbedPrompt };