/**
 * Embedder — pluggable provider for text vectorization.
 *
 * `EMBED_PROVIDER` env:
 *   - "local"  (default) → @xenova/transformers MiniLM-L6-v2, 384 dims
 *   - "remote" → POST ${LLM_BASE_URL}/embeddings, dim comes from server
 *   - "fake"   → stub vectors for tests, dim configurable via EMBED_FAKE_DIM
 *
 * The module caches:
 *   - resolved provider function (so we only init once)
 *   - sha256-keyed LRU of recent text → vector (per process, in-memory)
 *
 * Output vector layout: plain Float32Array (little-endian on all
 * supported platforms). Persisted as BLOB.
 */

import crypto from 'node:crypto';

const PROVIDER = (process.env.EMBED_PROVIDER || 'local').toLowerCase();
const FAKE_DIM = parseInt(process.env.EMBED_FAKE_DIM || '384', 10);
const CACHE_LIMIT = 500;

let _provider = null;
let _cachedDim = null;

const lru = new Map();

function cacheGet(key) {
  if (!lru.has(key)) return null;
  const v = lru.get(key);
  // Refresh recency by re-inserting
  lru.delete(key);
  lru.set(key, v);
  return v;
}

function cachePut(key, value) {
  if (lru.has(key)) lru.delete(key);
  lru.set(key, value);
  if (lru.size > CACHE_LIMIT) {
    const oldest = lru.keys().next().value;
    lru.delete(oldest);
  }
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Resolve and memoize the embedder function. Returns a function that
 * accepts an array of strings and returns an array of Float32Arrays.
 */
async function getProvider() {
  if (_provider) return _provider;
  if (PROVIDER === 'local') {
    _provider = await loadLocalProvider();
  } else if (PROVIDER === 'remote') {
    _provider = loadRemoteProvider();
  } else if (PROVIDER === 'fake') {
    _provider = loadFakeProvider(FAKE_DIM);
  } else {
    throw new Error(`unknown EMBED_PROVIDER: ${PROVIDER}`);
  }
  return _provider;
}

async function loadLocalProvider() {
  // Lazy import — the transformers package is ~1MB and we don't want to
  // pay the load cost on boot unless local embedding is actually used.
  // If the package is missing (e.g. test env without it installed),
  // fall back to remote so the rest of the app still works.
  let transformers;
  try {
    transformers = await import('@xenova/transformers');
  } catch (e) {
    console.warn('[embedder] @xenova/transformers missing — falling back to remote');
    return loadRemoteProvider();
  }

  // Cache models under storage so subsequent restarts don't re-download.
  if (process.env.TRANSFORMERS_CACHE) {
    transformers.env.cacheDir = process.env.TRANSFORMERS_CACHE;
  }
  // Silent mode — we don't want progress bars in container stderr.
  transformers.env.allowLocalModels = false;
  transformers.env.useBrowserCache = false;

  let pipeline;
  try {
    pipeline = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  } catch (e) {
    // Model unreachable (no internet, HF blocked) — drop to remote.
    console.warn(`[embedder] local model load failed (${e?.message || e}) — falling back to remote`);
    return loadRemoteProvider();
  }

  const expectedDim = 384; // MiniLM-L6-v2
  return async function localEmbed(texts) {
    const out = [];
    for (const text of texts) {
      const r = await pipeline(text, { pooling: 'mean', normalize: true });
      out.push(new Float32Array(r.data));
      if (out[out.length - 1].length !== expectedDim) {
        throw new Error(`embedder dim mismatch: expected ${expectedDim} got ${out[out.length - 1].length}`);
      }
    }
    return out;
  };
}

function loadRemoteProvider() {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.EMBED_REMOTE_MODEL || 'text-embedding-3-small';
  return async function remoteEmbed(texts) {
    const r = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`embeddings HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = await r.json();
    if (!Array.isArray(json?.data)) throw new Error('embeddings: missing data array');
    return json.data.map((d) => new Float32Array(d.embedding));
  };
}

function loadFakeProvider(dim) {
  // Bag-of-words hashing so semantically-similar texts land near each
  // other in cosine space. We hash each whitespace-separated token into
  // a fixed bucket (signed feature), accumulate, and L2-normalize. Two
  // texts that share many tokens produce near-identical vectors; texts
  // with no shared tokens sit close to orthogonal. Good enough to drive
  // a RAG round-trip test.
  return async function fakeEmbed(texts) {
    return texts.map((text) => {
      const arr = new Float32Array(dim);
      const tokens = String(text).toLowerCase().split(/\W+/).filter(Boolean);
      if (tokens.length === 0) return arr;
      for (const tok of tokens) {
        const h = crypto.createHash('sha256').update(tok).digest();
        const bucket = (h[0] << 8) | h[1];
        const idx = bucket % dim;
        const sign = (h[2] & 1) ? 1 : -1;
        arr[idx] += sign;
      }
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) arr[i] /= norm;
      return arr;
    });
  };
}

/**
 * Embed a batch of strings. Returns { vectors: Float32Array[], dim }.
 * Vectors are deduplicated via an LRU; identical texts share a row.
 */
export async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], dim: _cachedDim || 0 };
  }
  const provider = await getProvider();
  const keys = texts.map(hashText);
  const missingIdx = [];
  const missingTexts = [];
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    const cached = cacheGet(keys[i]);
    if (cached) out[i] = cached;
    else { missingIdx.push(i); missingTexts.push(texts[i]); }
  }
  if (missingTexts.length > 0) {
    const fresh = await provider(missingTexts);
    for (let j = 0; j < fresh.length; j++) {
      out[missingIdx[j]] = fresh[j];
      cachePut(keys[missingIdx[j]], fresh[j]);
    }
  }
  const dim = out[0]?.length || 0;
  _cachedDim = dim;
  return { vectors: out, dim };
}

/** Reset internal state — tests only. */
export function _resetForTests() {
  _provider = null;
  _cachedDim = null;
  lru.clear();
}

export function _activeDim() {
  return _cachedDim;
}
