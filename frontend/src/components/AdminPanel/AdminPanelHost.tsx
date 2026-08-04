"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { UsersDialog } from "./UsersDialog";
import { RolesDialog } from "./RolesDialog";
import { SystemPromptDialog } from "./SystemPromptDialog";
import { MemoryDialog } from "./MemoryDialog";
import { LlmSettingsDialog } from "./LlmSettingsDialog";

/**
 * AdminPanelHost — owns the currently-open admin dialog and dispatches
 * the appropriate overlay. Mounted exactly once in AppShell.
 *
 * Dialog kinds:
 *   users | roles | prompt | memory — admin/user settings.
 *   llm                            — per-user AI Settings (every user).
 *
 * ModelsDialog was removed when the global registry went away; every
 * user now manages their own list through LlmSettingsDialog.
 *
 * Two event names map to the same dialog:
 *   "admin:open-llm"        — historical admin-only event (kept for compat).
 *   "app:open-llm-settings" — new user-facing event, dispatched from
 *                             the chat header / onboarding when the
 *                             user wants to edit their config.
 */
type DialogKind = "users" | "roles" | "prompt" | "memory" | "llm" | null;

const KIND_EVENT: Record<Exclude<DialogKind, null>, string[]> = {
  users: ["admin:open-users"],
  roles: ["admin:open-roles"],
  prompt: ["admin:open-prompt"],
  memory: ["admin:open-memory"],
  llm: ["admin:open-llm", "app:open-llm-settings"],
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
      roles: open("roles"),
      prompt: open("prompt"),
      memory: open("memory"),
      llm: open("llm"),
    };
    const cleanups: Array<() => void> = [];
    for (const [kind, evtNames] of Object.entries(KIND_EVENT)) {
      for (const evtName of evtNames) {
        window.addEventListener(evtName, handlers[kind as Exclude<DialogKind, null>]);
        cleanups.push(() => window.removeEventListener(evtName, handlers[kind as Exclude<DialogKind, null>]));
      }
    }
    return () => {
      for (const c of cleanups) c();
    };
  }, []);

  useEffect(() => {
    setOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function close() { setOpen(null); }

  return (
    <>
      <UsersDialog open={open === "users"} onClose={close} />
      <RolesDialog open={open === "roles"} onClose={close} />
      <SystemPromptDialog open={open === "prompt"} onClose={close} />
      <MemoryDialog open={open === "memory"} onClose={close} />
      <LlmSettingsDialog open={open === "llm"} onClose={close} />
    </>
  );
}