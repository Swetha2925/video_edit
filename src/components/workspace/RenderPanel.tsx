"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, Film, Loader2, Play, RotateCcw, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtSec } from "@/lib/format";
import { Badge, Button, cx, Notice, ProgressBar, SectionTitle } from "../ui";
import { QualityReportView } from "./QualityReportView";
import type { JobView, ProjectDetail, RenderView } from "./types";

export function renderTone(s: string): "ok" | "bad" | "accent" | "neutral" {
  return s === "passed" ? "ok" : s === "failed" || s === "cancelled" ? "bad" : s === "rendering" || s === "checking" ? "accent" : "neutral";
}

export function RenderPanel({ detail, activeJob, busy, refresh, onError }: { detail: ProjectDetail; activeJob: JobView | null; busy: boolean; refresh: () => void; onError: (m: string) => void }) {
  const pid = detail.project.id;
  const [selected, setSelected] = useState<number | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const renders = detail.renders;
  useEffect(() => {
    if (selected === null && renders[0]) setSelected(renders[0].version);
  }, [renders, selected]);
  // Jump to the newest render when a new one appears.
  const newest = renders[0]?.version;
  useEffect(() => {
    if (newest) setSelected(newest);
  }, [newest]);
  const current: RenderView | undefined = renders.find((r) => r.version === selected) ?? renders[0];

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setActing(label);
    try {
      await fn();
      refresh();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  };

  const vertical = detail.project.height > detail.project.width;
  return (
    <div className="space-y-6">
      <SectionTitle
        title="Render & quality report"
        subtitle="Every render is a new version — nothing is overwritten. A render only counts as successful after the checks below pass on the real file."
        right={
          detail.storyboard && (
            <Button variant="primary" disabled={busy} loading={acting === "render"} onClick={() => act("render", () => api(`/api/projects/${pid}/render`, { method: "POST", json: { storyboardVersion: detail.storyboard?.version } }))} icon={<Play className="h-4 w-4" />}>
              Render storyboard v{detail.storyboard.version}
            </Button>
          )
        }
      />

      {activeJob && (activeJob.type === "render" || activeJob.type === "revise" || activeJob.type === "plan") && (
        <div className="card space-y-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span className="font-medium capitalize">{activeJob.type === "revise" ? "Applying your feedback" : activeJob.type === "plan" ? "Planning" : "Rendering"}</span>
              <span className="text-muted">— {activeJob.message}</span>
            </div>
            <Button variant="ghost" className="px-2 py-1 text-xs" loading={acting === "cancel"} onClick={() => act("cancel", () => api(`/api/projects/${pid}/jobs/${activeJob.id}/cancel`, { method: "POST" }))} icon={<Ban className="h-3.5 w-3.5" />}>
              Cancel
            </Button>
          </div>
          <ProgressBar value={activeJob.progress} live />
          <div className="text-right text-xs text-faint">{Math.round(activeJob.progress * 100)}% · progress reported by FFmpeg</div>
        </div>
      )}

      {renders.length === 0 && !activeJob && (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Film className="h-8 w-8 text-faint" />
          <div>No renders yet</div>
          <p className="text-sm text-muted">Approve a plan to render your first version.</p>
        </div>
      )}

      {renders.length > 0 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <div className="space-y-4">
            {current && current.hasFile && (current.status === "passed" || current.status === "failed") ? (
              <video key={current.version} controls playsInline preload="metadata" className={cx("w-full rounded-2xl border border-line bg-black", vertical ? "aspect-[9/16]" : "aspect-video")} src={`/api/projects/${pid}/renders/${current.version}/video`} />
            ) : (
              <div className={cx("grid w-full place-items-center rounded-2xl border border-line bg-panel-2 text-sm text-muted", vertical ? "aspect-[9/16]" : "aspect-video")}>
                {current?.status === "rendering" || current?.status === "checking" ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> {current.status === "checking" ? "Running quality checks…" : "Rendering…"}
                  </span>
                ) : (
                  <span className="px-6 text-center">{current?.error ?? "No playable file for this version."}</span>
                )}
              </div>
            )}
            <div className="card divide-y divide-line">
              {renders.map((r) => (
                <button key={r.id} onClick={() => setSelected(r.version)} className={cx("focus-ring flex w-full items-center justify-between gap-3 p-3 text-left text-sm", r.version === current?.version ? "bg-panel-3" : "hover:bg-panel-2")}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">v{r.version}</span>
                      <Badge tone={renderTone(r.status)}>
                        {r.status === "passed" ? <CheckCircle2 className="h-3 w-3" /> : r.status === "failed" ? <XCircle className="h-3 w-3" /> : r.status === "cancelled" ? <Ban className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
                        {r.status === "passed" && r.qc?.status === "passed_with_warnings" ? "passed · warnings" : r.status}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-faint">
                      {r.label} · {fmtAgo(r.createdAt)}
                      {r.renderMs ? ` · rendered in ${fmtSec(r.renderMs / 1000, 0)}` : ""}
                    </div>
                  </div>
                  {r.autoFixAttempt > 0 && <Badge tone="gold">auto-fix</Badge>}
                </button>
              ))}
            </div>
          </div>
          <div>
            {current?.qc ? (
              <QualityReportView report={current.qc} projectId={pid} />
            ) : current?.status === "failed" || current?.status === "cancelled" ? (
              <div className="space-y-3">
                <Notice tone="bad" title={`Render v${current.version} ${current.status}`}>
                  {current.error ?? "The render did not complete."}
                </Notice>
                {detail.storyboard && (
                  <Button disabled={busy} onClick={() => act("render", () => api(`/api/projects/${pid}/render`, { method: "POST", json: { storyboardVersion: detail.storyboard?.version } }))} icon={<RotateCcw className="h-4 w-4" />}>
                    Retry render
                  </Button>
                )}
              </div>
            ) : (
              <Notice tone="info" title="Quality report">
                The report appears when rendering and checks finish.
              </Notice>
            )}
            {current?.status === "failed" && current.qc && (
              <div className="mt-4">
                <Notice tone="warn" title="This version did not pass">
                  <span className="flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" /> It is kept for comparison but can&apos;t be exported. Describe a fix in the revision box or retry.
                  </span>
                </Notice>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
