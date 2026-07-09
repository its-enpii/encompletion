import { Suspense } from "react";
import Chat from "@/components/Chat";
import { AppShell } from "@/components/AppShell";

export default function NewChatPage() {
  return (
    <AppShell>
      <Chat hideSidebar />
    </AppShell>
  );
}