"use client";

/**
 * Brand mark — diamond glyph inside a rounded square, with the wordmark.
 * Used in the sidebar (dark variant) and login (light variant).
 */
export function BrandMark({
  size = "md",
  showWord = true,
  collapsed = false,
  tone = "light",
}: {
  size?: "sm" | "md" | "lg";
  showWord?: boolean;
  /** When true the wordmark is hidden — used in sidebar mini rail. */
  collapsed?: boolean;
  /** "light" for paper surfaces, "dark" for the sidebar. */
  tone?: "light" | "dark";
}) {
  const dim =
    size === "lg" ? "h-10 w-10" : size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const text =
    size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base";

  const wordColor = tone === "dark" ? "text-[var(--dark-text)]" : "text-[var(--ink)]";
  const subColor = tone === "dark" ? "text-[var(--dark-text-3)]" : "text-[var(--ink-3)]";

  return (
    <div className="inline-flex items-center gap-2.5">
      <span
        className={`${dim} grid place-items-center rounded-[var(--r-md)] bg-gradient-to-br from-[var(--saffron-300)] to-[var(--saffron-500)] shadow-[inset_0_-2px_4px_rgba(0,0,0,0.15),0_2px_8px_rgba(232,162,43,0.30)]`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="h-1/2 w-1/2 fill-[#1A1410]">
          <path d="M12 2 L22 12 L12 22 L2 12 Z" />
        </svg>
      </span>
      {(showWord && !collapsed) && (
        <span className={`${text} font-semibold tracking-tight ${wordColor}`}>
          Enpii<span className={`ml-1 font-normal ${subColor}`}>Studio</span>
        </span>
      )}
    </div>
  );
}
