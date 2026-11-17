"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Film, Image as ImageIcon, Music, RotateCcw, Sparkles, Star, Trash2, Upload, Wand2, X } from "lucide-react";
import { api, ApiError, uploadFile } from "@/lib/api";
import { fmtBytes, fmtSec } from "@/lib/format";
import { Badge, Button, cx, Field, inputCls, Notice, ProgressBar, SectionTitle } from "../ui";
import type { AssetView, ProjectDetail, SystemInfo } from "./types";

interface UploadItem {
  key: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  error?: string;
}

const AUDIO_EXT = /\.(mp3|m4a|wav|aac)$/i;

export function MediaPanel({ detail, sys, busy, refresh, onError }: { detail: ProjectDetail; sys: SystemInfo | null; busy: boolean; refresh: () => void; onError: (m: string) => void }) {
  const pid = detail.project.id;
  const [items, setItems] = useState<UploadItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [license, setLicense] = useState({ source: "", license: "", attribution: "" });
  const [needLicense, setNeedLicense] = useState<File[] | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runUploads = useCallback(
    async (files: File[], lic?: typeof license) => {
      const newItems = files.map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, progress: 0, status: "queued" as const }));
      setItems((prev) => [...prev.filter((p) => p.status !== "done"), ...newItems]);
      // Upload sequentially: predictable server load and clear per-file progress.
      for (const it of newItems) {
        setItems((prev) => prev.map((p) => (p.key === it.key ? { ...p, status: "uploading" } : p)));
        try {
          await uploadFile(pid, it.file, {
            license: AUDIO_EXT.test(it.file.name) ? lic : undefined,
            onProgress: (f) => setItems((prev) => prev.map((p) => (p.key === it.key ? { ...p, progress: f, status: f >= 1 ? "processing" : "uploading" } : p))),
          });
          setItems((prev) => prev.map((p) => (p.key === it.key ? { ...p, progress: 1, status: "done" } : p)));
          refresh();
        } catch (e) {
          setItems((prev) => prev.map((p) => (p.key === it.key ? { ...p, status: "error", error: e instanceof ApiError ? e.message : "Upload failed" } : p)));
        }
      }
    },
    [pid, refresh],
  );

  const addFiles = (list: FileList | File[]) => {
    const files = Array.from(list);
    if (files.length === 0) return;
    if (files.some((f) => AUDIO_EXT.test(f.name))) setNeedLicense(files);
    else void runUploads(files);
  };

  const retry = (key: string) => {
    const it = items.find((i) => i.key === key);
    if (!it) return;
    setItems((prev) => prev.filter((p) => p.key !== key));
    void runUploads([it.file], AUDIO_EXT.test(it.file.name) ? license : undefined);
  };

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

  const visuals = detail.assets.filter((a) => a.kind !== "audio");
  const audio = detail.assets.filter((a) => a.kind === "audio");
  const usable = visuals.filter((a) => !a.excluded).length;
  const aiOn = Boolean(sys?.ai.configured);
  const analysedCount = visuals.filter((a) => a.analysis).length;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Media"
        subtitle="Photos (JPEG, PNG, WebP), clips (MP4, MOV) and licensed music (MP3, M4A, WAV, AAC). Originals are never modified."
        right={
          <div className="flex flex-wrap gap-2">
            {aiOn && (
              <Button onClick={() => act("analyse", () => api(`/api/projects/${pid}/analyse`, { method: "POST", json: { force: false } }))} loading={acting === "analyse"} disabled={busy || usable === 0} icon={<Sparkles className="h-4 w-4" />}>
                {analysedCount > 0 && analysedCount === visuals.length ? "Re-check analysis" : "Analyse with Claude"}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => act("basic", () => api(`/api/projects/${pid}/plan`, { method: "POST", json: { mode: "basic", autoRender: false } }))}
              loading={acting === "basic"}
              disabled={busy || usable === 0}
              icon={<Wand2 className="h-4 w-4" />}
              title="Deterministic assembly without AI analysis"
            >
              Basic assembly (no AI)
            </Button>
            {aiOn && (
              <Button variant="primary" onClick={() => act("plan", () => api(`/api/projects/${pid}/plan`, { method: "POST", json: { mode: "ai" } }))} loading={acting === "plan"} disabled={busy || usable === 0} icon={<Sparkles className="h-4 w-4" />}>
                Plan my video with Claude
              </Button>
            )}
          </div>
        }
      />

      {!aiOn && (
        <Notice tone="warn" title="AI agent not configured">
          Add <code className="text-fg">ANTHROPIC_API_KEY</code> to <code className="text-fg">.env</code> and restart to enable Claude vision analysis, creative planning, revisions and creative review. Until then you can render a real video with <b>Basic assembly (no AI)</b>.
        </Notice>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!busy) addFiles(e.dataTransfer.files);
        }}
        className={cx("card flex flex-col items-center justify-center gap-3 border-dashed p-10 text-center transition", drag ? "border-accent bg-accent/5" : "")}
      >
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-3">
          <Upload className="h-5 w-5 text-accent" />
        </div>
        <div className="text-fg">Drag &amp; drop files here</div>
        <div className="text-xs text-faint">
          Images up to {fmtBytes(sys?.limits.maxImageBytes)}, videos up to {fmtBytes(sys?.limits.maxVideoBytes)}, music up to {fmtBytes(sys?.limits.maxAudioBytes)}
        </div>
        <input ref={inputRef} type="file" multiple accept={sys?.accept ?? ".jpg,.jpeg,.png,.webp,.mp4,.mov,.mp3,.m4a,.wav,.aac"} className="hidden" onChange={(e) => e.target.files && addFiles(e.target.files)} />
        <Button onClick={() => inputRef.current?.click()} disabled={busy} icon={<Upload className="h-4 w-4" />}>
          Choose files
        </Button>
        {busy && <div className="text-xs text-warn">Uploads are paused while a task is running.</div>}
      </div>

      {needLicense && (
        <div className="card space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">Music licence</div>
              <p className="text-sm text-muted">Only use music you own or that is licensed for this use (e.g. royalty-free with a licence permitting social video). This is stored with the track.</p>
            </div>
            <button onClick={() => setNeedLicense(null)} className="focus-ring rounded-lg p-1 text-muted hover:text-fg" aria-label="Cancel">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Source">
              <input className={inputCls} value={license.source} onChange={(e) => setLicense({ ...license, source: e.target.value })} placeholder="e.g. my own recording / library name" />
            </Field>
            <Field label="Licence">
              <input className={inputCls} value={license.license} onChange={(e) => setLicense({ ...license, license: e.target.value })} placeholder="e.g. royalty-free, commercial use" />
            </Field>
            <Field label="Attribution (if required)">
              <input className={inputCls} value={license.attribution} onChange={(e) => setLicense({ ...license, attribution: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!license.license.trim()}
              onClick={() => {
                const files = needLicense;
                setNeedLicense(null);
                void runUploads(files, license);
              }}
            >
              Confirm &amp; upload
            </Button>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="card divide-y divide-line">
          {items.map((it) => (
            <div key={it.key} className="flex items-center gap-3 p-3 text-sm">
              <div className="w-48 min-w-0 truncate text-fg sm:w-72">{it.file.name}</div>
              <div className="flex-1">
                {it.status === "error" ? <div className="text-xs text-bad">{it.error}</div> : <ProgressBar value={it.progress} live={it.status === "processing"} />}
              </div>
              <div className="w-28 text-right text-xs text-muted">
                {it.status === "uploading" && `${Math.round(it.progress * 100)}%`}
                {it.status === "processing" && "Inspecting…"}
                {it.status === "queued" && "Waiting"}
                {it.status === "done" && <CheckCircle2 className="ml-auto h-4 w-4 text-ok" />}
                {it.status === "error" && (
                  <button onClick={() => retry(it.key)} className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-accent hover:bg-panel-3">
                    <RotateCcw className="h-3 w-3" /> Retry
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {visuals.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visuals.map((a) => (
            <AssetCard key={a.id} a={a} pid={pid} busy={busy} onToggle={() => act(`x${a.id}`, () => api(`/api/projects/${pid}/assets/${a.id}`, { method: "PATCH", json: { excluded: !a.excluded } }))} onDelete={() => act(`d${a.id}`, () => api(`/api/projects/${pid}/assets/${a.id}`, { method: "DELETE" }))} />
          ))}
        </div>
      )}

      {audio.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted">Music</h3>
          {audio.map((a) => (
            <div key={a.id} className={cx("card flex flex-wrap items-center gap-4 p-4", a.excluded && "opacity-50")}>
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-panel-3">
                <Music className="h-5 w-5 text-accent-2" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">{a.originalName}</div>
                <div className="text-xs text-muted">
                  {fmtSec(a.durationSec)} · {a.audio?.bpm ? `${Math.round(a.audio.bpm)} BPM detected` : "no steady beat detected"} · peak {a.audio?.peakDb ?? "?"} dBFS
                  {a.license?.license ? ` · licence: ${a.license.license}` : " · licence not recorded"}
                </div>
              </div>
              <audio controls preload="none" src={`/api/projects/${pid}/assets/${a.id}/thumbnail?original=1`} className="h-8 w-60" />
              <div className="flex gap-1">
                <IconBtn label={a.excluded ? "Include" : "Exclude"} disabled={busy} onClick={() => act(`x${a.id}`, () => api(`/api/projects/${pid}/assets/${a.id}`, { method: "PATCH", json: { excluded: !a.excluded } }))}>
                  {a.excluded ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </IconBtn>
                <IconBtn label="Delete" disabled={busy} onClick={() => act(`d${a.id}`, () => api(`/api/projects/${pid}/assets/${a.id}`, { method: "DELETE" }))}>
                  <Trash2 className="h-4 w-4" />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label} className="focus-ring rounded-lg bg-ink/70 p-1.5 text-muted backdrop-blur hover:text-fg disabled:opacity-40">
      {children}
    </button>
  );
}

function AssetCard({ a, pid, busy, onToggle, onDelete }: { a: AssetView; pid: string; busy: boolean; onToggle: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const flags: { tone: "warn" | "bad"; text: string }[] = [];
  if (a.metrics?.veryDark) flags.push({ tone: "bad", text: "Very dark" });
  else if (a.metrics?.dark) flags.push({ tone: "warn", text: "Dark" });
  if (a.metrics?.blurry) flags.push({ tone: "bad", text: "Blurry" });
  else if (a.metrics?.soft) flags.push({ tone: "warn", text: "Soft" });
  const shortEdge = Math.min(a.width ?? 0, a.height ?? 0);
  if (shortEdge > 0 && shortEdge < 720) flags.push({ tone: "warn", text: "Low resolution" });
  return (
    <div className={cx("card overflow-hidden", a.excluded && "opacity-45")}>
      <div className="relative aspect-[4/5] bg-panel-2">
        {a.hasThumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/projects/${pid}/assets/${a.id}/thumbnail`} alt={a.analysis?.summary ?? a.originalName} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-faint">{a.kind === "video" ? <Film /> : <ImageIcon />}</div>
        )}
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          <Badge>{a.kind === "video" ? `Video · ${fmtSec(a.durationSec)}` : "Photo"}</Badge>
          {a.analysis?.recommended && (
            <Badge tone="gold">
              <Star className="h-3 w-3" /> Recommended
            </Badge>
          )}
          {a.excluded && <Badge tone="bad">Excluded</Badge>}
        </div>
        <div className="absolute right-2 top-2 flex gap-1">
          <IconBtn label={a.excluded ? "Include in the edit" : "Exclude from the edit"} onClick={onToggle} disabled={busy}>
            {a.excluded ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </IconBtn>
          <IconBtn label="Delete file" onClick={onDelete} disabled={busy}>
            <Trash2 className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>
      <div className="space-y-1.5 p-3">
        <div className="truncate text-sm text-fg" title={a.originalName}>
          {a.originalName}
        </div>
        <div className="text-xs text-faint">
          {a.width}×{a.height} · {a.orientation} · {fmtBytes(a.sizeBytes)}
        </div>
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {flags.map((f) => (
              <Badge key={f.text} tone={f.tone}>
                <AlertTriangle className="h-3 w-3" /> {f.text}
              </Badge>
            ))}
          </div>
        )}
        {a.analysis && (
          <button onClick={() => setOpen(!open)} className="focus-ring w-full rounded-lg text-left text-xs text-muted hover:text-fg">
            <span className="line-clamp-2">{a.analysis.summary}</span>
            <span className="text-accent">{open ? "Less" : "AI analysis"}</span>
          </button>
        )}
        {open && a.analysis && (
          <div className="space-y-1 rounded-lg bg-panel-2 p-2 text-[11px] leading-relaxed text-muted">
            <div>
              <b className="text-fg">Subject:</b> {a.analysis.mainSubject}
            </div>
            <div>
              <b className="text-fg">Quality:</b> {a.analysis.visualQuality}
              {a.analysis.qualityIssues.length > 0 && ` — ${a.analysis.qualityIssues.join("; ")}`}
            </div>
            <div>
              <b className="text-fg">Hook strength:</b> {a.analysis.hookStrength}/5 · <b className="text-fg">Vertical crop:</b> {a.analysis.verticalCropSuitability}
            </div>
            <div>
              <b className="text-fg">Why:</b> {a.analysis.recommendationReason}
            </div>
            {a.analysis.uncertainObservations.length > 0 && (
              <div className="text-warn">
                <b>Uncertain:</b> {a.analysis.uncertainObservations.join("; ")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
