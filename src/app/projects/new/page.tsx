"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { PLATFORMS, RESOLUTIONS, STYLES, type AspectRatio, type Platform, type ResolutionId, type StyleId } from "@/lib/presets";
import { Button, Field, inputCls, Notice, Toggle, cx } from "@/components/ui";

const EXAMPLES = [
  "Make a 30-second cinematic Kerala travel reel. Start with a strong visual hook, build an emotional journey, use elegant text, smooth but not repetitive transitions, warm natural colour grading, and a memorable ending. Keep it premium and not overly flashy.",
  "Create a premium 15-second product promo. Keep the product clearly visible, use clean modern text, no made-up claims, and end on the product with our brand name.",
  "A warm birthday montage for my mom with soft transitions, handwritten-style captions and a heartfelt ending message.",
];

export default function NewProject() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState<Platform>("instagram_reels");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [duration, setDuration] = useState(30);
  const [resolution, setResolution] = useState<ResolutionId>("1080p");
  const [fps, setFps] = useState<24 | 25 | 30 | 60>(30);
  const [style, setStyle] = useState<StyleId>("cinematic_travel");
  const [mood, setMood] = useState("");
  const [language, setLanguage] = useState("English");
  const [captions, setCaptions] = useState(true);
  const [music, setMusic] = useState("");
  const [silent, setSilent] = useState(false);
  const [approval, setApproval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickPlatform = (p: Platform) => {
    setPlatform(p);
    setAspect(PLATFORMS[p].aspect as AspectRatio);
    setDuration((d) => Math.min(d, PLATFORMS[p].maxSec));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        json: { name: name || "Untitled reel", prompt, platform, aspectRatio: aspect, durationSec: duration, resolution, fps, style, mood, language, captionsEnabled: captions, musicPreference: music, silentOutput: silent, requireApproval: approval },
      });
      router.push(`/projects/${res.project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the project.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-3xl">New project</h1>
        <p className="mt-1 text-muted">Describe the video you want. You&apos;ll upload media on the next screen.</p>
      </div>

      <section className="card space-y-5 p-6">
        <Field label="Project name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Kerala travel reel" maxLength={120} />
        </Field>
        <Field label="Creative prompt" hint="Subject, mood, pacing, text, music, what to avoid, how it should end. Missing details get sensible defaults.">
          <textarea className={cx(inputCls, "min-h-36 resize-y leading-relaxed")} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} placeholder="Make a 30-second cinematic travel reel from these photos and clips…" />
        </Field>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex, i) => (
            <button key={i} type="button" onClick={() => setPrompt(ex)} className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-fg">
              <Sparkles className="h-3 w-3 text-accent" /> {["Cinematic travel", "Product promo", "Birthday montage"][i]}
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-5 p-6">
        <h2 className="font-display text-lg">Output</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(Object.keys(PLATFORMS) as Platform[]).map((p) => (
            <button key={p} type="button" onClick={() => pickPlatform(p)} className={cx("focus-ring rounded-xl border p-3 text-left text-sm transition", platform === p ? "border-accent bg-accent/10 text-fg" : "border-line bg-panel-2 text-muted hover:text-fg")}>
              <div>{PLATFORMS[p].label}</div>
              <div className="text-xs text-faint">{PLATFORMS[p].aspect}</div>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <Field label={`Duration · ${duration}s`}>
            <input type="range" min={5} max={PLATFORMS[platform].maxSec} step={1} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full" aria-label="Duration in seconds" />
          </Field>
          <Field label="Resolution" hint={resolution === "2160p" ? "4K is rendered only from your sources; low-resolution media is upscaled and labelled as such." : undefined}>
            <select className={inputCls} value={resolution} onChange={(e) => setResolution(e.target.value as ResolutionId)}>
              {(Object.keys(RESOLUTIONS) as ResolutionId[]).map((r) => (
                <option key={r} value={r}>
                  {RESOLUTIONS[r].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Frame rate">
            <select className={inputCls} value={fps} onChange={(e) => setFps(Number(e.target.value) as 24 | 25 | 30 | 60)}>
              {[24, 25, 30, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps{f === 30 ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="card space-y-5 p-6">
        <div>
          <h2 className="font-display text-lg">Creative style</h2>
          <p className="text-sm text-muted">A starting point — the agent adapts the edit to your content rather than forcing a template.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {(Object.keys(STYLES) as StyleId[]).map((s) => (
            <button key={s} type="button" onClick={() => setStyle(s)} className={cx("focus-ring rounded-xl border p-3 text-left text-sm transition", style === s ? "border-accent bg-accent/10 text-fg" : "border-line bg-panel-2 text-muted hover:text-fg")}>
              {STYLES[s].label}
              <div className="mt-0.5 text-[11px] text-faint">{STYLES[s].pacing} pace</div>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <Field label="Mood (optional)">
            <input className={inputCls} value={mood} onChange={(e) => setMood(e.target.value)} placeholder="warm, nostalgic, uplifting" maxLength={200} />
          </Field>
          <Field label="Caption language">
            <input className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Music preference (optional)">
            <input className={inputCls} value={music} onChange={(e) => setMusic(e.target.value)} placeholder="emotional, slow build" maxLength={300} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Toggle checked={captions} onChange={setCaptions} label="On-screen captions" hint="Short, readable text in safe areas" />
          <Toggle checked={silent} onChange={setSilent} label="Silent output" hint="No music or audio track" />
          <Toggle checked={approval} onChange={setApproval} label="Review plan before rendering" hint="Recommended" />
        </div>
      </section>

      {error && <Notice tone="bad" title="Could not create project">{error}</Notice>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy} icon={<ArrowRight className="h-4 w-4" />}>
          Create project &amp; add media
        </Button>
      </div>
    </form>
  );
}
