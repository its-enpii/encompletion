// Test harness: simulates what the frontend does, but via plain HTTP.
// POST /api/sessions/:id/runs → opens the SSE stream with curl-like
// framing → prints every event until 'done' → exits.
//
// Usage: TOKEN=... SID=... node audit-sse.mjs
//
// Notes:
// - Uses native fetch + ReadableStream so no experimental flag is needed
//   on Node 24 (where EventSource is still behind --experimental-eventsource).
// - SSE framing is parsed in-line: each frame is separated by a blank line
//   (\n\n), with `event:` and `data:` lines preceding it.
// - The token is sent via the ?token= query (the SSE route's auth path)
//   instead of an Authorization header because EventSource/stream
//   fetch can't always set arbitrary headers.

const TOKEN = process.env.TOKEN;
const SID = process.env.SID;

if (!TOKEN || !SID) {
  console.error("Usage: TOKEN=... SID=... node audit-sse.mjs");
  process.exit(1);
}

const BASE = process.env.BASE || "http://127.0.0.1:8010";

async function main() {
  // 1) Create a run.
  const create = await fetch(`${BASE}/api/sessions/${SID}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      prompt: "halo, audit test dari harness",
      model: "workspace",
      effort: "high",
    }),
  });
  if (!create.ok) {
    console.error("[harness] create run failed", create.status, await create.text());
    process.exit(1);
  }
  const { runId, sessionId } = await create.json();
  console.log(`[harness] run ${runId} session ${sessionId}`);

  // 2) Open the SSE stream.
  const streamUrl = `${BASE}/api/sessions/${sessionId}/runs/${runId}/stream?token=${encodeURIComponent(TOKEN)}`;
  const resp = await fetch(streamUrl);
  if (!resp.ok || !resp.body) {
    console.error("[harness] stream open failed", resp.status);
    process.exit(1);
  }
  console.log(`[harness] connected to ${streamUrl.replace(TOKEN, "<token>")}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  const timer = setTimeout(() => {
    console.log("[harness] timeout 60s");
    reader.cancel().finally(() => process.exit(1));
  }, 60_000);

  // 3) Walk the SSE stream. Each frame is "event: name\ndata: json\n\n".
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.startsWith(":")) continue; // SSE comment (keepalive, open, end)
      const ev = parseFrame(frame);
      if (!ev) continue;
      const preview = (ev.data || "").slice(0, 200);
      console.log(`[evt] ${ev.event}: ${preview}`);
      if (ev.event === "done" || ev.event === "stopped") {
        clearTimeout(timer);
        reader.cancel().finally(() => process.exit(0));
        return;
      }
      if (ev.event === "error") {
        clearTimeout(timer);
        reader.cancel().finally(() => process.exit(1));
        return;
      }
    }
  }
  clearTimeout(timer);
}

function parseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

main().catch((e) => { console.error("[harness] error:", e); process.exit(1); });
