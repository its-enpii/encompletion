"use client";

import { use } from "react";
import Chat from "@/components/Chat";
import ProjectConfigPanel from "@/components/ProjectConfigPanel";
import { MobileProjectSettingsButton } from "../../MobileProjectSettingsButton";

export default function ProjectChatSessionPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = use(params);
  const projectId = Number(id);
  const initialSessionId = Number(sessionId);

  return (
    <>
      <div className="flex h-full min-h-0 flex-1">
        <div className="flex min-w-0 flex-1">
          <Chat hideSidebar initialSessionId={initialSessionId} initialProjectId={projectId} />
        </div>
        <ProjectConfigPanel projectId={projectId} />
      </div>
      <MobileProjectSettingsButton />
    </>
  );
}