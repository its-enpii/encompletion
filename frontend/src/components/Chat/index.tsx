"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useParams, useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";
import { authFetch, useAuth } from "@/lib/auth";
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
  const { toast } = useUi();
  void toast;

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

  const [messages, setMessages] = useState<Msg[]>([]);
  const [toolUses, setToolUses] = useState<ToolUse[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [attachmentsByMsg, setAttachmentsByMsg] = useState<Record<number, Att[]>>({});

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [model, setModel] = useState("workspace");
  const [effort, setEffort] = useState("high");

  const [projects, setProjects] = useState<Project[]>([]);
  const [pendingAtts, setPendingAtts] = useState<PendingAtt[]>([]);
  const [showArtifactPanel, setShowArtifactPanelRaw] = useState(false);
  function setShowArtifactPanel(v: boolean) {
    setShowArtifactPanelRaw(v);
    setStored("artifacts:open", v ? "1" : "0");
  }
  useEffect(() => {
    const v = getStored("artifacts:open");
    if (v === "1") setShowArtifactPanelRaw(true);
  }, []);

  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

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

  async function loadSession(id: number) {
    try {
      // Backend exposes a single `/full` endpoint that bundles session +
      // messages + tool_uses + artifacts + attachments in one round-trip.
      const data = await authFetch(`/api/sessions/${id}/full`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      const s = data.session;
      const m = data.messages || [];
      const t = data.tool_uses || [];
      const a = data.artifacts || [];
      const atts = data.attachments || [];
      // Group attachments by message_id for MessageList lookup.
      const attMap: Record<number, Att[]> = {};
      for (const att of atts) {
        (attMap[att.message_id] ||= []).push(att);
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
      setMessages(m);
      setToolUses(t);
      setArtifacts((a as Artifact[]).filter((x) => !x.dup_of));
      setAttachmentsByMsg(attMap);
      setError(null);
      setUsage(null);
      setInfo(null);
      scrollToBottom();
    } catch (e: any) {
      setError(e?.message || "Gagal load session");
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
    loadSession(sessionId);
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

  // Socket streaming.
  useEffect(() => {
    const socket = getSocket();

    function onTick(payload: { session_id: number }) {
      if (payload.session_id === sessionId) {
        setLastTickAt(Date.now());
        setStale(false);
      }
    }
    function onChunk(payload: { session_id: number; delta: string; message_id?: number }) {
      if (payload.session_id !== sessionId) return;
      setMessages((cur) => {
        const last = cur[cur.length - 1];
        if (!last || last.role !== "assistant" || last.id !== payload.message_id) return cur;
        return [...cur.slice(0, -1), { ...last, content: last.content + payload.delta }];
      });
    }
    function onToolUse(payload: { session_id: number; tool: ToolUse }) {
      if (payload.session_id !== sessionId) return;
      setToolUses((cur) => [...cur, payload.tool]);
    }
    function onArtifact(payload: { session_id: number; artifact: Artifact }) {
      if (payload.session_id !== sessionId) return;
      setArtifacts((cur) => [...cur, payload.artifact]);
    }
    function onUsage(payload: { session_id: number; usage: Usage }) {
      if (payload.session_id !== sessionId) return;
      setUsage(payload.usage);
    }
    function onDone(payload: { session_id: number }) {
      if (payload.session_id !== sessionId) return;
      setStreaming(false);
      setLastTickAt(null);
      setSidebarRefresh((s) => s + 1);
    }
    function onError(payload: { session_id: number; message: string }) {
      if (payload.session_id !== sessionId) return;
      setError(payload.message);
      setStreaming(false);
    }

    socket.on("tick", onTick);
    socket.on("chunk", onChunk);
    socket.on("tool_use", onToolUse);
    socket.on("artifact", onArtifact);
    socket.on("usage", onUsage);
    socket.on("done", onDone);
    socket.on("error_evt", onError);

    return () => {
      socket.off("tick", onTick);
      socket.off("chunk", onChunk);
      socket.off("tool_use", onToolUse);
      socket.off("artifact", onArtifact);
      socket.off("usage", onUsage);
      socket.off("done", onDone);
      socket.off("error_evt", onError);
    };
  }, [sessionId]);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = mainScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  const [showJump, setShowJump] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    setUsage(null);
    setStreaming(true);
    setLastTickAt(Date.now());
    setStale(false);
    try {
      const r = await authFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          project_id: projectId,
          model,
          effort,
          attachments: pendingAtts.map((a) => ({ file_name: a.file_name, mime_type: a.mime_type, size: a.size, content: a.content, file_path: a.file_path })),
        }),
      });
      setPendingAtts([]);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const newId = data.session_id ?? data.id;
      if (!sessionId && newId) {
        router.push(`/chat/${newId}`);
      }
      setSidebarRefresh((s) => s + 1);
    } catch (e: any) {
      setError(e?.message || "Gagal kirim");
      setStreaming(false);
    }
  }

  function stop() {
    if (sessionId == null) return;
    authFetch(`/api/sessions/${sessionId}/stop`, { method: "POST" }).catch(() => {});
    setStreaming(false);
  }

  function pickFiles() { fileInputRef.current?.click(); }
  function capturePhoto() { cameraInputRef.current?.click(); }

  async function onFiles(files: FileList | null, fromCamera = false) {
    if (!files) return;
    for (const f of Array.from(files)) {
      const dataUrl = await readAsDataUrl(f).catch(() => "");
      setPendingAtts((cur) => [
        ...cur,
        {
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
    // not loading. Generic labels — operators configure real options via
    // /models. Avoid leaking upstream model names here on purpose.
    return registryLoading
      ? [{ value: "workspace", label: "Workspace" }]
      : [
          { value: "workspace", label: "Workspace" },
          { value: "standard", label: "Standard" },
          { value: "fast", label: "Fast" },
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
  // re-trigger the socket prompt with `regenerate: true` so the server reuses
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

    setError(null);
    setUsage(null);
    setStreaming(true);
    setLastTickAt(Date.now());
    setStale(false);

    try {
      const socket = getSocket();
      socket.emit(
        "prompt",
        {
          prompt: lastUser.content,
          model,
          sessionId,
          projectId,
          effort,
          regenerate: true,
        },
        () => {}
      );
    } catch (e: any) {
      setError(e?.message || "Gagal regenerate");
      setStreaming(false);
    }
  }

  // The composable chat area.
  const chatArea = (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--paper)]">
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
      />

      {showArtifactPanel && (
        <ArtifactPanel
          artifacts={artifacts}
          onClose={() => setShowArtifactPanel(false)}
        />
      )}

      {showSkillsModal && <SkillsModal onClose={() => setShowSkillsModal(false)} />}

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