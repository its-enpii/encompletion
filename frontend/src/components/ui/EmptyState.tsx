"use client";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--r-lg)] border border-dashed border-[var(--line-strong)] bg-[var(--paper-2)] p-10 text-center">
      {icon && (
        <div className="grid h-12 w-12 place-items-center rounded-full bg-[var(--saffron-50)] text-[var(--saffron-500)]">
          {icon}
        </div>
      )}
      <div className="text-base font-semibold text-[var(--ink)]">{title}</div>
      {description && <div className="max-w-sm text-sm text-[var(--ink-3)]">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
