"use client";

/**
 * Three dots that pulse while the assistant is generating.
 * Pure CSS via the `pulse-dot` keyframe defined in globals.css.
 */
export default function StreamingDots({ tone = "saffron" }: { tone?: "saffron" | "magenta" }) {
  const color = tone === "magenta" ? "bg-[var(--magenta)]" : "bg-[var(--saffron)]";
  return (
    <span className="inline-flex items-center gap-1.5 py-1" aria-label="Asisten sedang mengetik">
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}
