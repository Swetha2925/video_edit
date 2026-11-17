"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Music, Palette, Play, RefreshCw, Save, Sparkles, Type, Wand2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtSec, humanize } from "@/lib/format";
import { COLOR_GRADES, MOTIONS, TRANSITIONS, TYPOGRAPHY, type ColorGrade, type MotionId, type TransitionId, type TypographyId } from "@/lib/presets";
import type { Storyboard } from "@/lib/schemas";
import { Badge, Button, cx, inputCls, Notice, SectionTitle } from "../ui";
import type { ProjectDetail, SystemInfo } from "./types";

const SCENE_COLORS = ["#8b5cf6", "#d946ef", "#e8c27a", "#34d399", "#60a5fa", "#f472b6", "#fb923c", "#a3e635"];

export function PlanPanel({ detail, sys, busy, refresh, onError, goRender }: { detail: ProjectDetail; sys: SystemInfo | null; busy: boolean; refresh: () => void; onError: (m: string) => void; goRender: () => void }) {
  const pid = detail.project.id;
  const sb = detail.storyboard;
  const [answer, setAnswer] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const assetsById = useMemo(() => new Map(detail.assets.map((a) => [a.id, a])), [detail.assets]);
  const aiOn = Boolean(sys?.ai.configured);

  useEffect(() => {
    setTexts({});
  }, [sb?.version]);

  const act = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    setActing(label);
    try {
      await fn();
      refresh();
      after?.();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  };

  const dirty = sb ? sb.data.scenes.some((s) => texts[s.id] !== undefined && texts[s.id] !== (s.text?.content ?? "")) : false;
  const saveEdits = () => {
    if (!sb) return;
    const next: Storyboard = {
      ...sb.data,
      scenes: sb.data.scenes.map((s) => {
        const t = texts[s.id];
        if (t === undefined) return s;
        const trimmed = t.trim();
        if (!trimmed) return { ...s, text: null };
        return { ...s, text: s.text ? { ...s.text, content: trimmed } : { content: trimmed, style: "caption", position: "lower_third", animation: "fade" } };
      }),
    };
    return act("save", () => api(`/api/projects/${pid}/storyboard`, { method: "PUT", json: { baseVersion: sb.version, storyboard: next } }));
  };

  const render = () => act("render", () => api(`/api/projects/${pid}/render`, { method: "POST", json: { storyboardVersion: sb?.version } }), goRender);

  return (
    <div className="space-y-6">
      {detail.project.stage === "needs_clarification" && (
        <div className="card space-y-3 border-gold/40 p-5">
          <div className="flex items-start gap-3">
            <HelpCircle className="mt-0.5 h-5 w-5 text-gold" />
            <div>
              <div className="font-medium">The agent has a question before planning</div>
              <p className="mt-1 text-sm text-muted">{detail.project.stageMessage}</p>
            </div>
          </div>
          <textarea className={cx(inputCls, "min-h-20")} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer…" maxLength={1000} />
          <div className="flex justify-end gap-2">
            <Button variant="primary" disabled={!answer.trim() || busy} loading={acting === "answer"} onClick={() => act("answer", () => api(`/api/projects/${pid}/plan`, { method: "POST", json: { mode: "ai", clarification: answer } }))} icon={<Sparkles className="h-4 w-4" />}>
              Answer &amp; continue planning
            </Button>
          </div>
        </div>
      )}

      {detail.brief && (
        <section className="card space-y-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Badge tone="accent">
                <Sparkles className="h-3 w-3" /> Creative brief v{detail.brief.version}
              </Badge>
              <h2 className="mt-2 font-display text-2xl">{detail.brief.title}</h2>
              <p className="mt-1 max-w-3xl text-sm text-muted">{detail.brief.story}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {detail.brief.mood.map((m) => (
                <Badge key={m}>{m}</Badge>
              ))}
              <Badge tone="gold">{detail.brief.pacing} pacing</Badge>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <Info label="Hook" value={detail.brief.hookIdea} />
            <Info label="Ending" value={detail.brief.ending} />
            <Info label="Audience" value={detail.brief.audience} />
          </div>
          {detail.brief.assumptions.length > 0 && (
            <div className="text-sm">
              <div className="mb-1 text-xs uppercase tracking-wider text-faint">Defaults the agent chose</div>
              <ul className="list-disc space-y-0.5 pl-5 text-muted">
                {detail.brief.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {detail.brief.conflicts.map((c, i) => (
            <Notice key={i} tone="warn" title={`Conflict: ${c.topic}`}>
              {c.description} <b className="text-fg">Resolution:</b> {c.proposedResolution}
            </Notice>
          ))}
          {detail.brief.qualityConcerns.length > 0 && (
            <Notice tone="warn" title="Media limitations">
              {detail.brief.qualityConcerns.join(" ")}
            </Notice>
          )}
        </section>
      )}

      {!sb && detail.project.stage !== "needs_clarification" && (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Wand2 className="h-8 w-8 text-faint" />
          <div>No plan yet.</div>
          <p className="max-w-md text-sm text-muted">Add media, then ask Claude to plan your video — or use Basic assembly to render without AI.</p>
          <div className="flex gap-2">
            {aiOn && (
              <Button variant="primary" disabled={busy} loading={acting === "plan"} onClick={() => act("plan", () => api(`/api/projects/${pid}/plan`, { method: "POST", json: { mode: "ai" } }))} icon={<Sparkles className="h-4 w-4" />}>
                Plan with Claude
              </Button>
            )}
            <Button disabled={busy} loading={acting === "basic"} onClick={() => act("basic", () => api(`/api/projects/${pid}/plan`, { method: "POST", json: { mode: "basic" } }))} icon={<Wand2 className="h-4 w-4" />}>
              Basic assembly (no AI)
            </Button>
          </div>
        </div>
      )}

      {sb && (
        <section className="space-y-5">
          <SectionTitle
            title={`Storyboard v${sb.version}`}
            subtitle={`${sb.data.scenes.length} scenes · ${fmtSec(sb.data.scenes.reduce((s, x) => s + x.durationSec, 0))} · ${sb.source === "heuristic" ? "Basic assembly (no AI)" : sb.source === "ai" ? "Planned by Claude" : sb.source === "revision" ? "Revised from your feedback" : sb.source === "auto_fix" ? "Auto-fixed after QC" : "Edited by you"}${sb.approved ? " · approved" : ""}`}
            right={
              <div className="flex flex-wrap gap-2">
                {aiOn && (
                  <Button variant="ghost" disabled={busy} loading={acting === "plan"} onClick={() => act("plan", () => api(`/api/projects/${pid}/plan`, { method: "POST", json: { mode: "ai" } }))} icon={<RefreshCw className="h-4 w-4" />}>
                    New plan
                  </Button>
                )}
                {dirty && (
                  <Button disabled={busy} loading={acting === "save"} onClick={saveEdits} icon={<Save className="h-4 w-4" />}>
                    Save text edits
                  </Button>
                )}
                <Button variant="primary" disabled={busy || dirty} loading={acting === "render"} onClick={render} icon={<Play className="h-4 w-4" />} title={dirty ? "Save your text edits first" : undefined}>
                  {sb.approved ? "Render this plan" : "Approve & render"}
                </Button>
              </div>
            }
          />
          {sb.note && (
            <div className="rounded-xl border border-line bg-panel-2 p-3 text-xs leading-relaxed text-muted">
              {sb.note.split("\n").map((l, i) => (
                <div key={i} className={l.startsWith("•") ? "text-warn" : ""}>
                  {l}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Look icon={<Palette className="h-4 w-4 text-accent" />} label="Colour grade" value={`${humanize(sb.data.colorGrade)} · ${Math.round(sb.data.gradeIntensity * 100)}%`} hint={COLOR_GRADES[sb.data.colorGrade as ColorGrade]} />
            <Look icon={<Type className="h-4 w-4 text-accent-2" />} label="Typography" value={TYPOGRAPHY[sb.data.typography as TypographyId].label} hint={`${TYPOGRAPHY[sb.data.typography as TypographyId].title} / ${TYPOGRAPHY[sb.data.typography as TypographyId].body}`} />
            <Look icon={<Music className="h-4 w-4 text-gold" />} label="Music" value={sb.data.music ? assetsById.get(sb.data.music.assetId)?.originalName ?? "Track" : detail.project.silentOutput ? "Silent output" : "No music"} hint={sb.data.music ? `${sb.data.music.beatSync ? "Cuts synced to beat" : "Free timing"} · vol ${Math.round(sb.data.music.volume * 100)}%` : undefined} />
            <Look icon={<CheckCircle2 className="h-4 w-4 text-ok" />} label="Ending" value={sb.data.endCard ? `“${sb.data.endCard.text}”` : "Final image"} hint={sb.data.fadeOutEnding ? "Fades out" : "Hard ending"} />
          </div>

          {/* Timeline */}
          <div className="card p-4">
            <div className="mb-2 flex justify-between text-[11px] text-faint">
              <span>0s</span>
              <span>{fmtSec(detail.project.durationSec, 0)}</span>
            </div>
            <div className="flex h-16 w-full gap-0.5 overflow-hidden rounded-lg">
              {sb.data.scenes.map((s, i) => {
                const a = assetsById.get(s.assetId);
                return (
                  <div key={s.id} className="relative h-full overflow-hidden" style={{ flexGrow: s.durationSec, flexBasis: 0, background: SCENE_COLORS[i % SCENE_COLORS.length] }} title={`${s.id}: ${s.purpose} (${s.durationSec.toFixed(1)}s)`}>
                    {a?.hasThumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/projects/${pid}/assets/${a.id}/thumbnail`} alt="" className="h-full w-full object-cover opacity-70" />
                    )}
                    <span className="absolute bottom-0.5 left-1 text-[10px] font-medium text-white drop-shadow">{i + 1}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Scenes */}
          <div className="space-y-3">
            {(() => {
              let t = 0;
              return sb.data.scenes.map((s, i) => {
                const start = t;
                t += s.durationSec;
                const a = assetsById.get(s.assetId);
                const textValue = texts[s.id] ?? s.text?.content ?? "";
                return (
                  <div key={s.id} className="card flex flex-col gap-4 p-4 sm:flex-row">
                    <div className="relative h-36 w-full shrink-0 overflow-hidden rounded-xl bg-panel-2 sm:w-24">
                      {a?.hasThumbnail && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/projects/${pid}/assets/${a.id}/thumbnail`} alt={a.originalName} className="h-full w-full object-cover" />
                      )}
                      <span className="absolute left-1.5 top-1.5 rounded-md bg-ink/80 px-1.5 text-[11px]">{i + 1}</span>
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-faint">
                          {start.toFixed(1)}–{t.toFixed(1)}s
                        </span>
                        <span className="font-medium text-fg">{s.purpose}</span>
                        {a?.excluded && (
                          <Badge tone="bad">
                            <AlertTriangle className="h-3 w-3" /> excluded asset
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted">{s.visualDescription}</p>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <Badge>{a?.originalName ?? s.assetId}</Badge>
                        <Badge>In: {TRANSITIONS[s.transitionIn.type as TransitionId]?.label ?? s.transitionIn.type}{s.transitionIn.type !== "cut" ? ` ${s.transitionIn.durationSec}s` : ""}</Badge>
                        <Badge>{MOTIONS[s.motion as MotionId] ?? s.motion}{s.motion !== "none" ? ` · ${s.motionIntensity}` : ""}</Badge>
                        <Badge>{s.fit === "contain_blur" ? "Full frame + blur fill" : "Fill frame"}</Badge>
                        {a?.kind === "video" && <Badge>from {s.sourceInSec.toFixed(1)}s{s.useClipAudio ? " · clip audio" : ""}</Badge>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Type className="h-4 w-4 shrink-0 text-faint" />
                        <input
                          className={cx(inputCls, "py-1.5")}
                          value={textValue}
                          onChange={(e) => setTexts({ ...texts, [s.id]: e.target.value })}
                          placeholder="No on-screen text (type to add)"
                          maxLength={120}
                          disabled={busy}
                          aria-label={`On-screen text for scene ${i + 1}`}
                        />
                        {s.text && <span className="hidden whitespace-nowrap text-[11px] text-faint sm:inline">{s.text.style} · {s.text.position.replace("_", " ")}</span>}
                      </div>
                      {s.reason && <p className="text-xs italic text-faint">Why: {s.reason}</p>}
                    </div>
                  </div>
                );
              });
            })()}
          </div>

          {detail.storyboardVersions.length > 1 && (
            <div className="card p-4 text-sm">
              <div className="mb-2 text-xs uppercase tracking-wider text-faint">Plan history (every version is kept)</div>
              <div className="space-y-1">
                {detail.storyboardVersions.map((v) => (
                  <div key={v.version} className="flex items-center justify-between gap-3 text-muted">
                    <span>
                      v{v.version} · {humanize(v.source)}
                      {v.parentVersion ? ` (from v${v.parentVersion})` : ""} {v.note && <span className="text-faint">— {v.note}</span>}
                    </span>
                    <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => act(`r${v.version}`, () => api(`/api/projects/${pid}/render`, { method: "POST", json: { storyboardVersion: v.version } }), goRender)}>
                      Render v{v.version}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 text-fg">{value || "—"}</div>
    </div>
  );
}

function Look({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="card p-3">
      <div className="flex items-center gap-1.5 text-xs text-faint">
        {icon} {label}
      </div>
      <div className="mt-1 truncate text-fg" title={value}>
        {value}
      </div>
      {hint && <div className="truncate text-[11px] text-faint">{hint}</div>}
    </div>
  );
}
