"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Film, Images, Loader2, Trash2, Wand2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtSec } from "@/lib/format";
import { PLATFORMS, STYLES, type Platform, type StyleId } from "@/lib/presets";
import { Button, cx, Notice, ProgressBar, StagePill } from "@/components/ui";
import { MediaPanel } from "@/components/workspace/MediaPanel";
import { PlanPanel } from "@/components/workspace/PlanPanel";
import { RenderPanel } from "@/components/workspace/RenderPanel";
import { ExportPanel } from "@/components/workspace/ExportPanel";
import { ActivityFeed, RevisionChat } from "@/components/workspace/SidePanels";
import type { ProjectDetail, SystemInfo } from "@/components/workspace/types";

type Tab = "media" | "plan" | "render" | "export";
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "media", label: "Media", icon: <Images className="h-4 w-4" /> },
  { id: "plan", label: "Creative plan", icon: <Wand2 className="h-4 w-4" /> },
  { id: "render", label: "Render & QC", icon: <Film className="h-4 w-4" /> },
  { id: "export", label: "Export", icon: <Download className="h-4 w-4" /> },
];

export default function Workspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [tab, setTab] = useState<Tab>("media");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const autoTabbed = useRef(false);
  const lastStage = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<ProjectDetail>(`/api/projects/${id}`);
      setDetail(d);
      setLoadError(null);
      // Choose a sensible tab on first load and follow the workflow as it advances.
      if (!autoTabbed.current) {
        autoTabbed.current = true;
        setTab(d.renders.some((r) => r.status === "passed") ? "render" : d.storyboard || d.project.stage === "needs_clarification" ? "plan" : "media");
      } else if (lastStage.current && lastStage.current !== d.project.stage) {
        if (d.project.stage === "plan_ready" || d.project.stage === "needs_clarification") setTab((t) => (t === "media" ? "plan" : t));
        if (d.project.stage === "rendering") setTab("render");
      }
      lastStage.current = d.project.stage;
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Could not load project");
    }
  }, [id]);

  useEffect(() => {
    void load();
    api<SystemInfo>("/api/system").then(setSys).catch(() => undefined);
  }, [load]);

  const activeJob = detail?.jobs.find((j) => j.status === "queued" || j.status === "running") ?? null;
  useEffect(() => {
    const t = setInterval(() => void load(), activeJob ? 1200 : 5000);
    return () => clearInterval(t);
  }, [load, activeJob]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  if (loadError && !detail) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Notice tone="bad" title="Project unavailable">
          {loadError}
        </Notice>
        <Link href="/" className="text-sm text-accent hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="grid h-64 place-items-center text-muted">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const p = detail.project;
  const busy = Boolean(activeJob);
  const aiOn = Boolean(sys?.ai.configured);
  const failedJob = detail.jobs[0]?.status === "failed" ? detail.jobs[0] : null;

  const del = async () => {
    if (!confirm(`Delete "${p.name}" and all its media and renders? This cannot be undone.`)) return;
    try {
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      router.push("/");
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : "Could not delete project");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate font-display text-3xl">{p.name}</h1>
            <StagePill stage={p.stage} label={p.stageLabel} />
          </div>
          <div className="mt-1 text-sm text-muted">
            {PLATFORMS[p.platform as Platform]?.label ?? p.platform} · {p.width}×{p.height} · {fmtSec(p.durationSec, 0)} · {p.fps} fps · {STYLES[p.style as StyleId]?.label ?? p.style}
            {p.silentOutput ? " · silent" : ""}
          </div>
          {p.prompt && <p className="mt-2 line-clamp-2 max-w-3xl text-sm italic text-faint">“{p.prompt}”</p>}
        </div>
        <Button variant="ghost" onClick={del} icon={<Trash2 className="h-4 w-4" />} disabled={busy}>
          Delete project
        </Button>
      </div>

      {activeJob && (
        <div className="card space-y-2 p-4" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span className="font-medium capitalize">{activeJob.type === "analyse" ? "Analysing media" : activeJob.type === "plan" ? "Planning" : activeJob.type === "revise" ? "Revising" : "Rendering"}</span>
              <span className="text-muted">{activeJob.message}</span>
            </span>
            <span className="text-xs text-faint">{Math.round(activeJob.progress * 100)}%</span>
          </div>
          <ProgressBar value={activeJob.progress} live />
        </div>
      )}
      {!activeJob && p.stage === "failed" && (
        <Notice tone="bad" title="Needs attention">
          {p.stageMessage || failedJob?.error || "The last step failed."}
        </Notice>
      )}

      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-line bg-panel p-1" aria-label="Workspace sections">
        {TABS.map((t, i) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx("focus-ring flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm transition", tab === t.id ? "bg-panel-3 text-fg shadow" : "text-muted hover:text-fg")} aria-current={tab === t.id ? "page" : undefined}>
            <span className="grid h-5 w-5 place-items-center rounded-full bg-panel-2 text-[10px] text-faint">{i + 1}</span>
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {tab === "media" && <MediaPanel detail={detail} sys={sys} busy={busy} refresh={load} onError={setToast} />}
          {tab === "plan" && <PlanPanel detail={detail} sys={sys} busy={busy} refresh={load} onError={setToast} goRender={() => setTab("render")} />}
          {tab === "render" && <RenderPanel detail={detail} activeJob={activeJob} busy={busy} refresh={load} onError={setToast} />}
          {tab === "export" && <ExportPanel detail={detail} />}
        </div>
        <aside className="space-y-4">
          <RevisionChat detail={detail} aiOn={aiOn} busy={busy} refresh={load} onError={setToast} onSent={() => setTab("render")} />
          <ActivityFeed detail={detail} />
        </aside>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2">
          <Notice tone="bad" title="Something needs your attention" action={<button onClick={() => setToast(null)} aria-label="Dismiss" className="focus-ring rounded p-1 text-muted hover:text-fg"><X className="h-4 w-4" /></button>}>
            {toast}
          </Notice>
        </div>
      )}
    </div>
  );
}
