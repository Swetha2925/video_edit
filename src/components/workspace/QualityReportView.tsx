"use client";

import { AlertTriangle, CheckCircle2, CircleHelp, MinusCircle, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import type { CheckResult, QualityReport } from "@/lib/schemas";
import { fmtBytes, fmtSec } from "@/lib/format";
import { Badge, cx } from "../ui";

function StatusIcon({ s }: { s: CheckResult["status"] }) {
  if (s === "pass") return <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-label="pass" />;
  if (s === "fail") return <XCircle className="h-4 w-4 shrink-0 text-bad" aria-label="fail" />;
  if (s === "warn") return <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-label="warning" />;
  return <MinusCircle className="h-4 w-4 shrink-0 text-faint" aria-label="skipped" />;
}

function CheckList({ title, checks }: { title: string; checks: CheckResult[] }) {
  if (checks.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs uppercase tracking-wider text-faint">{title}</div>
      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-sm">
            <StatusIcon s={c.status} />
            <div className="min-w-0">
              <div className="text-fg">{c.label}</div>
              <div className="break-words text-xs text-faint">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const RATING: Record<string, { tone: "ok" | "warn" | "bad" | "neutral"; label: string }> = {
  good: { tone: "ok", label: "Good" },
  needs_review: { tone: "warn", label: "Needs review" },
  poor: { tone: "bad", label: "Poor" },
  not_assessed: { tone: "neutral", label: "Not assessed" },
};

export function QualityReportView({ report, projectId }: { report: QualityReport; projectId: string }) {
  const banner =
    report.status === "passed"
      ? { cls: "border-ok/30 bg-ok/5", icon: <ShieldCheck className="h-5 w-5 text-ok" />, text: "Passed all quality checks" }
      : report.status === "passed_with_warnings"
        ? { cls: "border-warn/30 bg-warn/5", icon: <AlertTriangle className="h-5 w-5 text-warn" />, text: "Passed with warnings" }
        : { cls: "border-bad/30 bg-bad/5", icon: <XCircle className="h-5 w-5 text-bad" />, text: "Did not pass quality checks" };
  const cr = report.creativeReview;
  return (
    <div className="space-y-5">
      <div className={cx("flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4", banner.cls)}>
        <div className="flex items-center gap-2.5">
          {banner.icon}
          <div>
            <div className="font-medium text-fg">{banner.text}</div>
            <div className="text-xs text-muted">Measured from the rendered file · {report.qualityLabel}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge>
            {report.output.width}×{report.output.height}
          </Badge>
          <Badge>{report.output.fps} fps</Badge>
          <Badge>{fmtSec(report.output.durationSec, 2)}</Badge>
          <Badge>
            {report.output.videoCodec?.toUpperCase()}
            {report.output.audioCodec ? ` / ${report.output.audioCodec.toUpperCase()}` : " / no audio"}
          </Badge>
          <Badge>{fmtBytes(report.output.sizeBytes)}</Badge>
          {report.output.bitrateKbps && <Badge>{(report.output.bitrateKbps / 1000).toFixed(1)} Mbps</Badge>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <CheckList title="Technical" checks={report.technicalChecks} />
        <CheckList title="Audio" checks={report.audioChecks} />
        <CheckList title="Visual (automated)" checks={report.visualChecks} />
      </div>

      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-accent" />
          <span className="font-medium">Creative review</span>
          <span className="text-xs text-faint">{cr.assessedBy === "claude_vision" ? "Claude vision on frames from the actual render — automated review is imperfect" : "Not available"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(
            [
              ["Opening hook", cr.openingHook],
              ["Caption readability", cr.captionReadability],
              ["Visual consistency", cr.visualConsistency],
              ["Composition", cr.composition],
              ["Ending", cr.ending],
            ] as const
          ).map(([label, r]) => (
            <div key={label} className="rounded-lg bg-panel-2 p-2.5">
              <div className="text-[11px] text-faint">{label}</div>
              <Badge tone={RATING[r]?.tone ?? "neutral"} className="mt-1">
                {RATING[r]?.label ?? r}
              </Badge>
            </div>
          ))}
        </div>
        {cr.summary && <p className="mt-3 text-sm text-muted">{cr.summary}</p>}
      </div>

      {report.issues.length > 0 && (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wider text-faint">Findings</div>
          <ul className="space-y-2">
            {report.issues.map((i, idx) => (
              <li key={idx} className="flex items-start gap-2.5 rounded-xl border border-line bg-panel-2 p-3 text-sm">
                <Badge tone={i.severity === "high" ? "bad" : i.severity === "medium" ? "warn" : "neutral"}>{i.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-fg">
                    {i.description}
                    {i.timeSec !== null && <span className="text-faint"> · at {i.timeSec.toFixed(1)}s</span>}
                    {i.sceneId && <span className="text-faint"> · scene {i.sceneId}</span>}
                  </div>
                  <div className="text-xs text-muted">Fix: {i.suggestedFix}</div>
                </div>
                <span className="flex items-center gap-1 text-[11px] text-faint" title="How certain this finding is">
                  {i.certainty === "uncertain" && <CircleHelp className="h-3 w-3" />}
                  {i.source} · {i.certainty}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.recommendations.length > 0 && (
        <div className="text-sm">
          <div className="mb-1 text-xs uppercase tracking-wider text-faint">Recommendations</div>
          <ul className="list-disc space-y-0.5 pl-5 text-muted">
            {report.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {report.contactSheet && (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wider text-faint">Frames reviewed from the render</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/projects/${projectId}/${report.contactSheet}`} alt="Frames sampled from the rendered video" className="w-full rounded-xl border border-line" />
        </div>
      )}
    </div>
  );
}
