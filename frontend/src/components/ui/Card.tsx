"use client";

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  className?: string;
  children: React.ReactNode;
  /** Add the hover lift effect. */
  hover?: boolean;
};

export function Card({ className = "", children, hover = false, ...rest }: CardProps) {
  return (
    <div
      className={`card ${hover ? "card-hover" : ""} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className = "",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-[var(--ink)] tracking-tight">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-[var(--ink-2)]">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
