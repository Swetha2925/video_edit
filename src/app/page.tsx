"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Film, Image as ImageIcon, Plus, ShieldCheck, Sparkles, Wand2 } from "lucide-react";
import { api } from "@/lib/api";
import { fmtAgo, fmtSec } from "@/lib/format";
import { STYLES, PLATFORMS, type StyleId, type Platform } from "@/lib/presets";
import { Badge, Notice, ProgressBar, StagePill } from "@/components/ui";

interface ProjectCard {
  id: string;
  name: string;
  stage: string;
  stageLabel: string;
  style: string;
  platform: string;
  durationSec: number;
  width: number;
  height: number;
  updatedAt: string;
  assetCount: number;
  renderCount: number;
  coverAssetId: string | null;
  latestRender: { version: number; status: string } | null;
  activeJob: { type: string; progress: number; message: string } | null;
}

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ projects: ProjectCard[] }>("/api/projects")
      .then((d) => {
        setProjects(d.projects);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-10">
      <section className="card relative overflow-hidden p-8 sm:p-10">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 right-40 h-64 w-64 rounded-full bg-gold/10 blur-3xl" />
        <div className="relative max-w-2xl">
          <Badge tone="accent">
            <Sparkles className="h-3 w-3" /> AI creative director · editor · QC reviewer
          </Badge>
          <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
            Give us your idea and your media.
            <br />
            <span className="text-gradient">We plan, edit, review and render.</span>
          </h1>
          <p className="mt-4 text-muted">
            Upload photos, images and clips, describe the video you want, and ReelCraft&apos;s agent builds a storyboard, renders a real MP4 with FFmpeg, inspects the result and fixes what it finds.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/projects/new" className="btn-primary focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-medium text-white">
              <Plus className="h-4 w-4" /> Start a new video
            </Link>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            {[
              { icon: <Wand2 className="h-4 w-4 text-accent" />, t: "Plans before rendering", d: "Brief + storyboard you approve" },
              { icon: <Film className="h-4 w-4 text-accent-2" />, t: "Real rendering", d: "FFmpeg, 1080×1920 H.264/AAC" },
              { icon: <ShieldCheck className="h-4 w-4 text-gold" />, t: "Quality-checked", d: "Measured, never assumed" },
            ].map((f) => (
              <div key={f.t} className="flex items-start gap-2.5 rounded-xl border border-line bg-panel/60 p-3">
                <div className="mt-0.5">{f.icon}</div>
                <div>
                  <div className="text-fg">{f.t}</div>
                  <div className="text-xs text-faint">{f.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="font-display text-2xl">Recent projects</h2>
          {projects && projects.length > 0 && <span className="text-sm text-muted">{projects.length} project{projects.length === 1 ? "" : "s"}</span>}
        </div>
        {error && <Notice tone="bad" title="Could not load projects">{error}</Notice>}
        {projects === null && !error && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card h-56 animate-pulse" />
            ))}
          </div>
        )}
        {projects && projects.length === 0 && (
          <div className="card flex flex-col items-center justify-center gap-3 p-12 text-center">
            <Clapperboard className="h-10 w-10 text-faint" />
            <div className="text-fg">No projects yet</div>
            <p className="max-w-sm text-sm text-muted">Create your first project to upload media and let the agent build your reel.</p>
            <Link href="/projects/new" className="btn-primary focus-ring mt-2 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white">
              <Plus className="h-4 w-4" /> New project
            </Link>
          </div>
        )}
        {projects && projects.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="card focus-ring group overflow-hidden transition hover:border-line-strong">
                <div className="relative h-36 overflow-hidden bg-panel-2">
                  {p.coverAssetId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/projects/${p.id}/assets/${p.coverAssetId}/thumbnail`} alt="" className="h-full w-full object-cover opacity-80 transition group-hover:scale-105 group-hover:opacity-100" />
                  ) : (
                    <div className="grid h-full place-items-center text-faint">
                      <ImageIcon className="h-8 w-8" />
                    </div>
                  )}
                  <div className="absolute left-3 top-3">
                    <StagePill stage={p.stage} label={p.stageLabel} />
                  </div>
                </div>
                <div className="space-y-2 p-4">
                  <div className="truncate font-medium text-fg">{p.name}</div>
                  <div className="flex flex-wrap gap-1.5 text-xs text-muted">
                    <span>{PLATFORMS[p.platform as Platform]?.label ?? p.platform}</span>·<span>{fmtSec(p.durationSec, 0)}</span>·<span>{STYLES[p.style as StyleId]?.label ?? p.style}</span>
                  </div>
                  {p.activeJob ? (
                    <div className="space-y-1">
                      <ProgressBar value={p.activeJob.progress} live />
                      <div className="truncate text-xs text-muted">{p.activeJob.message}</div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between text-xs text-faint">
                      <span>
                        {p.assetCount} files · {p.renderCount} render{p.renderCount === 1 ? "" : "s"}
                      </span>
                      <span>{fmtAgo(p.updatedAt)}</span>
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
