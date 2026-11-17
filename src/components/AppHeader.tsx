"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Clapperboard, Cpu, Plus, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { cx } from "./ui";

interface SystemInfo {
  ai: { configured: boolean; model: string };
  media: { ok: boolean; ffmpegVersion?: string; error?: string };
}

export function AppHeader({ appName }: { appName: string }) {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  useEffect(() => {
    api<SystemInfo>("/api/system").then(setSys).catch(() => setSys(null));
  }, []);
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="focus-ring flex items-center gap-2.5 rounded-lg">
          <span className="btn-primary grid h-9 w-9 place-items-center rounded-xl">
            <Clapperboard className="h-5 w-5 text-white" />
          </span>
          <span className="font-display text-lg tracking-tight">{appName}</span>
        </Link>
        <div className="flex items-center gap-2">
          {sys && (
            <div className="hidden items-center gap-2 md:flex">
              <span
                className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", sys.ai.configured ? "border-ok/30 text-ok" : "border-accent/30 text-accent")}
                title={sys.ai.configured ? `Claude model: ${sys.ai.model}` : "Planning, analysis, revisions and review run on this machine. Claude is optional."}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {sys.ai.configured ? "Claude connected" : "Local creative engine"}
              </span>
              <span
                className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", sys.media.ok ? "border-line-strong text-muted" : "border-bad/40 text-bad")}
                title={sys.media.ffmpegVersion ?? sys.media.error ?? ""}
              >
                <Cpu className="h-3.5 w-3.5" />
                {sys.media.ok ? "Render engine ready" : "Render engine problem"}
              </span>
            </div>
          )}
          <Link href="/projects/new" className="btn-primary focus-ring inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium text-white">
            <Plus className="h-4 w-4" /> New project
          </Link>
        </div>
      </div>
    </header>
  );
}
