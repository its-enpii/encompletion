"use client";

type Tone =
  | "neutral"
  | "saffron"
  | "magenta"
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "dark";

const toneAttr: Record<Tone, string | undefined> = {
  neutral: undefined,
  saffron: "saffron",
  magenta: "magenta",
  success: "success",
  danger: "danger",
  warning: "warning",
  info: "info",
  dark: "dark",
};

export function Pill({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  const attr = toneAttr[tone];
  return (
    <span className={`pill ${className}`} data-tone={attr}>
      {children}
    </span>
  );
}
