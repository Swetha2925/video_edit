# ReelCraft AI — Architecture

This document explains the important decisions in plain language. Code references are given as `path:symbol`.

## 1. The big idea: separate *creative decisions* from *execution*

A language model is good at taste and planning: which photo makes the best hook, how a story should flow, what words to put on screen. It is not a reliable video encoder, and it should never run arbitrary commands on your machine. So ReelCraft splits the work:

| Layer | Responsibility | Where |
|---|---|---|
| **Claude** | Brief, storyboard, revisions, visual review | `src/server/agent/` |
| **Harness** | Validation, tools, state, retries, quality gates, logs | `src/server/harness/`, `src/server/qc/` |
| **Media tools** | Probing, thumbnails, rendering, inspection | `src/server/media/`, `src/server/render/` |

Claude only ever returns **structured JSON** that matches a schema. The harness validates that JSON strictly, and only deterministic code turns it into FFmpeg argument arrays.

## 1b. Two interchangeable creative engines

Every creative tool (`analyse_assets`, `create_creative_brief`, `create_storyboard`, `revise_edit`, `run_quality_checks`) has two implementations behind the same typed contract:

- **Claude** (`src/server/agent/`), used when `ANTHROPIC_API_KEY` is set.
- **The local creative engine** (`src/server/local/`), used otherwise. It runs entirely on-device:
  - `vision.ts`: decodes small rasters with FFmpeg and measures brightness, contrast, saturation, colourfulness, warmth and dominant colours. A saliency map (edges + colour distinctness) gives the focal point, attention concentration and 9:16 crop safety. Video clips are sampled with motion energy to find their strongest moments. It never claims to recognise objects.
  - `brief.ts`: rule-based language understanding (length, mood, pacing, grade, typography, quoted text, avoid-list, call to action, platform/silent/voice-over conflicts). A duration conflict triggers a clarification question.
  - `director.ts`: story structure (hook → establish → build → peak → close), pacing-based shot counts, colour-alternating order, motion toward the focal point, restrained transitions (stylised only at beats, never back-to-back), and the strongest video moments as in-points.
  - `reviser.ts`: plain-English feedback → the same edit operations Claude produces. Unrecognised requests become questions.
  - `reviewer.ts`: checks render frames for text over the subject, readability on bright backgrounds, flat or extreme frames, scene consistency, hook and ending. It emits concrete fixes for confident findings, and the auto-fix loop applies them.

Because both engines emit the same schemas, everything downstream (validation, compiler, renderer, QC, versioning) is shared and identical.

## 2. The data pipeline

```
Prompt + settings ─┐
Media uploads ─────┼─► Creative brief ─► Storyboard ─► EDL ─► FFmpeg render ─► QC report
Measured metrics ──┘    (Claude)         (Claude)      (code)   (code)          (code + Claude)
```

### Storyboard vs EDL (why there are two plans)

- The **storyboard** (`src/lib/schemas.ts:StoryboardSchema`) is the *creative intent*: scenes, assets, durations, transitions, motion, framing, text, music and grade, plus a "reason" per scene. It is what you review and what Claude edits.
- The **EDL** (`EdlSchema`) is the *render source of truth*: exact frame counts, transition overlaps, video in-points, motion keyframes, text positions in pixels, audio fades and loudness targets.

The **compiler** (`src/server/render/compiler.ts:compileStoryboard`) converts one into the other deterministically: same input, same EDL. That is where precision lives:

- **Frame-exact timing.** Scene *i* owns `[Bᵢ, Bᵢ₊₁)`. A transition of *T* frames is centred on the boundary, so clips overlap by *T*/2 on each side and the total length never drifts.
- **Beat sync.** If the music has a detected beat grid (`src/server/media/audio.ts`), cut points snap to the nearest beat within ±0.3 s while keeping every scene ≥ 0.8 s.
- **Typography layout.** Fonts are sized relative to the frame, text is wrapped with conservative glyph-width estimates, and the result is placed inside platform safe areas. Instagram, TikTok and YouTube UI zones are kept clear.
- **Exposure correction.** A small per-asset brightness/gamma fix is applied from measured luma, so a dark photo doesn't break colour consistency.
- **Honesty flags.** Every clip records whether it was upscaled. Clips that are too short to fill their slot hold their last frame, with a warning.

