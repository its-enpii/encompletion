import { Suspense } from "react";
import Chat from "@/components/Chat";
import { AppShell } from "@/components/AppShell";

export default async function ChatByIdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await params;
  return (
    <AppShell>
      <Suspense fallback={<div className="p-6 text-[var(--paper-3)]">Memuat…</div>}>
        <Chat hideSidebar />
      </Suspense>
    </AppShell>
  );
}