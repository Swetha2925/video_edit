# ReelCraft AI

**Give us your idea and your media. ReelCraft plans, edits, reviews, and renders your video.**

ReelCraft AI is an agentic video studio. You upload photos, images, clips and licensed music, describe the video you want, and an AI agent (Claude):

1. analyses your media (vision for images and video keyframes, plus measured exposure and sharpness);
2. writes a creative brief and a timed storyboard, which you review and can edit;
3. compiles that plan into a frame-exact edit decision list (EDL);
4. renders a **real** MP4 with FFmpeg, including transitions, Ken Burns motion, colour grading, animated typography, beat-synced cuts and loudness-normalised audio;
5. **inspects the actual file** (probe, full decode, black/frozen/silence/clipping detection, review frames, and a Claude vision review);
6. fixes what it finds within a bounded retry budget, and only then shows you the result;
7. revises from plain-language feedback ("make the opening more exciting"), changing only what you asked for.

> ReelCraft optimises for clarity, pacing and platform-correct output. It does not, and cannot, promise virality.

---

## Quick start

```bash
npm install          # installs pinned dependencies, including FFmpeg/FFprobe static binaries
npm run setup        # creates .env, the SQLite database, and checks the media engine
npm run dev          # http://localhost:3000
```

Requirements: Node.js ≥ 20.9 (tested on 22). No system FFmpeg, Docker or PostgreSQL is needed for local development.

### Enable the AI agent

Add your key to `.env` and restart:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5-5     # configurable
ANTHROPIC_EFFORT=high               # low | medium | high | xhigh | max
```

**Costs:** Claude API calls are billed per token by Anthropic. A typical project uses about 1 vision call per asset, plus a brief, a storyboard, one creative review per render, and one call per revision. Per-project limits are enforced (`MAX_MODEL_CALLS_PER_PROJECT`), and usage is shown in the workspace. Requests opt into Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a safety-classifier decline is retried on a fallback model within the same call.

**Without a key** the app still works end to end with **Basic assembly (no AI)**. This deterministic planner opens on the best-measured shot, applies the style preset, and renders and quality-checks a real video. It is clearly labelled everywhere.

**Privacy:** with a key set, downscaled images (≤1024 px) and video keyframes are sent to the Anthropic API for analysis and review. Original files never leave your machine.

---

## Using the app

1. **Dashboard**: create a project and see recent projects with live render progress.
2. **New project**: enter a prompt and choose platform, duration, resolution, frame rate, style, caption language, music preference, silent output, and whether to review the plan before rendering (the default).
3. **Media**: drag and drop files. Each file shows real upload progress. Files are validated by signature and FFprobe, then thumbnails and quality flags (dark, blurry, low resolution) are generated. You can exclude or delete any file. Music asks for licence/source information.
4. **Creative plan**: shows the brief (with the defaults the agent chose, any conflicts, and media limitations), the timeline, and each scene with its asset, timing, transition, motion, framing and reasoning. You can edit on-screen text directly; saving creates a new storyboard version.
5. **Render & QC**: shows FFmpeg-reported progress (never simulated), the video preview, every check with its measured value, the creative review, findings with certainty levels, and the frames that were reviewed.
6. **Export**: download the latest render that passed QC, see measured output properties, compare versions side by side, and browse the full version history.
7. **Ask for changes** (side panel): plain-language revisions become controlled storyboard edits followed by a new render. Earlier versions are always kept.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server (also starts the background job worker) |
| `npm run build && npm start` | Production build and server |
| `npm test` | Unit and integration tests (Vitest). Integration tests render real videos with FFmpeg |
| `npm run test:ui` | Playwright UI end-to-end test (uses a running server or starts one) |
| `npm run e2e` | HTTP end-to-end smoke test against a running server (`E2E_MODE=ai` to use Claude) |
| `npm run eval` | Offline agent evaluation (cases A–F, deterministic checks) |
| `npm run eval -- --ai` | Full Claude evaluation with rubric judge (**uses the Claude API, which incurs cost**) |
| `npm run demo:assets` | Generates 8 photos, 2 clips and 1 music track into `./demo-assets` (synthetic, licence-free) |
| `npm run typecheck` | TypeScript strict check |

---

## How it works (short version)

```
Browser ──► Next.js API routes (validation, ownership checks)
                 │ enqueue
                 ▼
          Job queue (SQLite) ──► Worker ──► Orchestrator (harness)
                                              │
            ┌─────────────────────────────────┼──────────────────────────┐
            ▼                                 ▼                          ▼
     Claude (via one client)          Tool registry (typed)        Quality gates
     brief · storyboard ·             inspect_media · render_video   technical · audio ·
     revisions · review               validate_edl · inspect_render  visual · creative
            │                                 │
            └──────── structured JSON ────────┤
                      (Zod-validated)         ▼
                                   FFmpeg / FFprobe (argument arrays only)
```

**Claude decides what to create; the harness decides how it is executed and verified; FFmpeg does the media work.** The model never produces shell commands or FFmpeg strings. For the full explanation, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Configuration

All limits live in `.env` (see `.env.example`): file sizes, video length, assets per project, maximum output duration, renders and AI calls per project, the auto-fix render budget, x264 CRF and preset, and the render timeout.

### Switching to PostgreSQL

Change `provider = "sqlite"` to `"postgresql"` in `prisma/schema.prisma`, set `DATABASE_URL`, and run `npx prisma db push`. JSON documents are stored as Zod-validated strings, so no model changes are needed.

---

## Honest limitations (current version)

- **Rendering speed:** about 3–4× real time on a 4-core CPU at 1080×1920 (for example, a 30 s reel with 15 clips takes about 110 s). 4K takes proportionally longer. Upscaled sources are labelled; upscaling adds no detail.
- **Voice-over and speech captions** are not implemented. That would need a TTS or speech-to-text service, which is a new external provider, so I'll ask before adding one. On-screen captions are generated from the brief and can be edited.
- **Remotion** is not used. Everything renders with FFmpeg plus libass typography. Remotion's licence requires a paid company licence for organisations above 3 people, so it should be a deliberate decision.
- **Auth** is local-first: a signed per-browser cookie identifies a local user, and all ownership checks are enforced. Use a real identity provider before any hosted deployment.
- **The Claude-backed paths** are covered by integration tests with a scripted model and by `npm run eval -- --ai`. They have not been run against the live API in this environment, because no key was configured.
- The bundled FFprobe is 4.0 (pinned npm binary) and FFmpeg is 7.0.2. Set `FFPROBE_PATH` / `FFMPEG_PATH` to use system builds.
- `npm audit` reports `deepmerge-ts` via the Prisma 6 CLI. This is a development-time tool only and is not shipped in the app.
