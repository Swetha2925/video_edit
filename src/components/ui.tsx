"use client";

import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", loading, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; icon?: ReactNode }) {
  const base = "focus-ring inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles: Record<Variant, string> = {
    primary: "btn-primary text-white",
    secondary: "border border-line-strong bg-panel-2 text-fg hover:bg-panel-3",
    ghost: "text-muted hover:bg-panel-2 hover:text-fg",
    danger: "border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
  };
  return (
    <button className={cx(base, styles[variant], className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, className, title }: { tone?: "neutral" | "ok" | "warn" | "bad" | "accent" | "gold"; children: ReactNode; className?: string; title?: string }) {
  const tones = {
    neutral: "border-line-strong bg-panel-3 text-muted",
    ok: "border-ok/30 bg-ok/10 text-ok",
    warn: "border-warn/30 bg-warn/10 text-warn",
    bad: "border-bad/30 bg-bad/10 text-bad",
    accent: "border-accent/30 bg-accent/10 text-accent",
    gold: "border-gold/30 bg-gold/10 text-gold",
  } as const;
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "ok" | "warn" | "bad"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const map = {
    info: { cls: "border-accent/25 bg-accent/5", icon: <Info className="h-4 w-4 text-accent" /> },
    ok: { cls: "border-ok/25 bg-ok/5", icon: <CheckCircle2 className="h-4 w-4 text-ok" /> },
    warn: { cls: "border-warn/25 bg-warn/5", icon: <AlertTriangle className="h-4 w-4 text-warn" /> },
    bad: { cls: "border-bad/30 bg-bad/5", icon: <XCircle className="h-4 w-4 text-bad" /> },
  }[tone];
  return (
    <div className={cx("flex items-start gap-3 rounded-xl border p-3.5 text-sm", map.cls)} role={tone === "bad" ? "alert" : "status"}>
      <div className="mt-0.5 shrink-0">{map.icon}</div>
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium text-fg">{title}</div>}
        {children && <div className="mt-0.5 text-muted">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, live }: { value: number; live?: boolean }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-panel-3" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width] duration-500", live ? "progress-live" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputCls = "focus-ring w-full rounded-xl border border-line-strong bg-panel-2 px-3.5 py-2.5 text-sm text-fg placeholder:text-faint";

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="focus-ring flex w-full items-start gap-3 rounded-xl border border-line bg-panel-2 p-3 text-left">
      <span className={cx("mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition", checked ? "bg-accent" : "bg-line-strong")}>
        <span className={cx("h-4 w-4 rounded-full bg-white transition", checked ? "translate-x-4" : "translate-x-0")} />
      </span>
      <span>
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
    </button>
  );
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-xl text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function StagePill({ stage, label }: { stage: string; label: string }) {
  const tone = stage === "completed" ? "ok" : stage === "failed" ? "bad" : stage === "needs_clarification" || stage === "plan_ready" ? "gold" : ["analysing", "planning", "rendering"].includes(stage) ? "accent" : "neutral";
  return (
    <Badge tone={tone}>
      {["analysing", "planning", "rendering"].includes(stage) && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </Badge>
  );
}
