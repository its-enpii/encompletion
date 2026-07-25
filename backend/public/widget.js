/**
 * Encompletion embed widget — minimal client.
 *
 * Drop-in script for tenant apps (Laravel, etc.) that have obtained an
 * `embed_token` from the host backend's POST /api/embed/token call.
 *
 * Usage:
 *   <script src="https://encompletion.example.com/embed/widget.js"
 *           data-endpoint="https://encompletion.example.com"
 *           data-token="em_..."
 *           data-mount="#encompletion-chat"
 *           defer></script>
 *
 *   <div id="encompletion-chat"></div>
 *
 * The widget renders a tiny chat UI (header + message list + composer)
 * into the mount element. All chat text is rendered as textContent (not
 * innerHTML) to avoid XSS from model output. The endpoint base can be
 * relative by passing `data-endpoint=""` — the script will default to
 * the same origin it was loaded from.
 *
 * Wire format mirrors /api/sessions/:id/runs SSE exactly: text deltas
 * are JSON { type: "text", text } events emitted by run-registry.
 *
 * Standalone IIFE — no React, no build step, no dependencies. ~5KB.
 */

(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return; // very old browsers

  var endpoint = script.getAttribute('data-endpoint') || script.src.replace(/\/[^/]*$/, '');
  var token = script.getAttribute('data-token') || '';
  var mountSel = script.getAttribute('data-mount') || '#encompletion-embed';
  var mount = document.querySelector(mountSel);
  if (!mount) {
    console.error('[encompletion] mount element not found:', mountSel);
    return;
  }
  if (!token) {
    console.error('[encompletion] data-token is required');
    return;
  }

  var STATE = {
    sessionId: null,
    sending: false,
  };

  // ---- DOM scaffold --------------------------------------------------
  var root = document.createElement('div');
  root.className = 'enc-embed';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Chat assistant');

  var header = document.createElement('div');
  header.className = 'enc-embed-header';
  header.textContent = 'Assistant';

  var list = document.createElement('div');
  list.className = 'enc-embed-list';
  list.setAttribute('aria-live', 'polite');

  var composer = document.createElement('form');
  composer.className = 'enc-embed-composer';
  var input = document.createElement('textarea');
  input.rows = 1;
  input.placeholder = 'Type a message…';
  input.required = true;
  var sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.textContent = 'Send';
  composer.appendChild(input);
  composer.appendChild(sendBtn);

  root.appendChild(header);
  root.appendChild(list);
  root.appendChild(composer);
  mount.appendChild(root);

  // Minimal styles. Host app can override via CSS — selectors are
  // namespaced under `.enc-embed` so collisions are unlikely.
  var style = document.createElement('style');
  style.textContent = [
    '.enc-embed { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;',
    '  border: 1px solid #e2e2e8; border-radius: 10px; background: #fff;',
    '  display: flex; flex-direction: column; height: 480px; max-width: 480px;',
    '  box-shadow: 0 4px 14px rgba(0,0,0,.06); overflow: hidden; color: #18181b; }',
    '.enc-embed-header { padding: 10px 14px; font-weight: 600; background: #fafafa;',
    '  border-bottom: 1px solid #e2e2e8; }',
    '.enc-embed-list { flex: 1; overflow-y: auto; padding: 12px;',
    '  display: flex; flex-direction: column; gap: 8px; }',
    '.enc-embed-msg { padding: 8px 10px; border-radius: 8px; max-width: 80%;',
    '  white-space: pre-wrap; word-wrap: break-word; }',
    '.enc-embed-msg.user { background: #f1f1f4; align-self: flex-end; }',
    '.enc-embed-msg.assistant { background: #eef2ff; align-self: flex-start; }',
    '.enc-embed-msg.error { background: #fee; color: #900; align-self: flex-start; }',
    '.enc-embed-composer { display: flex; gap: 6px; padding: 8px;',
    '  border-top: 1px solid #e2e2e8; background: #fafafa; }',
    '.enc-embed-composer textarea { flex: 1; resize: none; padding: 6px 8px;',
    '  border: 1px solid #d4d4d8; border-radius: 6px; font: inherit; }',
    '.enc-embed-composer button { padding: 6px 14px; border: 0; border-radius: 6px;',
    '  background: #4f46e5; color: #fff; cursor: pointer; font: inherit; }',
    '.enc-embed-composer button:disabled { opacity: .5; cursor: not-allowed; }',
  ].join('\n');
  document.head.appendChild(style);

  // ---- Helpers -------------------------------------------------------
  function escapeText(s) { return String(s == null ? '' : s); }

  function appendMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'enc-embed-msg ' + role;
    el.textContent = text;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }

  function authHeaders() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  }

  function url(path) {
    return endpoint.replace(/\/$/, '') + path;
  }

  function jsonFetch(path, body) {
    return fetch(url(path), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t); });
      return r.json();
    });
  }

  // ---- Lifecycle -----------------------------------------------------

  // Create a session up front. The widget is intentionally stateless
  // about *which* session — it just keeps one open per page lifetime.
  // Tenant apps that need a session per chat-thread can override by
  // setting window.EncompletionEmbed.sessionId before the script loads.
  jsonFetch('/api/embed/sessions', {})
    .then(function (data) {
      STATE.sessionId = data.session.id;
    })
    .catch(function (err) {
      appendMessage('error', 'Failed to start session: ' + err.message);
    });

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    if (STATE.sending) return;
    var text = input.value.trim();
    if (!text) return;
    if (!STATE.sessionId) {
      appendMessage('error', 'Session not ready — please retry in a moment.');
      return;
    }
    STATE.sending = true;
    sendBtn.disabled = true;
    input.value = '';
    appendMessage('user', text);
    var assistantEl = appendMessage('assistant', '');

    jsonFetch('/api/embed/sessions/' + STATE.sessionId + '/runs', { prompt: text })
      .then(function (data) {
        var runId = data.runId;
        return openStream(data.sessionId, runId, assistantEl);
      })
      .catch(function (err) {
        assistantEl.textContent = 'Error: ' + err.message;
        assistantEl.className = 'enc-embed-msg error';
      })
      .finally(function () {
        STATE.sending = false;
        sendBtn.disabled = false;
      });
  });

  function openStream(sessionId, runId, assistantEl) {
    // EventSource doesn't support custom headers — pass token via query.
    var src = new EventSource(
      url('/api/embed/sessions/' + sessionId + '/runs/' + runId + '/stream?embed_token=' + encodeURIComponent(token))
    );
    var buffer = '';
    return new Promise(function (resolve, reject) {
      src.addEventListener('text', function (e) {
        try {
          var data = JSON.parse(e.data);
          if (data && typeof data.text === 'string') {
            buffer += data.text;
            assistantEl.textContent = buffer;
            list.scrollTop = list.scrollHeight;
          }
        } catch (_) { /* ignore malformed frame */ }
      });
      src.addEventListener('result', function () {
        // final result event — close happens via the 'done' event below
      });
      src.addEventListener('error', function (e) {
        // Server-sent 'error' events also flow through here in some
        // browsers; if readyState is CLOSED we just finalize.
        if (src.readyState === EventSource.CLOSED) {
          resolve();
        }
      });
      src.addEventListener('done', function () {
        try { src.close(); } catch (_) {}
        resolve();
      });
      // Hard timeout — runaway streams shouldn't pin the widget.
      setTimeout(function () {
        try { src.close(); } catch (_) {}
        resolve();
      }, 5 * 60 * 1000);
    });
  }
})();