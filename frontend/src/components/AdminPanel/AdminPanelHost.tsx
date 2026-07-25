"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { UsersDialog } from "./UsersDialog";
import { ModelsDialog } from "./ModelsDialog";
import { EmbedAdminDialog } from "./EmbedAdminDialog";
import { ApiKeysDialog } from "./ApiKeysDialog";
import { SystemPromptDialog } from "./SystemPromptDialog";
import { MemoryDialog } from "./MemoryDialog";

/**
 * AdminPanelHost — owns the currently-open admin dialog and dispatches
 * the appropriate overlay. Mounted exactly once in AppShell so any
 * "admin:open-*" event from anywhere in the tree opens the same
 * dialog (no duplicate state).
 *
 * Dialog kinds: 'users' | 'models' | 'embed' | 'api-keys' | 'prompt' | 'memory'.
 * A null state means no dialog is open; rendering is a no-op so
 * presence of the host in the tree doesn't affect performance.
 *
 * Auto-close on pathname change: when the user navigates (e.g. via the
 * New Chat button in the sidebar) the dialog closes so the new route's
 * content isn't covered by a stale modal. We compare pathname in an
 * effect, NOT on every render — opening a dialog doesn't change
 * pathname, so the dialog stays open across renders.
 */
type DialogKind = "users" | "models" | "embed" | "api-keys" | "prompt" | "memory" | null;

const KIND_EVENT: Record<Exclude<DialogKind, null>, string> = {
  users: "admin:open-users",
  models: "admin:open-models",
  embed: "admin:open-embed",
  "api-keys": "admin:open-api-keys",
  prompt: "admin:open-prompt",
  memory: "admin:open-memory",
};

export function AdminPanelHost() {
  const [open, setOpen] = useState<DialogKind>(null);
  const pathname = usePathname();

  useEffect(() => {
    function open(kind: Exclude<DialogKind, null>) {
      return () => setOpen(kind);
    }
    const handlers: Record<Exclude<DialogKind, null>, () => void> = {
      users: open("users"),
      models: open("models"),
      embed: open("embed"),
      "api-keys": open("api-keys"),
      prompt: open("prompt"),
      memory: open("memory"),
    };
    Object.entries(KIND_EVENT).forEach(([kind, evtName]) => {
      window.addEventListener(evtName, handlers[kind as Exclude<DialogKind, null>]);
    });
    return () => {
      Object.entries(KIND_EVENT).forEach(([kind, evtName]) => {
        window.removeEventListener(evtName, handlers[kind as Exclude<DialogKind, null>]);
      });
    };
  }, []);

  // Auto-close when route changes. Excludes the initial render where
  // pathname hasn't settled yet (would close a freshly-opened dialog).
  useEffect(() => {
    setOpen(null);
    // We intentionally don't depend on `open` — the effect runs whenever
    // pathname changes, which is exactly when we want to dismiss any
    // open overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function close() { setOpen(null); }

  return (
    <>
      <UsersDialog open={open === "users"} onClose={close} />
      <ModelsDialog open={open === "models"} onClose={close} />
      <EmbedAdminDialog open={open === "embed"} onClose={close} />
      <ApiKeysDialog open={open === "api-keys"} onClose={close} />
      <SystemPromptDialog open={open === "prompt"} onClose={close} />
      <MemoryDialog open={open === "memory"} onClose={close} />
    </>
  );
}