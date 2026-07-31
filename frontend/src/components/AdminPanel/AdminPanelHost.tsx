"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { UsersDialog } from "./UsersDialog";
import { ModelsDialog } from "./ModelsDialog";
import { RolesDialog } from "./RolesDialog";
import { SystemPromptDialog } from "./SystemPromptDialog";
import { MemoryDialog } from "./MemoryDialog";

/**
 * AdminPanelHost — owns the currently-open admin dialog and dispatches
 * the appropriate overlay. Mounted exactly once in AppShell.
 *
 * Dialog kinds: 'users' | 'roles' | 'models' | 'prompt' | 'memory'.
 */
type DialogKind = "users" | "roles" | "models" | "prompt" | "memory" | null;

const KIND_EVENT: Record<Exclude<DialogKind, null>, string> = {
  users: "admin:open-users",
  roles: "admin:open-roles",
  models: "admin:open-models",
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
      roles: open("roles"),
      models: open("models"),
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

  useEffect(() => {
    setOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function close() { setOpen(null); }

  return (
    <>
      <UsersDialog open={open === "users"} onClose={close} />
      <RolesDialog open={open === "roles"} onClose={close} />
      <ModelsDialog open={open === "models"} onClose={close} />
      <SystemPromptDialog open={open === "prompt"} onClose={close} />
      <MemoryDialog open={open === "memory"} onClose={close} />
    </>
  );
}