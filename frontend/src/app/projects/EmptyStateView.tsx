"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export function EmptyProjectsView({
  search,
  showArchived,
  onCreate,
  onClearSearch,
}: {
  search: string;
  showArchived: boolean;
  onCreate: () => void;
  onClearSearch: () => void;
}) {
  if (search) {
    return (
      <EmptyState
        icon={
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        }
        title={`No projects match "${search}"`}
        description="Coba kata kunci lain atau hapus pencarian."
        action={<Button variant="ghost" onClick={onClearSearch}>Clear search</Button>}
      />
    );
  }
  if (showArchived) {
    return <EmptyState
      icon={<svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8H3M5 8v13h14V8M10 12h4" /></svg>}
      title="No archived projects"
      description="Project yang diarsipkan akan muncul di sini."
    />;
  }
  return (
    <EmptyState
      icon={
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      }
      title="Belum ada project"
      description="Mulai dengan membuat project pertamamu. Kamu bisa mengelompokkan session berdasarkan topik."
      action={
        <Button variant="primary" onClick={onCreate}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>New project</span>
        </Button>
      }
    />
  );
}