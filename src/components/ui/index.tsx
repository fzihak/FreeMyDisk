/**
 * FreeMyDisk UI kit: the shared building blocks every page uses, so pages look
 * and behave the same. Colours come from the tokens in index.css.
 */
import React from "react";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ Page */

/** Standard page container: centred, max 1100 px wide, consistent padding. */
export const Page: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cx("px-6 py-6 max-w-[1100px] mx-auto space-y-5", className)}>{children}</div>
);

interface PageHeaderProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons shown on the right. */
  actions?: React.ReactNode;
}

/** Page title row: optional icon tile, title, one-line description, actions on the right. */
export const PageHeader: React.FC<PageHeaderProps> = ({ icon, title, description, actions }) => (
  <header className="flex items-start justify-between gap-4">
    <div className="flex items-start gap-4 min-w-0">
      {icon && (
        <div className="w-10 h-10 shrink-0 rounded-lg bg-[var(--bg-card)] border border-[var(--border-card)] flex items-center justify-center text-[var(--accent-text)] [&_svg]:w-5 [&_svg]:h-5">
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <h1 className="text-[28px] leading-9 font-semibold text-[var(--text-primary)] truncate">{title}</h1>
        {description && <p className="text-sm text-[var(--text-secondary)] mt-0.5">{description}</p>}
      </div>
    </div>
    {actions && <div className="flex items-center gap-2 shrink-0 pt-1">{actions}</div>}
  </header>
);

/** Small section title above a group of cards. */
export const SectionTitle: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="flex items-center justify-between pt-1">
    <h2 className="text-sm font-semibold text-[var(--text-primary)]">{children}</h2>
    {action}
  </div>
);

/* ------------------------------------------------------------------ Card */

export const Card: React.FC<React.HTMLAttributes<HTMLDivElement> & { padded?: boolean }> = ({
  className,
  padded = true,
  children,
  ...rest
}) => (
  <div
    className={cx(
      "bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg shadow-[var(--shadow-card)]",
      padded && "p-4",
      className
    )}
    {...rest}
  >
    {children}
  </div>
);

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const toneText: Record<Tone, string> = {
  neutral: "text-[var(--text-primary)]",
  accent: "text-[var(--accent-text)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--brand-amber)]",
  danger: "text-[var(--danger)]",
};

interface StatCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** Colour of the value. Use colour only when it carries meaning. */
  tone?: Tone;
}

/** One number with a label and an optional hint underneath. */
export const StatCard: React.FC<StatCardProps> = ({ label, value, hint, icon, tone = "neutral" }) => (
  <Card className="min-w-0">
    <div className="flex items-center justify-between gap-2 text-sm text-[var(--text-secondary)]">
      <span className="truncate">{label}</span>
      {icon && <span className="shrink-0 text-[var(--text-muted)] [&_svg]:w-4 [&_svg]:h-4">{icon}</span>}
    </div>
    <div className={cx("mt-1 text-2xl font-semibold font-ibm-mono truncate", toneText[tone])}>{value}</div>
    {hint && <div className="mt-0.5 text-xs text-[var(--text-muted)] truncate">{hint}</div>}
  </Card>
);

/* ------------------------------------------------------------------ Badge */

const badgeTone: Record<Tone, string> = {
  neutral: "bg-[var(--fill-subtle)] text-[var(--text-secondary)]",
  accent: "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent-text)]",
  success: "bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success)]",
  warning: "bg-[color-mix(in_srgb,var(--brand-amber)_16%,transparent)] text-[var(--brand-amber)]",
  danger: "bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] text-[var(--danger)]",
};

export const Badge: React.FC<{ tone?: Tone; children: React.ReactNode; className?: string }> = ({
  tone = "neutral",
  children,
  className,
}) => (
  <span className={cx("inline-flex items-center gap-1 h-5 px-2 rounded text-xs font-medium whitespace-nowrap", badgeTone[tone], className)}>
    {children}
  </span>
);

/** Maps a cleanup rule risk level to a badge tone. */
export const riskTone = (risk: string): Tone =>
  risk === "safe" ? "success" : risk === "caution" || risk === "moderate" ? "warning" : risk === "danger" || risk === "high" ? "danger" : "neutral";

/* ------------------------------------------------------------------ Progress */

export const ProgressBar: React.FC<{ value: number; tone?: Tone; className?: string }> = ({
  value,
  tone = "accent",
  className,
}) => {
  const fill =
    tone === "danger"
      ? "bg-[var(--danger-fill)]"
      : tone === "warning"
      ? "bg-[var(--brand-amber)]"
      : tone === "success"
      ? "bg-[var(--success)]"
      : "bg-[var(--accent)]";
  return (
    <div className={cx("h-1 w-full rounded-full bg-[var(--fill-subtle)] overflow-hidden", className)}>
      <div className={cx("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
};

/* ------------------------------------------------------------------ Tabs */

export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  count?: React.ReactNode;
}

/** Horizontal filter tabs. Scrolls without a visible scrollbar when space runs out. */
export function FilterTabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            onClick={() => onChange(it.id)}
            className={cx(
              "h-8 px-3 rounded-md text-sm whitespace-nowrap transition-colors inline-flex items-center gap-2",
              active
                ? "bg-[var(--fill-subtle-hover)] text-[var(--text-primary)] font-medium"
                : "text-[var(--text-secondary)] hover:bg-[var(--fill-subtle)] hover:text-[var(--text-primary)]"
            )}
          >
            {it.label}
            {it.count !== undefined && <span className="text-xs text-[var(--text-muted)] font-ibm-mono">{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Empty / Action bar */

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action }) => (
  <Card className="py-12 flex flex-col items-center text-center gap-2">
    {icon && <div className="text-[var(--text-muted)] mb-1 [&_svg]:w-8 [&_svg]:h-8">{icon}</div>}
    <div className="text-base font-semibold text-[var(--text-primary)]">{title}</div>
    {description && <div className="text-sm text-[var(--text-secondary)] max-w-md">{description}</div>}
    {action && <div className="mt-3">{action}</div>}
  </Card>
);

/** Sticky bar at the bottom of a list: what is selected, and the main action. */
export const ActionBar: React.FC<{ summary: React.ReactNode; children: React.ReactNode }> = ({ summary, children }) => (
  <div className="sticky bottom-0 z-10 -mx-6 px-6 py-3 bg-[var(--bg-page)]/95 backdrop-blur border-t border-[var(--border-divider)] flex items-center justify-between gap-4">
    <div className="text-sm text-[var(--text-secondary)] min-w-0 truncate">{summary}</div>
    <div className="flex items-center gap-2 shrink-0">{children}</div>
  </div>
);