## 3. Validation everywhere

| What | Validator |
|---|---|
| HTTP bodies | Zod schemas in each route (`parseBody`) |
| Uploads | Extension ↔ magic-byte agreement (`media/signature.ts`), streaming byte limits, FFprobe decode check |
| Model output | Zod domain schemas. On failure, the errors are sent back to Claude for up to 2 repair attempts (`agent/steps.ts:structuredWithRepair`) |
| Storyboard semantics | `render/storyboardValidation.ts`: asset ownership/exclusion, in-points, total duration, music vs silent output, text readability |
| EDL | `render/edlValidation.ts`: paths resolve inside the project, timeline continuity, allowed transitions, readable font sizes, frame bounds |
| Files on disk | `storage.ts:resolveProjectPath`: no traversal, no absolute paths, only known sub-directories |

## 4. The harness

### Tool registry (`harness/registry.ts`, `harness/tools.ts`)
Every capability is a named tool with an input schema, an output schema and a timeout:
`inspect_media`, `generate_thumbnail`, `measure_visual_quality`, `analyse_audio`, `extract_keyframes`, `analyse_assets`, `create_creative_brief`, `create_storyboard`, `validate_storyboard`, `create_edit_decision_list`, `validate_edl`, `render_video`, `inspect_render`, `extract_review_frames`, `run_quality_checks`, `revise_edit`, `export_video`.

`runTool` validates input, refuses calls that target another project, applies a timeout and cancellation, validates output, and writes a `ToolCall` log row with timing, status and summaries. Media content is never logged.

### State machine (`harness/stateMachine.ts`)
`draft → analysing → analysed → planning → (needs_clarification | plan_ready) → rendering → (completed | failed)`. Illegal jumps throw, so a project cannot become "completed" without a render that passed QC.

### Job queue (`harness/jobs.ts`)
Long work (analysis, planning, rendering, revisions) runs in a database-backed queue:

- **One active job per project** prevents conflicting edits.
- **Progress** comes from the work itself: FFmpeg's `-progress` output, weighted across segments, loudness pass, final encode and QC. Nothing is simulated.
- **Cancellation**: a flag in the DB becomes an `AbortSignal` that kills FFmpeg or aborts the Claude request.
- **Retries** apply to transient errors only (rate limits, network). Renders are not blindly retried.
- **Crash safety**: running jobs heartbeat every 5 s, and a job silent for 60 s is marked "interrupted".
- **Chaining**: a revision enqueues its render when it finishes.

Why the worker starts only from `src/instrumentation.ts`: Next.js may evaluate route modules in short-lived helper processes. A worker started there could claim a job and then die with the helper. Worker state is stored on the `process` object because Next.js can load the same module in several JS contexts within one process.

### Render workflow with self-correction (`harness/workflows.ts`, render handler)

```
compile EDL → validate → render (new version, never overwrite) → inspect file
   → technical/audio/visual checks → review frames → Claude creative review
   → passed? ─yes→ completed
          └no→ diagnose: deterministic fix (e.g. lower music on clipping)
                         or Claude revision from the QC findings
              → new storyboard version (source "auto_fix") → render again
              (at most AUTO_FIX_RENDER_BUDGET times, default 2)
```

A render counts as "passed" only when no **blocking** check failed and there is no confident high-severity creative issue. Failed versions stay on disk for comparison but cannot be exported.

## 5. Quality control (`src/server/qc/`)

One full decode pass runs `blackdetect`, `freezedetect`, `silencedetect` and `volumedetect`. That also proves every frame decodes, i.e. the file is playable and not corrupt. Results are compared with what the EDL **intended**, so a deliberate dip-to-black or a static still is not reported as a defect (`checks.ts:unexpectedPortion`).

