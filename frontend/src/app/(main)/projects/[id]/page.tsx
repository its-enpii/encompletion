"use client";

import { use } from "react";
import Chat from "@/components/Chat";
import ProjectConfigPanel from "@/components/ProjectConfigPanel";
import { MobileProjectSettingsButton } from "./MobileProjectSettingsButton";

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const projectId = Number(id);

  return (
    <>
      <div className="flex h-full min-h-0 flex-1">
        <div className="flex min-w-0 flex-1">
          <Chat hideSidebar initialProjectId={projectId} />
        </div>
        <ProjectConfigPanel projectId={projectId} />
      </div>
      <MobileProjectSettingsButton />
    </>
  );
}