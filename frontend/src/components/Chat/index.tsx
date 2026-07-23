"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useParams, useRouter } from "next/navigation";
import { authFetch, useAuth, getToken } from "@/lib/auth";
import { subscribeRun, startRun, stopRun, type RunEventHandlers } from "@/lib/runStream";
import { type Project, type Session } from "@/components/Sidebar";
import { useUi } from "@/components/ui/UiProvider";
import SkillsModal from "@/components/SkillsModal";
import ToolBlock, { type ToolUse } from "@/components/ToolBlock";
import { type Artifact } from "@/components/ArtifactViewer";
import ArtifactPanel from "@/components/ArtifactPanel";
import { ChatHeader, type ModelOption } from "./Header";
import { useModels } from "@/lib/models";
import { getStored, setStored } from "@/lib/store";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import type { Att, Msg, PendingAtt, Usage } from "./types";

type ChatProps = {
  /**
   * Sidebar is mounted globally by AppShell now. Chat never renders its own;
   * this flag is kept for backwards compatibility but is ignored.
   */
  hideSidebar?: boolean;
  initialProjectId?: number | null;
  initialSessionId?: number | null;
};

const STALE_MS = 90_000;

export default function Chat({
  hideSidebar: _hideSidebar = false,
  initialProjectId = null,
  initialSessionId = null,
}: ChatProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { toast, showError, dismissError } = useUi();
  void toast;
  // Track the most recent chat-level error id so a new send can
  // dismiss the previous banner (so the user doesn't see stale errors
  // next to a fresh attempt). Older banners persist until clicked.
  const errorIdRef = useRef<number | null>(null);
  // Surface a chat-scoped error as a sticky banner. Dismisses any
  // prior chat-scoped error so the user doesn't see stale messages
  // alongside a fresh attempt; other apps still rely on the global
  // stack via showError() directly.
  function pushChatError(message: string, detail?: string) {
    if (errorIdRef.current != null) dismissError(errorIdRef.current);
    errorIdRef.current = showError({ message, detail });
  }

  const routeSessionId =
    pathname?.startsWith("/chat/") && params?.id && /^\d+$/.test(params.id)
      ? Number(params.id)
      : null;
  const routeProjectId =
    pathname?.startsWith("/projects/") && params?.id && /^\d+$/.test(params.id)
      ? Number(params.id)
      : null;

  const [sessionId, setSessionId] = useState<number | null>(initialSessionId ?? routeSessionId);
  const [projectId, setProjectId] = useState<number | null>(initialProjectId ?? routeProjectId);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  useEffect(() => {
    if (routeSessionId !== sessionId) setSessionId(routeSessionId);
  }, [routeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialSessionId != null && initialSessionId !== sessionId) setSessionId(initialSessionId);
  }, [initialSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pathname?.startsWith("/projects/")) setProjectId(routeProjectId);
  }, [routeProjectId, pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const [toolUses, setToolUses] = useState<ToolUse[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [attachmentsByMsg, setAttachmentsByMsg] = useState<Record<number, Att[]>>({});
  // Map of message_id -> compact artifact info for the inline cards.
  // Only carries a short preview string here so the messages array
  // doesn't bloat on long transcripts; the full content is loaded
  // on demand when an ArtifactCard is clicked.
  const [artifactsByMsg, setArtifactsByMsg] = useState<Record<number, { id: number; type: string; language: string | null; title: string | null; content_preview: string; line_count: number; version: number }[]>>({});

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [model, setModel] = useState("workspace");
  const [effort, setEffort] = useState("high");

  const [projects, setProjects] = useState<Project[]>([]);
  const [pendingAtts, setPendingAtts] = useState<PendingAtt[]>([]);
  const [showArtifactPanel, setShowArtifactPanelRaw] = useState(false);
  // Mirror the messages list through this setter so any code path
  // — setMessages from useEffect, onText socket handler, setMessages
  // during regenerate, etc. — updates both React state and the ref
  // synchronously. The ref matters because the 'result' socket
  // handler reads from it to decide whether to flip streaming=false;
  // if the ref lags the state (the buggy useEffect approach) we
  // get a 'result' arriving while the assistant content was just
  // appended → TypingPill stays up because messagesRef still
  // reports 'no assistant bubble yet'.
  const [messages, setMessagesRaw] = useState<Msg[]>([]);
  const messagesRef = useRef<Msg[]>([]);
  // Sidebar (sibling under AppShell) listens for this event to refetch
  // its session list. Hoisting a shared state would have required
  // threading refreshKey through the layout; an event keeps the two
  // components decoupled and lets any other component trigger a refresh
  // without prop-drilling.
  function notifySidebarChanged() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("app:sessions-changed"));
    }
  }
  const setMessages = useCallback((updater: React.SetStateAction<Msg[]>) => {
    setMessagesRaw((cur) => {
      const next = typeof updater === "function" ? (updater as any)(cur) : updater;
      messagesRef.current = next;
      return next;
    });
  }, []);
  function setShowArtifactPanel(v: boolean) {
    setShowArtifactPanelRaw(v);
    setStored("artifacts:open", v ? "1" : "0");
  }
  useEffect(() => {
    const v = getStored("artifacts:open");
    if (v === "1") setShowArtifactPanelRaw(true);
  }, []);

  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  // Active run id — set when startRun() succeeds, cleared on result/done/stopped.
  // Triggers the SSE subscribe effect below; same id survives session-route
  // changes so the stream stays attached mid-navigation.
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  // Persistence helper: every active run is stashed in sessionStorage under
  // a per-session key. When the user navigates away and back to the same
  // /chat/:id, the freshly-mounted Chat component reads this and re-attaches
  // to the still-running stream (the backend registry keeps the run alive
  // for 60s after `done`, so late subscribers see the full event sequence
  // including events that fired while we were away).
  function persistActiveRun(runId: number | null, sid: number | null) {
    if (typeof window === "undefined" || sid == null) return;
    try {
      if (runId != null) {
        window.sessionStorage.setItem(`app:active-run:${sid}`, String(runId));
      } else {
        window.sessionStorage.removeItem(`app:active-run:${sid}`);
      }
    } catch { /* sessionStorage may be blocked */ }
  }

  // Restore persisted effort + model. Wrapper reads both new (app:*) and
  // legacy (claude-web:*) keys, migrates on first hit.
  useEffect(() => {
    const m = getStored("model");
    if (m) setModel(m);
    const e = getStored("effort");
    if (e) setEffort(e);
  }, []);
  useEffect(() => { setStored("model", model); }, [model]);
  useEffect(() => { setStored("effort", effort); }, [effort]);

  // Load projects list for the project picker.
  useEffect(() => {
    authFetch("/api/projects").then((r) => r.json()).then(setProjects).catch(() => {});
  }, []);

  // Sync `activeProject` with the local `projectId` state when there's no
  // active session yet. Without this, a brand-new chat with a project
  // picked in the Composer would have `activeSession = null` and the
  // header's project pill / settings button would be missing — even
  // though the Composer clearly shows the bound project. We only override
  // when the session row doesn't speak for itself.
  useEffect(() => {
    if (activeSession) return; // session-driven sync handles this
    if (projectId == null) { setActiveProject(null); return; }
    setActiveProject(projects.find((p) => p.id === projectId) ?? null);
  }, [projectId, projects, activeSession]);

  // Load session + messages when route changes.
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  // Synchronous double-submit guard. `streaming` state is async — a fast
  // Enter→Enter sequence can fire send() twice before the first
  // setStreaming(true) flushes, letting a second run start while the
  // first is still in-flight. The ref is read/written synchronously and
  // closes that race window.
  const sendingRef = useRef(false);
  // Monotonic counter for optimistic message ids. Negative values so they
  // never collide with real DB ids (which are positive). Decremented on
  // each send so consecutive optimistic bubbles have distinct keys.
  const optimisticCounterRef = useRef(0);
  // Live handle to the current SSE EventSource so the onError handler
  // can read its readyState and decide between "transient blip" (don't
  // touch streaming) and "404 because the run ended before we
  // subscribed" (fall back to loadSession()).
  const sourceRef = useRef<EventSource | null>(null);

  async function loadSession(id: number) {
    try {
      // Backend exposes a single `/full` endpoint that bundles session +
      // messages + tool_uses + artifacts + attachments in one round-trip.
      const data = await authFetch(`/api/sessions/${id}/full`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      const s = data.session;
      const dbMsgs = data.messages || [];
      const t = data.tool_uses || [];
      const a = data.artifacts || [];
      const atts = data.attachments || [];
      // Merge DB snapshot with any optimistic local messages. On a fresh
      // chat flow (`/chat/new` → `POST /api/sessions` → router.push to
      // `/chat/[id]`) the user message row is committed to the DB by
      // `POST /runs` *after* the SSE stream is opened, so a `loadSession`
      // fired in parallel with that POST can race and return an empty
      // messages array — wiping the optimistic bubble that `send()` or
      // `triggerPendingRun` just added. Keep any optimistic bubbles that
      // don't yet have a DB match; drop optimistic bubbles whose content
      // matches a real DB row to avoid duplicates.
      const dbUserContents = new Set(
        dbMsgs.filter((row: any) => row.role === "user").map((row: any) => row.content)
      );
      const optimisticOnly = messagesRef.current.filter((local) => {
        if (local.id >= 0) return false; // real DB row, drop
        return !dbUserContents.has(local.content);
      });
      const m = [...optimisticOnly, ...dbMsgs];
      // Group attachments by message_id for MessageList lookup.
      const attMap: Record<number, Att[]> = {};
      const token = typeof window !== "undefined" ? getToken() : null;
      for (const att of atts) {
        // Tag the file URL with the auth token as a query param so
        // <img>, <iframe>, and plain fetch() can reach the protected
        // /api/attachments/file/... endpoint without setting
        // Authorization headers (the html tag API can't carry them,
        // and a missing Authorization triggers 401). The token here
        // is the same JWT used for API calls — already trusted by
        // the backend auth middleware via `?token=`-fallback.
        const arr = attMap[att.message_id] ||= [];
        if (token && att.file_path && !att.file_path.startsWith("/")) {
          arr.push({
            ...att,
            url: `/api/attachments/file/${att.file_path}?token=${encodeURIComponent(token)}`,
          });
        } else {
          arr.push(att);
        }
      }
      setActiveSession(s);
      // The header's project pill and settings entry point must reflect
      // whichever project the user has currently bound — even when no
      // session has been saved yet (i.e. a brand-new chat with the project
      // chosen in the Composer). Prefer the freshly-fetched session's
      // project_id; fall back to the local `projectId` state (the
      // Composer picker) when there is no session row at all.
      const projectFromSession = s.project_id
        ? projects.find((p) => p.id === s.project_id) ?? null
        : null;
      setActiveProject(projectFromSession);
      setToolUses(t);
      setArtifacts((a as Artifact[]).filter((x) => !x.dup_of));
      // Merge local optimistic attachment chips with the DB-loaded ones.
      // Same race rationale as `m` above — fresh chat with attachments
      // can fire loadSession before the message_attachments rows are
      // committed by POST /runs. Keep optimistic chips whose key is not
      // shadowed by a DB row with the same file_name + content prefix.
      setAttachmentsByMsg((cur) => {
        const next: Record<number, Att[]> = { ...attMap };
        for (const [k, v] of Object.entries(cur)) {
          const key = Number(k);
          if (key >= 0) continue; // real DB row, already in attMap
          if (next[key]) continue; // already covered
          next[key] = v;
        }
        return next;
      });
      // Group artifacts by message_id for the inline card rendering.
      const artMap: Record<number, any[]> = {};
      for (const art of a as any[]) {
        if (art.dup_of || art.message_id == null) continue;
        if (!artMap[art.message_id]) artMap[art.message_id] = [];
        artMap[art.message_id].push({
          id: art.id,
          type: art.type,
          language: art.language ?? null,
          title: art.title ?? null,
          content_preview: (art.content || "").slice(0, 220),
          line_count: (art.content || "").split("\n").length,
          version: art.version ?? 1,
        });
      }
      setArtifactsByMsg(artMap);
      setUsage(null);
      setInfo(null);
      // Always pull the persisted snapshot — the user message row was
      // written to the DB before the SSE stream opens, so even when
      // mid-stream the DB is the authoritative source. The streaming
      // check used to live here but it caused a real bug: when a
      // fresh chat navigates from /chat/new to /chat/[id] while
      // streaming=true (set by send() right before the route push),
      // the snapshot was skipped and the optimistic bubble stayed
      // orphaned if anything in the navigation cleared the state.
      // We accept a brief flicker when text deltas arrive between
      // snapshot and re-attach — better than a silent blank thread.
      setMessages(m);
      // If the DB snapshot already has a finished assistant reply —
      // i.e. the run ended while we were reconnecting — clear the
      // streaming spinner and the activeRunId so we don't keep showing
      // "Sedang berpikir…" on top of a finalised message. Match by
      // presence of an assistant row, not by content length, because a
      // 504 / gateway timeout still creates the assistant row but
      // leaves its content empty.
      const hasAssistantRow = m.some((row: any) => row.role === "assistant");
      if (hasAssistantRow) {
        setStreaming(false);
        setActiveRunId(null);
        setLastTickAt(null);
        setInfo(null);
      }
      scrollToBottom();
    } catch (e: any) {
      pushChatError(e?.message || "Gagal load session");
    }
  }

  // Trigger a run that was started on /new and stashed in sessionStorage
  // before router.push unmounted the old component. The freshly-mounted
  // Chat component at /chat/:id reads the stash, fires startRun, and
  // cleans up. Without this, the in-flight `runId` would be lost on
  // unmount and the SSE stream never opens — the user sees a silent
  // session with no TypingPill until they navigate.
  async function triggerPendingRun(pending: {
    sessionId: number;
    prompt: string;
    model: string;
    effort: string;
    projectId?: number | null;
    attachments?: any[];
  }) {
    setUsage(null);
    setStreaming(true);
    setLastTickAt(Date.now());
    setStale(false);
    setInfo("Sedang berpikir…");
    sendingRef.current = true;
    // Skip the optimistic user bubble if loadSession already populated
    // the message list with the real DB row for this turn. Without this,
    // a fresh chat flow that mounts /chat/[id] immediately after the
    // POST /sessions races the loadSession fetch against the queued
    // triggerPendingRun microtask — when loadSession wins, this would
    // otherwise add a duplicate user bubble on top of the real one.
    const alreadyHasUserBubble = messagesRef.current.some(
      (m) => m.role === "user" && m.content === pending.prompt
    );
    if (!alreadyHasUserBubble) {
      const optimisticId = --optimisticCounterRef.current;
      setMessages((cur) => [...cur, { id: optimisticId, role: "user", content: pending.prompt }]);
      const atts = Array.isArray(pending.attachments) ? pending.attachments : [];
      if (atts.length > 0) {
        setAttachmentsByMsg((cur) => ({
          ...cur,
          [optimisticId]: atts.map((a) => ({
            id: 0,
            file_name: a.file_name,
            mime_type: a.mime_type,
            size: a.size,
            url: a.content || a.file_path || "",
          })),
        }));
      }
    }
    // No optimistic assistant bubble. The first `text` event will
    // create the assistant row itself (the text handler pushes a new
    // bubble when `last` is a user row). Inserting an empty assistant
    // placeholder up-front races with the text event and can land at
    // the head of the array once loadSession merges DB rows in,
    // producing the "AI bubble floats above the user chip" symptom.
    try {
      const { runId } = await startRun({
        sessionId: pending.sessionId,
        prompt: pending.prompt,
        model: pending.model,
        projectId: pending.projectId ?? null,
        effort: pending.effort,
        attachments: pending.attachments,
      });
      if (!runId) throw new Error("no run id returned");
      setActiveRunId(runId);
      persistActiveRun(runId, pending.sessionId);
    } catch (e: any) {
      sendingRef.current = false;
      pushChatError(e?.message || "Gagal kirim");
      setStreaming(false);
    }
  }

  useEffect(() => {
    if (sessionId == null) {
      setActiveSession(null);
      setActiveProject(null);
      setMessages([]);
      setToolUses([]);
      setArtifacts([]);
      setAttachmentsByMsg({});
      return;
    }

    // Pre-empt the EmptyHero flicker on a fresh chat mount. When send()
    // navigated us to /chat/[id] with a pending run stashed, the very
    // first paint would otherwise render "Mulai percakapan baru" before
    // loadSession had a chance to fill `messages`. Flip streaming=true
    // synchronously here so EmptyHero stays hidden until the optimistic
    // bubble arrives.
    let pendingForThisSession = false;
    if (typeof window !== "undefined") {
      try {
        const raw = window.sessionStorage.getItem("app:pending-run");
        if (raw) {
          const peek = JSON.parse(raw);
          if (peek?.sessionId === sessionId) pendingForThisSession = true;
        }
      } catch { /* ignore */ }
    }
    if (pendingForThisSession) {
      setStreaming(true);
      setInfo("Sedang berpikir…");
    }

    loadSession(sessionId);

    // Pick up any pending run stashed by send() before the route push
    // unmounted the previous Chat component. We read on the new
    // component, fire startRun, and clear the stash so a page refresh
    // doesn't double-fire.
    if (typeof window !== "undefined") {
      try {
        const raw = window.sessionStorage.getItem("app:pending-run");
        if (raw) {
          const pending = JSON.parse(raw);
          if (pending?.sessionId === sessionId) {
            window.sessionStorage.removeItem("app:pending-run");
            queueMicrotask(() => { triggerPendingRun(pending); });
          } else {
            // Stash belongs to a different session — stale, drop it.
            window.sessionStorage.removeItem("app:pending-run");
          }
        }
      } catch { /* ignore malformed JSON */ }

      // Pick up an in-flight runId for THIS session (existing-session
      // path). When the user navigates away mid-stream and back, the
      // SSE EventSource was closed on unmount but the backend registry
      // keeps the run alive — re-attach by re-subscribing to the same
      // runId. Backend's `subscribe()` returns 404 only after the run
      // has fully ended (60s grace), so a mid-stream reconnect always
      // succeeds and replays any events the runner emitted while we
      // were away.
      try {
        const runRaw = window.sessionStorage.getItem(`app:active-run:${sessionId}`);
        if (runRaw) {
          const runId = Number(runRaw);
          if (Number.isInteger(runId) && runId > 0 && activeRunId == null) {
            queueMicrotask(() => {
              setActiveRunId(runId);
              // Show the spinner immediately — loadSession() will refill
              // the messages from the DB and the re-attached SSE stream
              // catches any events that come after.
              setStreaming(true);
              setLastTickAt(Date.now());
              setStale(false);
              setInfo("Sedang berpikir…");
            });
          }
        }
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Stale-heartbeat detection.
  useEffect(() => {
    if (!streaming) { setStale(false); return; }
    const t = setInterval(() => {
      if (lastTickAt && Date.now() - lastTickAt > STALE_MS) setStale(true);
    }, 5000);
    return () => clearInterval(t);
  }, [streaming, lastTickAt]);

  // Hard timeout — if streaming never resolves to a `result` event within
  // TIMEOUT_MS (engine hung, socket silently dropped, etc), force the UI
  // out of the loading state so the user isn't stuck with a perpetual
  // TypingPill. We also re-pull the DB snapshot at this point because
  // the most likely reason we're here is that the SSE socket was lost
  // mid-stream and the assistant reply already landed in the DB — the
  // local state just never got the `text` / `result` / `done` events.
  const TIMEOUT_MS = 60_000;
  useEffect(() => {
    if (!streaming) return;
    const t = setTimeout(() => {
      setStreaming((cur) => {
        if (cur) {
          // Best-effort recovery: re-fetch the session so a reply that
          // landed in the DB but never reached the EventSource is still
          // visible to the user. loadSession is async and will replace
          // `messages` once it resolves.
          if (sessionId != null) loadSession(sessionId).catch(() => {});
          pushChatError(`Engine belum menjawab dalam ${TIMEOUT_MS / 1000}s. Coba kirim ulang atau pilih model lain.`);
          return false;
        }
        return cur;
      });
      setLastTickAt(null);
    }, TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [streaming, sessionId]);

  // Window-level safety net: a drag that ends outside the chat area
  // (user drops on the sidebar, hits Esc, or drags off-window) doesn't
  // fire dragleave on our root, which would leave the overlay stuck.
  // `dragend` fires on the source element when the drag operation
  // concludes regardless of where the cursor was, so we listen on
  // window to catch all paths.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onEnd() {
      pageDragDepth.current = 0;
      setPageDragActive(false);
    }
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    return () => {
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
    };
  }, []);

  // SSE streaming. Open an EventSource against the active run and wire
  // every typed event the runner can emit. The effect re-runs when
  // sessionId OR activeRunId changes — typically once per prompt. Closing
  // the source on cleanup means a fresh prompt opens a fresh stream
  // (the runner's per-run lifecycle in the backend registry matches).
  useEffect(() => {
    if (activeRunId == null || sessionId == null) return;
    if (typeof window === "undefined") return; // SSR safety

    const forSession = (payload: any): number | null => {
      if (!payload) return null;
      const v = payload.sessionId ?? payload.session_id;
      return typeof v === "number" ? v : null;
    };
    const isMine = (payload: any) => {
      const sid = forSession(payload);
      return sid === null || sid === sessionId;
    };

    const handlers: RunEventHandlers = {
      start: (payload: { sessionId: number; messageId: number | null }) => {
        if (!isMine(payload)) return;
        setInfo(`Run started (model ${payload.messageId ? "…" : "init"})`);
      },
      system: (payload: { sessionId: number; claudeSessionId?: string; model?: string }) => {
        if (!isMine(payload)) return;
        if (payload.model) setInfo(`Engine: ${payload.model}`);
      },
      text: (payload: { sessionId: number; text: string }) => {
        if (!isMine(payload)) return;
        setMessages((cur) => {
          const last = cur[cur.length - 1];
          if (last && last.role === "assistant") {
            return [...cur.slice(0, -1), { ...last, content: last.content + payload.text }];
          }
          return [...cur, { id: 0, role: "assistant", content: payload.text }];
        });
      },
      stderr: (payload: { sessionId?: number; text: string }) => {
        if (!isMine(payload)) return;
        if (!errorIdRef.current) {
          errorIdRef.current = showError({ message: payload.text.slice(0, 240) });
        }
        // Some LLM failures only surface through stderr (e.g. "LLM HTTP
        // 504: …") followed by a result event. The result event fires
        // shortly after and also clears streaming, so this is mostly
        // belt-and-braces — but on the path where the result is delayed
        // or dropped, this stops TypingPill sticking around once the
        // user has already seen the error.
        if (/^LLM HTTP\s+\d{3}/.test(payload.text || "")) {
          setStreaming(false);
        }
      },
      error: (payload: { sessionId?: number; message: string }) => {
        if (!isMine(payload)) return;
        pushChatError(payload.message);
        setStreaming(false);
      },
      result: (payload: { sessionId: number; isError: boolean; errorMessage?: string; cost?: number; durationMs?: number; inputTokens?: number; outputTokens?: number }) => {
        if (!isMine(payload)) return;
        if (payload.isError) {
          pushChatError(payload.errorMessage || "engine returned is_error=true");
        }
        // Result is the authoritative "the engine finished" signal from
        // the runner — always flip streaming=false here, even when the
        // assistant bubble is still empty (vision-only runs, or a
        // connection race where text deltas never reached us). The
        // followup `done` handler re-confirms the flip and reloads from
        // DB to recover the persisted assistant row. Without the
        // unconditional flip, a 1-2s run that completes before the
        // EventSource subscribes leaves TypingPill stuck for the full
        // 60s hard-timeout window.
        setStreaming(false);
        setLastTickAt(null);
        setInfo((cur) => cur ?? `cost $${(payload.cost ?? 0).toFixed(4)} · ${payload.durationMs ?? 0}ms`);
      },
      stopped: (payload: { sessionId: number }) => {
        if (!isMine(payload)) return;
        setStreaming(false);
      },
      tick: () => {
        setLastTickAt(Date.now());
        setStale(false);
      },
      tool_use: (payload: any) => {
        if (!isMine(payload)) return;
        const tool = payload.tool ?? payload;
        setToolUses((cur) => [...cur, tool as ToolUse]);
      },
      artifact: (payload: any) => {
        if (!isMine(payload)) return;
        const art = payload.artifact ?? payload;
        setArtifacts((cur) => [...cur, art as Artifact]);
        const targetMsgId = (payload.artifactId ?? art?.message_id) ?? null;
        setArtifactsByMsg((cur) => {
          const next = { ...cur };
          const key = targetMsgId != null
            ? targetMsgId
            : messagesRef.current.findLast?.((m) => m.role === "assistant")?.id
              ?? messagesRef.current[messagesRef.current.length - 1]?.id
              ?? 0;
          if (!key) return cur;
          const entry = {
            id: art.id,
            type: art.type,
            language: art.language ?? null,
            title: art.title ?? null,
            content_preview: (art.content || "").slice(0, 220),
            line_count: (art.content || "").split("\n").length,
            version: art.version ?? 1,
          };
          next[key] = [...(next[key] || []).filter((x) => x.id !== entry.id), entry];
          return next;
        });
      },
      message_saved: (payload: { messageId: number }) => {
        let optimisticId: number | null = null;
        setMessages((cur) => {
          if (cur.length === 0) return cur;
          const idx = cur.findLastIndex((m) => m.role === "assistant");
          if (idx === -1) return cur;
          optimisticId = cur[idx].id;
          const copy = cur.slice();
          copy[idx] = { ...copy[idx], id: payload.messageId };
          return copy;
        });
        if (optimisticId != null && optimisticId !== payload.messageId) {
          setArtifactsByMsg((cur) => {
            const moved = cur[optimisticId as number];
            if (!moved || moved.length === 0) return cur;
            const next = { ...cur };
            delete next[optimisticId as number];
            next[payload.messageId] = moved;
            return next;
          });
        }
        notifySidebarChanged();
      },
      done: (payload: {
        sessionId: number | null;
        title?: string | null;
        cleanupSessionDeleted?: boolean;
        cleanupTurnDeleted?: boolean;
      }) => {
        // Terminal event — clear activeRunId so we don't reopen a stale
        // stream. The backend's 60s grace period covers any in-flight
        // reconnect attempts; client-side, we treat the run as fully done.
        // Also flip streaming=false unconditionally: `result` only does so
        // when the assistant produced text, so a vision-only turn (no
        // text deltas) would leave TypingPill stuck.
        sendingRef.current = false;
        setActiveRunId(null);
        setStreaming(false);
        setLastTickAt(null);
        // Clear the "Sedang berpikir…" header — the cost/duration summary
        // from `result` already replaces it (if the run produced text).
        // Leaving the spinner string here makes the header look stuck.
        setInfo(null);
        // Backend sends the freshly-derived title on `done` so the header
        // and sidebar refresh without a follow-up GET /full. Fall back
        // to null when the backend didn't include it (older builds) — in
        // that case the sidebar listener still pulls the latest title via
        // /api/sessions after notifySidebarChanged().
        if (typeof payload?.title === "string" || payload?.title === null) {
          setActiveSession((cur) => (cur ? { ...cur, title: payload.title ?? null } : cur));
        }
        // Auto-cleanup on error. The server deleted either the whole
        // session (first-turn failure) or just the failed pair (later
        // turn). Match the server's action on the client so the local
        // mirror doesn't keep showing a ghost assistant row.
        if (payload?.cleanupSessionDeleted) {
          // Whole session gone — leave the chat and go back to /new.
          // The sidebar listener below will refetch the list and the
          // deleted row drops out on its own.
          if (typeof window !== "undefined") {
            router.push("/new");
          }
          setActiveSession(null);
          setMessages([]);
        } else if (payload?.cleanupTurnDeleted) {
          // Drop the optimistic + persisted assistant row + the user
          // message it was paired with so the UI matches what the
          // server actually kept. Both ids came from this same turn
          // so a single pop on each side is sufficient.
          setMessages((cur) => {
            const next = cur.slice();
            // Walk back: find the trailing assistant (if any), then
            // its preceding user, and drop both. Defensive in case
            // ordering shifted (e.g. attach chips landed before the
            // text event).
            if (next.length > 0 && next[next.length - 1].role === "assistant") {
              next.pop();
            }
            if (next.length > 0 && next[next.length - 1].role === "user") {
              next.pop();
            }
            return next;
          });
        } else if (sessionId != null) {
          // Normal completion path: reload the session so any text
          // deltas that raced the SSE subscribe (or any side-channel
          // rows the runner persisted after streaming finished) line
          // up with what the server actually has. Without this, a
          // vision-only run that finishes before the EventSource
          // attaches leaves the assistant bubble sitting forever
          // empty until the user manually reloads.
          loadSession(sessionId).catch(() => {});
        }
        notifySidebarChanged();
        if (typeof window !== "undefined") {
          try { window.sessionStorage.removeItem(`app:active-run:${sessionId}`); } catch {}
        }
      },
      tool_result: () => { /* no-op */ },
      artifact_dup: () => { /* dedupe marker; not rendered */ },
      artifact_rejections: () => { /* noise-reduction summary; not surfaced */ },
      onError: () => {
        // EventSource auto-reconnects on transient errors. Don't flip
        // streaming=false on the first error — the 'result' or 'done'
        // event is the authoritative terminal signal and a transient
        // network blip shouldn't kill the spinner.
        //
        // BUT: if the run finished before the EventSource subscribed
        // (the backend's `subscribe()` returns 404 once the run has
        // fully ended and the grace window expired), we never receive
        // those events at all. Detect that case by reading the ready
        // state — EventSource.CLOSED (2) means the server sent a 404
        // and the auto-reconnect gave up. Fall back to a one-shot
        // loadSession() so the persisted assistant row still appears.
        if (sourceRef.current?.readyState === 2 /* CLOSED */ && sessionId != null) {
          loadSession(sessionId).catch(() => {});
          setStreaming(false);
          setLastTickAt(null);
        }
      },
    };

    const { unsubscribe, source } = subscribeRun({ sessionId, runId: activeRunId, handlers });
    sourceRef.current = source;
    return () => {
      unsubscribe();
      sourceRef.current = null;
    };
  }, [sessionId, activeRunId]);

  // SSE safety net — if the EventSource silently drops mid-run (network
  // blip, server-side registry timeout) the `done` event may never
  // arrive and TypingPill stays up forever. Poll /full every 10s while
  // streaming is on; once the DB shows a non-empty assistant reply,
  // clear the spinner locally and stop polling.
  useEffect(() => {
    if (!streaming || sessionId == null) return;
    if (typeof window === "undefined") return;
    const poll = setInterval(() => {
      authFetch(`/api/sessions/${sessionId}/full`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          const msgs = data.messages || [];
          // Any assistant row means the run is finished — clear the
          // spinner. Empty content means the engine returned an error
          // (504, gateway timeout, etc) but the row still exists.
          if (msgs.some((row: any) => row.role === "assistant")) {
            setStreaming(false);
            setActiveRunId(null);
            setLastTickAt(null);
            setInfo(null);
          }
        })
        .catch(() => { /* ignore — next poll retries */ });
    }, 10_000);
    return () => clearInterval(poll);
  }, [streaming, sessionId]);

  // Auto-scroll to the newest message whenever the list grows or content
  // streams in. We only auto-scroll if the user is already near the bottom
  // (within ~80px) — if they've scrolled up to read older messages, leave
  // them alone and surface the jump-to-bottom button instead.
  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const shouldPin = streaming || distFromBottom < 80;
    if (!shouldPin) return;
    scrollToBottom();
    // Intentionally only depend on messages.length so each text delta
    // triggers a re-scroll. message_saved id swaps don't change length
    // so they're a no-op here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, streaming]);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = mainScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  const [showJump, setShowJump] = useState(false);
  // Page-level drag state — fires the full-page drop overlay whenever a
  // file is dragged anywhere inside the chat surface (outside the
  // composer's own local overlay). Depth-counted so dragging over
  // child elements doesn't flicker the overlay.
  const [pageDragActive, setPageDragActive] = useState(false);
  const pageDragDepth = useRef(0);

  async function send() {
    const text = input.trim();
    // Allow send with attachments only (no text). The backend will receive
    // the attachment list and the LLM sees them via [Attachments] prefix.
    if ((!text && pendingAtts.length === 0) || streaming || sendingRef.current) return;
    sendingRef.current = true;
    setInput("");
    setUsage(null);
    setStreaming(true);
    setLastTickAt(Date.now());
    setStale(false);

    // Optimistic UI: drop the user message in immediately so the chat
    // bubble is visible while the server processes. Use a negative id so
    // it never collides with a real DB row (the user-message row is
    // created server-side via POST /runs but never emits an SSE event
    // back to us; if it happened to also be id=0 we'd see stale
    // attachment chips on subsequent turns). The next mount's
    // loadSession() fetches the real messages and the optimistic entry
    // drops out naturally. content="..." only if there's actual text —
    // sending only attachments leaves content empty, which MessageBubble
    // renders as "no body" (chips above carry the meaning).
    const optimisticId = --optimisticCounterRef.current;
    setMessages((cur) => [...cur, { id: optimisticId, role: "user", content: text }]);
    // Optimistic: attach pending composer attachments to the user bubble
    // so the file chip shows immediately. The DB row is persisted by the
    // SSE handler; on next mount loadSession() rebuilds attachmentsByMsg
    // from the server, so the optimistic key is dropped automatically.
    if (pendingAtts.length > 0) {
      setAttachmentsByMsg((cur) => ({
        ...cur,
        [optimisticId]: pendingAtts.map((a) => ({
          id: 0,
          file_name: a.file_name,
          mime_type: a.mime_type,
          size: a.size,
          // dataUrl for image preview in <a href>; AttachmentStrip uses
          // href as the link target.
          url: a.content || a.file_path || "",
        })),
      }));
    }
    // No optimistic assistant bubble here either — see the comment in
    // triggerPendingRun. The first `text` event pushes the assistant
    // row in, and that lands in the correct slot in the array (right
    // after the user bubble) without racing the loadSession merge.
    setInfo(`Sedang berpikir…`);

    // Resolve which session id we're targeting. If we're already inside
    // a session (e.g. visiting /chat/[id] directly), reuse it; otherwise
    // create a new session row first, then route to it.
    let targetSessionId = sessionId;
    let thisSessionIsFresh = false;
    if (!targetSessionId) {
      try {
        const r = await authFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: text.slice(0, 80),
            model,
            project_id: projectId,
          }),
        });
        setPendingAtts([]);
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${r.status}`);
        }
        const data = await r.json();
        targetSessionId = data.id ?? data.session_id;
        if (targetSessionId) {
          thisSessionIsFresh = true;
          // Stash the run payload in sessionStorage. The newly-mounted Chat
          // component at /chat/:id will pick it up and trigger startRun
          // from the fresh page context (avoiding state loss on unmount).
          if (typeof window !== "undefined") {
            window.sessionStorage.setItem(
              "app:pending-run",
              JSON.stringify({
                sessionId: targetSessionId,
                prompt: text,
                model,
                effort,
                projectId,
                // Stash attachments too — the freshly-mounted Chat at
                // /chat/:id will hand them to startRun() so backend
                // persists them to message_attachments. Without this,
                // reload after navigate-away loses the file chip.
                attachments: pendingAtts,
              })
            );
          }
          router.push(`/chat/${targetSessionId}`);
        }
        notifySidebarChanged();
      } catch (e: any) {
        sendingRef.current = false;
        pushChatError(e?.message || "Gagal membuat session");
        setStreaming(false);
        return;
      }
    } else {
      // Existing session: backend's POST /runs persists the user message
      // itself. We just clear the composer attachments.
      setPendingAtts([]);
    }

    if (thisSessionIsFresh) {
      // The newly mounted component will handle the run. We exit here
      // and reset the sendingRef so the composer stays unlocked if the
      // route fails.
      sendingRef.current = false;
      return;
    }

    // Existing session: kick off the run immediately.
    try {
      const { runId } = await startRun({
        sessionId: targetSessionId,
        prompt: text,
        model,
        projectId,
        effort,
        // Pass composer attachments — backend persists them to
        // message_attachments so a reload after navigate-away rehydrates.
        attachments: pendingAtts,
      });
      if (!runId) throw new Error("no run id returned");
      setActiveRunId(runId);
      persistActiveRun(runId, targetSessionId);
    } catch (e: any) {
      sendingRef.current = false;
      pushChatError(e?.message || "Gagal kirim");
      setStreaming(false);
    }
  }

  function stop() {
    if (activeRunId == null || sessionId == null) return;
    // Optimistic UI flip — the backend's `stopped` event will follow.
    sendingRef.current = false;
    setStreaming(false);
    setActiveRunId(null);
    stopRun(sessionId, activeRunId).catch(() => { /* runner may already be done */ });
  }

  function pickFiles() { fileInputRef.current?.click(); }
  function capturePhoto() { cameraInputRef.current?.click(); }

  async function onFiles(files: FileList | null, fromCamera = false) {
    if (!files) return;
    for (const f of Array.from(files)) {
      // Read once, then upload to the attachments endpoint so the file
      // lives at a real storage path (storage/attachments/<id>-<name>).
      // The `file_path` returned by the server is what backend uses
      // later when re-reading the binary for vision recall across turns.
      const dataUrl = await readAsDataUrl(f).catch(() => "");
      const base64 = dataUrl.startsWith("data:") ? dataUrl.split(",", 2)[1] : "";
      let uploaded: { file_name: string; file_path: string; mime_type: string; size: number; content?: string | null; url: string } | null = null;
      try {
        const r = await authFetch("/api/attachments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [
              {
                name: f.name,
                mimeType: f.type || "application/octet-stream",
                dataBase64: base64,
              },
            ],
          }),
        });
        if (r.ok) {
          const data = await r.json();
          uploaded = data.files?.[0] || null;
        }
      } catch { /* fall through to local placeholder below */ }
      setPendingAtts((cur) => [
        ...cur,
        uploaded
          ? {
              file_name: uploaded.file_name,
              mime_type: uploaded.mime_type,
              size: uploaded.size,
              content: uploaded.content || dataUrl, // keep dataUrl for in-bubble preview
              file_path: uploaded.file_path,        // server path for vision recall
            }
          : {
              // Upload failed — keep the composer usable by stashing the
              // dataUrl. Backend will store it inline in message_attachments
              // content column, so vision for this turn still works; only
              // cross-turn recall falls back to "see [attachment: name]".
              file_name: f.name,
              mime_type: f.type || "application/octet-stream",
              size: f.size,
              content: dataUrl,
              file_path: fromCamera ? `camera:${Date.now()}-${f.name}` : `paste:${Date.now()}-${f.name}`,
            },
      ]);
    }
  }

  function onPickProject(id: number | null) {
    setProjectId(id);
    if (id != null && sessionId != null) {
      authFetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: id }),
      }).catch(() => {});
    }
  }

  function onManageSkills() { setShowSkillsModal(true); }
  const [showSkillsModal, setShowSkillsModal] = useState(false);

  // Models registry — drives the chat-header dropdown. The admin page
  // mutates the registry; ModelsProvider listens on `models:updated` and
  // this consumer re-renders automatically. If the registry is still
  // loading or failed to fetch, fall back to a hardcoded minimal set so
  // the dropdown is never empty — "workspace" matches the previous default
  // so existing chats stay valid.
  const { models: registryModels, loading: registryLoading } = useModels();
  const modelOptions: ModelOption[] = useMemo(() => {
    const fromRegistry = registryModels
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
      .map((m) => ({ value: m.key, label: m.label }));
    if (fromRegistry.length > 0) return fromRegistry;
    // Last-resort fallback when the registry endpoint is unreachable AND
    // not loading. Keys here MUST be ids the engine CLI accepts; using
    // a generic placeholder like 'standard' or 'fast' would cause every
    // prompt to be rejected upstream with "issue with the selected
    // model", which the user perceives as a stuck UI.
    return registryLoading
      ? [{ value: "workspace", label: "Workspace" }]
      : [
          { value: "workspace", label: "Workspace" },
          { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
          { value: "claude-haiku-4-5", label: "Haiku 4.5" },
        ];
  }, [registryModels, registryLoading]);

  // If the persisted/default model disappears from the registry (admin
  // disabled it), snap back to the first enabled entry so the next message
  // doesn't send an unknown --model flag to the CLI.
  useEffect(() => {
    if (modelOptions.length === 0) return;
    if (!modelOptions.some((o) => o.value === model)) {
      setModel(modelOptions[0].value);
    }
  }, [modelOptions, model]);

  // Regenerate an assistant message: backend deletes the old reply, then we
  // re-trigger via POST /runs with `regenerate: true` so the server reuses
  // the existing user row instead of inserting a duplicate.
  async function regenerate(assistantMsgId: number) {
    if (!sessionId || streaming) return;
    const target = messages.find((m) => m.id === assistantMsgId);
    if (!target) return;
    // Walk back to the user prompt that produced this assistant reply.
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    let lastUser = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUser = messages[i];
        break;
      }
    }
    if (!lastUser) return;

    // Optimistically remove the old assistant message + any tool_uses tied to
    // it. The server has already deleted them; this keeps the UI in sync.
    setMessages((cur) => cur.filter((m) => m.id !== assistantMsgId));
    setToolUses((cur) => cur.filter((t) => t.message_id !== assistantMsgId));
    setArtifacts((cur) => cur.filter((_a) => true)); // server may also drop these; safety

    setUsage(null);
    setStreaming(true);
    setLastTickAt(Date.now());
    setStale(false);

    try {
      const { runId } = await startRun({
        sessionId,
        prompt: lastUser.content,
        model,
        projectId,
        effort,
        regenerate: true,
      });
      if (!runId) throw new Error("no run id returned");
      setActiveRunId(runId);
      persistActiveRun(runId, sessionId);
    } catch (e: any) {
      pushChatError(e?.message || "Gagal regenerate");
      setStreaming(false);
    }
  }

  // The composable chat area.
  const chatArea = (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col bg-[var(--paper)]"
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        pageDragDepth.current += 1;
        setPageDragActive(true);
      }}
      onDragLeave={(e) => {
        // Only count leaves when the cursor crosses the chat root
        // boundary, not when it crosses a child. e.currentTarget is the
        // chat root, e.relatedTarget is the element being entered —
        // if it's still inside our root, ignore the leave.
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        pageDragDepth.current = Math.max(0, pageDragDepth.current - 1);
        if (pageDragDepth.current === 0) setPageDragActive(false);
      }}
      onDragOver={(e) => {
        // Allow drops anywhere in the chat surface, not only on the
        // composer box. preventDefault here makes the whole chat area a
        // drop target so the user's cursor doesn't switch to the
        // "blocked" cursor in the empty middle. The composer handles
        // its own overlay; outside the composer we just let the drop
        // bubble up to the window-level handler below.
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        // If the composer caught it, this won't fire because the
        // composer calls stopPropagation... actually it doesn't; we
        // guard with `e.defaultPrevented` so a drop the composer
        // already handled won't double-upload.
        if (e.defaultPrevented) return;
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        pageDragDepth.current = 0;
        setPageDragActive(false);
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) onFiles(files);
      }}
    >
      {pageDragActive && (
        // Page-wide drop overlay. Shows whenever a file is dragged over
        // the chat surface (the composer draws its own overlay on top of
        // this one — they layer visually because the composer is a
        // sibling of this overlay). The dotted border + big icon makes
        // the drop target obvious regardless of where the cursor is.
        <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-[var(--magenta-50)]/85 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-3 rounded-[var(--r-lg)] border-2 border-dashed border-[var(--magenta)] bg-[var(--paper-3)] px-8 py-6 shadow-[var(--shadow-4)]">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-[var(--magenta-100)] text-[var(--magenta-700)]">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </div>
            <div className="text-center">
              <div className="text-sm font-semibold text-[var(--ink)]">Drop files to attach</div>
              <div className="mt-0.5 text-xs text-[var(--ink-3)]">Image, text, code, PDF — semua jenis file diterima</div>
            </div>
          </div>
        </div>
      )}
      <ChatHeader
        activeSession={activeSession}
        project={activeProject}
        stale={stale}
        info={info}
        model={model}
        onChangeModel={setModel}
        effort={effort}
        onChangeEffort={setEffort}
        modelOptions={modelOptions}
      />

      <MessageList
        messages={messages}
        toolUses={toolUses}
        attachmentsByMsg={attachmentsByMsg}
        artifactsByMsg={artifactsByMsg}
        streaming={streaming}
        showJump={showJump}
        onScroll={(gap) => setShowJump(gap > 300)}
        onJump={scrollToBottom}
        mainScrollRef={mainScrollRef}
        sessionId={sessionId}
        onRegenerate={regenerate}
      />

      <Composer
        value={input}
        onChange={setInput}
        onSend={send}
        onStop={stop}
        streaming={streaming}
        pendingAtts={pendingAtts}
        onRemoveAtt={(i) => setPendingAtts((cur) => cur.filter((_, idx) => idx !== i))}
        onAttach={pickFiles}
        onPickProject={onPickProject}
        projects={projects}
        currentProjectId={projectId}
        onManageSkills={onManageSkills}
        onFiles={(files) => onFiles(files)}
      />

      {showArtifactPanel && (
        <ArtifactPanel
          artifacts={artifacts}
          sessionId={sessionId}
          onClose={() => setShowArtifactPanel(false)}
        />
      )}

      {showSkillsModal && (
        <SkillsModal
          onClose={() => setShowSkillsModal(false)}
          currentProjectId={activeProject?.id ?? null}
          currentProjectName={activeProject?.name ?? null}
          disabledCount={
            activeProject?.id ? (activeProject as any).disabled_skills_count ?? 0 : 0
          }
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ""; }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => { onFiles(e.target.files, true); e.currentTarget.value = ""; }}
      />
    </div>
  );

  return chatArea;
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(f);
  });
}