Checks: file exists, container readable, H.264 present, resolution, aspect ratio, frame rate, yuv420p, duration within ±max(0.12 s, 1%), full decode, bitrate, AAC present when expected, audio duration, peak level (clipping), loudness, unexpected silence, smooth audio ending, unexpected black frames, frozen sections, upscaling, and text safe areas.

The quality label ("Full HD 1080p output", "… (2 clips upscaled …)") is derived from **measured** output properties, never assumed.

Claude's creative review sees frames from the actual render. Each finding carries a certainty level, and only confident high-severity findings block a render, because automated visual review is imperfect.

## 6. Rendering details (`src/server/render/ffmpegPlan.ts`)

1. **Per-scene segments**:
   - Images use cover or "contain + blurred fill", so there are never black bars.
   - Ken Burns motion uses `zoompan` on a 2× supersampled frame with eased motion to avoid jitter.
   - Each segment gets a colour grade (`eq` + `colorbalance` + optional vignette, bounded parameters).
   - Segments are encoded at high quality and an exact frame count.
2. **Loudness measurement**: an audio-only EBU R128 pass (`loudnorm` first pass).
3. **Final composition**:
   - cuts via `concat` and transitions via `xfade`;
   - typography via an ASS subtitle file rendered by libass (fade/rise/scale/blur animations, outlines, soft shadows, bundled OFL fonts);
   - music fades and ducking under clip audio (`sidechaincompress`);
   - two-pass linear `loudnorm` to −14 LUFS, a limiter at about −1.5 dBFS, and H.264 High / yuv420p / BT.709 output with AAC 192 kbps, 48 kHz and `+faststart`.

User or model text never enters a filter graph. It lives in the ASS file and is sanitised so it can't inject override tags (`ass.ts:sanitizeAssText`).

## 7. Security & privacy

- The API key stays in server code only (`agent/client.ts`). The browser never sees it.
- Every project route calls `requireOwnedProject`. A missing project and someone else's project return the same 404.
- Uploads stream to disk with byte limits. Originals are stored read-only with server-generated names, outside any public directory, and served only through ownership-checked routes with Range support.
- Media tools run via `spawn` with argument arrays, timeouts and kill-on-cancel.
- Deleting a project removes its database rows (cascade) and its storage directory.

## 8. Evals (`evals/`)

`cases.json` encodes CLAUDE.md tests A–F. The runner (`evals/run.ts`) executes the real pipeline in an isolated database and storage, then records:

- **deterministic pass/fail checks**: EDL validity, duration, aspect ratio, readable file, required streams, permission enforcement, invalid-file rejection, low-quality detection, honest upscaling label, conflict detection, revision scope;
- **an optional 1–5 rubric** from a Claude judge looking at real frames (story coherence, asset relevance, pacing, visual consistency, typography, stylistic fit), plus an invented-claims check.

Results go to `evals/results/` and each run is compared with the previous run of the same mode.

## 9. Technology choices

| Choice | Why |
|---|---|
| Next.js 16 + React 19 + TypeScript (strict) + Tailwind 4 | One codebase for UI and API; server routes keep secrets server-side |
| Prisma 6 + SQLite (local) | No database server needed locally; the schema is Postgres-portable |
| Zod 4 | One schema language for HTTP input, model output and EDLs; the Anthropic SDK converts it to JSON Schema for structured outputs |
| `@anthropic-ai/sdk` (beta messages, streaming, structured outputs, adaptive thinking) | Official SDK; streaming avoids HTTP timeouts on long planning calls |
| FFmpeg 7 static (npm `ffmpeg-static`) | Reproducible install without sudo; includes libass, x264 and every filter used |
| No Remotion (yet) | FFmpeg + libass covers the current typography needs; Remotion's licence needs a decision for companies |
| No Redis | A DB-backed queue is enough for a local, single-server app |
