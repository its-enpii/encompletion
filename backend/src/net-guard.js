/**
 * Shared host/IP guards for outbound HTTP (WebFetch, tool endpoint_url).
 * Blocks loopback, link-local, RFC1918, cloud metadata, and non-http(s).
 */

import net from 'node:net';
import dns from 'node:dns/promises';

export function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const v = ip.trim().toLowerCase();
  if (v === '::1' || v === '0.0.0.0' || v === '::') return true;
  // IPv4-mapped IPv6
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(v)) {
    // fc00::/7 ULA, fe80::/10 link-local, ::1 already handled
    if (v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    if (v === '::1') return true;
    return false;
  }
  return true; // unknown → deny
}

export function isBlockedHostname(host) {
  if (!host || typeof host !== 'string') return true;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (
    h === 'localhost' ||
    h === 'metadata' ||
    h === 'metadata.google.internal' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.intranet')
  ) return true;
  // Literal IP in hostname
  if (net.isIP(h) && isPrivateIp(h)) return true;
  return false;
}

/** Validate URL string: http(s) only, host not obviously private. */
export function assertSafeHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: 'invalid url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${u.protocol}` };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'url userinfo not allowed' };
  }
  if (isBlockedHostname(u.hostname)) {
    return { ok: false, error: 'private / loopback hosts are blocked' };
  }
  if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) {
    return { ok: false, error: 'private / loopback hosts are blocked' };
  }
  return { ok: true, url: u };
}

/** DNS-resolve host and ensure no private A/AAAA. */
export async function assertSafeResolvedHost(hostname) {
  if (isBlockedHostname(hostname)) {
    return { ok: false, error: 'private / loopback hosts are blocked' };
  }
  if (net.isIP(hostname)) {
    return isPrivateIp(hostname)
      ? { ok: false, error: 'private / loopback hosts are blocked' }
      : { ok: true, addresses: [hostname] };
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: 'dns lookup failed' };
  }
  if (!records.length) return { ok: false, error: 'dns lookup empty' };
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      return { ok: false, error: 'host resolves to private address' };
    }
  }
  return { ok: true, addresses: records.map((r) => r.address) };
}
