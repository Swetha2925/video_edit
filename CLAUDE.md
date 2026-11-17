# ReelCraft AI --- Claude Build Instructions

> **Project:** ReelCraft AI\
> **Product:** An AI-powered creative video and reel production studio\
> **Primary goal:** Turn a user's prompt, photos, images, and video
> clips into polished, editable, high-quality social videos through an
> agentic workflow with a reliable harness, quality checks, and
> evaluation tests.

------------------------------------------------------------------------

# 1. Product vision

Build a real application, not a demo that only returns editing
suggestions.

A user should be able to: 1. Create a project. 2. Upload photos, images,
and video clips. 3. Describe the video they want in natural language. 4.
Choose a platform, aspect ratio, duration, language, and creative style.
5. Let the AI agent analyse the assets, plan the edit, create a
timeline, render the video, inspect the result, and improve it. 6.
Preview the result, request changes in plain language, and export the
final video.

The application should feel like having a creative director, a
professional editor, a motion designer, and a quality-control reviewer
in one assistant.

**Important:** Do not promise that a reel will go viral. Build for
strong creative quality, clarity, retention-friendly pacing, and
platform-appropriate output. Virality depends on audience, timing,
distribution, and many factors outside the application's control.

## Product name

Use **ReelCraft AI** as the working name. Keep the name configurable.

## Core product promise

"Give us your idea and your media. ReelCraft plans, edits, reviews, and
renders your video."

------------------------------------------------------------------------

# 2. Main user journey

Implement this end-to-end flow:

``` text
Create project
     |
     v
Upload photos / images / video clips
     |
     v
Enter creative prompt and output preferences
     |
     v
Agent analyses the prompt and media
     |
     v
Creative brief + storyboard
     |
     v
User reviews / approves plan
     |
     v
Agent creates structured edit decision list
     |
     v
Render engine builds video
     |
     v
Automated quality checks
     |
     v
Agent reviews evidence and fixes issues
     |
     v
Preview + user feedback
     |
     v
Final export
```

Allow the user to skip storyboard approval in a project setting, but
default to showing the plan before a long render. Never silently
overwrite a previous successful render.

## Example prompt

"Make a 30-second cinematic Kerala travel reel from these photos and
clips. Start with a strong visual hook, build an emotional journey, use
elegant text, smooth but not repetitive transitions, warm natural colour
grading, and a memorable ending. Keep it premium and not overly flashy."

The agent should turn this into a creative brief, storyboard, and
timeline before rendering.

------------------------------------------------------------------------

# 3. Product requirements

## 3.1 Project creation

Each project should store: - Project name and description - Original
user prompt - Target platform - Aspect ratio - Requested duration -
Output resolution and frame rate - Creative style and mood - Language
and caption preferences - Uploaded asset metadata - Storyboard
versions - Edit decision list (EDL) versions - Render jobs and output
files - Quality-control reports - User feedback and revision history

## 3.2 Media upload

Support: - JPEG, PNG, WebP - MP4 and MOV initially - Additional formats
only after validation and reliable support

Requirements: - Multiple file upload and drag-and-drop - Upload
progress, clear errors, retry - File size and duration limits configured
centrally - Safe filename handling - MIME type and actual file signature
validation - Generate thumbnails and metadata - Preserve originals;
never destructively modify uploaded files - Prevent path traversal and
unsafe file access - Store files outside publicly executable
directories - Make project ownership and access checks mandatory

For every asset, record: - Stable asset ID - Original filename - MIME
type - File size - Duration for video - Width and height - Orientation -
Frame rate where applicable - Thumbnail path - Upload timestamp -
Processing status

Use FFprobe to inspect media metadata. Generate thumbnails with FFmpeg.

## 3.3 Prompt understanding

The agent must extract: - Subject and story - Intended audience -
Platform - Duration - Aspect ratio - Mood and visual style - Pacing -
Music preference - Caption language - Required text - Content to avoid -
Desired ending or call to action

If essential information is missing, choose sensible defaults and
clearly show them. Ask a short clarification only when the missing
information would materially change the result.

## 3.4 Asset understanding

Use Claude vision capabilities to analyse supported images and selected
video keyframes. Do not send huge original videos to the model without a
deliberate strategy.

For videos: 1. Use FFprobe for technical metadata. 2. Extract
representative keyframes at controlled intervals or scene changes. 3.
Create a contact sheet when useful. 4. Ask the model to describe the
visible content of selected frames. 5. Keep timestamps attached to
observations.

For images, analyse: - Main subject - Scene and setting - People or
objects, where relevant - Composition - Orientation - Lighting -
Dominant colours - Visual quality - Possible role in the story - Whether
the image is blurry, dark, or unsuitable for a particular crop

Do not invent details about a photo. Mark uncertain observations as
uncertain.

The agent should recommend which assets to use and explain why. Let the
user exclude assets.

## 3.5 Creative direction

Offer style presets, but do not force every video into a template: -
Cinematic travel - Emotional memories - Minimal aesthetic - Fashion /
lifestyle - Food and product showcase - Event highlights - Documentary /
storytelling - Energetic montage - Professional business promo

The model should adapt the edit to the supplied content. Avoid random
effects, excessive zooms, repetitive transitions, unreadable text, and
unnecessary visual clutter.

## 3.6 Storyboard

Create a storyboard with: - Scene number - Start and end time - Selected
asset IDs - Purpose of the scene - Visual description - On-screen text -
Voice-over text if requested - Transition in and out - Motion
treatment - Music / sound cue - Reason for the creative choice

Example:

  ------------------------------------------------------------------------
  Scene                             Time Purpose          Treatment
  ---------------- --------------------- ---------------- ----------------
  1                             0--3 sec Hook             Strongest
                                                          visual, concise
                                                          opening text

  2                             3--8 sec Establish        Gentle movement
                                         setting          and location
                                                          context

  3                            8--18 sec Build story      Varied shots,
                                                          rhythm matched
                                                          to music

  4                           18--26 sec Emotional        Longer visual
                                         highlight        hold and
                                                          restrained
                                                          effects

  5                           26--30 sec Memorable finish Strong final
                                                          image and clean
                                                          ending
  ------------------------------------------------------------------------

These are illustrative timings, not a fixed template. Adapt to the
user's requested duration and media.

## 3.7 Timeline and editing

Create a structured edit decision list (EDL) in JSON. The EDL is the
source of truth for rendering. Do not ask the language model to generate
arbitrary shell commands or raw FFmpeg command strings.

The EDL should describe: - Output settings - Track and clip order -
Asset IDs - In/out points - Clip duration - Crop and fit behaviour -
Position and scale - Motion keyframes - Transitions - Text overlays -
Subtitle timing - Audio tracks - Volume and fade curves - Colour
adjustments - End card

Validate the EDL with a strict schema before rendering. Reject invalid
asset IDs, negative durations, out-of-range timestamps, unsupported
effects, and unsafe paths.

## 3.8 Professional visual quality

Quality targets: - Correct aspect ratio for the selected platform -
Sharp, correctly scaled images - No accidental stretching - No black
bars unless intentionally requested - Consistent and natural colour
treatment - Readable typography with safe margins - Captions
synchronised with speech when applicable - Smooth motion, not excessive
motion - Transitions that support the story - Balanced audio without
clipping - No accidental blank frames, frozen frames, or abrupt audio
cuts - Correct beginning and ending - No watermark unless the user
explicitly chooses one

Default social export: - Vertical 9:16 - 1080 x 1920 - H.264 video in
MP4 container - AAC audio - 30 fps unless source and creative
requirements justify another supported frame rate - High-quality bitrate
/ CRF settings, configurable and tested

Offer 4K export only when the source media, rendering environment, and
selected pipeline can genuinely support it. Upscaling a low-resolution
image does not create real source detail. Clearly label upscaling.

Do not claim that every export is lossless or true 4K.

## 3.9 Music and sound

-   Use user-uploaded audio, properly licensed tracks, or clearly
    identified royalty-free tracks whose licence permits the intended
    use.
-   Do not download music from social platforms or bypass DRM.
-   Store licence/source metadata for supplied music.
-   Offer music mood and tempo choices.
-   Duck background music under voice-over.
-   Apply fades and prevent clipping.
-   Do not add music if the user asks for silent output.
-   Do not imitate a specific living artist's voice.

## 3.10 Captions and voice-over

-   Support user-provided text.
-   Generate concise captions from the brief.
-   If speech transcription is implemented, use a dedicated
    speech-to-text component and retain timestamps.
-   Keep captions readable, correctly spelled, and within safe areas.
-   Do not cover important faces or visual subjects.
-   Voice-over must be optional.
-   Provide an easy way to edit generated text before rendering.

## 3.11 Preview and revision

The user should be able to say: - "Make the opening more exciting." -
"Use the beach photo first." - "Reduce the transitions." - "Make the
text smaller." - "Make the colours more natural." - "Use a slower,
emotional pace." - "Remove this clip." - "Make it 20 seconds."

Translate feedback into a controlled EDL revision. Preserve earlier
versions and let the user compare renders.

------------------------------------------------------------------------

# 4. Agent architecture

Use Claude as the reasoning and creative-planning model. Use
deterministic software tools for media processing and rendering. Claude
is not itself the video renderer.

``` text
                    USER
                     |
                     v
              REELCRAFT WEB APP
                     |
          Prompt + media + preferences
                     |
                     v
              AGENT ORCHESTRATOR
                     |
          +----------+-----------+
          |                      |
          v                      v
   CLAUDE MODEL             PROJECT STATE
   Creative reasoning      Assets / plans /
   Storyboard              versions / jobs
   EDL generation                 |
          |                       |
          +-----------+-----------+
                      |
                      v
                 TOOL LAYER
       +--------------+----------------+
       |              |                |
       v              v                v
   Media tools    Render tools     Audio tools
   FFprobe        FFmpeg           waveform
   thumbnails     Remotion         mixing
   keyframes      subtitles        fades
       |              |                |
       +--------------+----------------+
                      |
                      v
              QUALITY-CONTROL HARNESS
       Schema checks / technical checks /
       visual review / audio checks / evals
                      |
              Pass? --+-- Fail
                |          |
                v          v
             Export     Diagnose + revise
                |
                v
          USER PREVIEW
```

## Important architecture rule

Claude decides **what should be created**. The harness decides **how the
workflow is safely executed and verified**. FFmpeg / Remotion and other
deterministic tools perform the actual media work.

Do not let the model directly execute unrestricted shell commands.
Expose narrow, typed tools with validated inputs.

------------------------------------------------------------------------

# 5. What is the harness in this project?

A harness is the controlled environment around the model. It provides
tools, instructions, state, validation, execution rules, recovery, logs,
and evaluation.

For ReelCraft, implement these harness responsibilities:

1.  **Input validation:** Validate prompts, file types, file sizes,
    durations, and user permissions.
2.  **Context construction:** Give Claude the prompt, preferences, asset
    metadata, and selected visual observations.
3.  **Tool registry:** Expose only approved functions such as
    `inspect_media`, `create_storyboard`, `validate_edl`,
    `render_video`, and `inspect_render`.
4.  **State management:** Save the current project stage, plan version,
    render status, and previous successful output.
5.  **Schema validation:** Validate every model-generated storyboard and
    EDL.
6.  **Execution control:** Run tools with timeouts, resource limits, and
    clear status updates.
7.  **Retry and recovery:** Retry transient failures with limits; do not
    repeat expensive renders endlessly.
8.  **Quality gates:** Do not mark a render successful until required
    checks pass.
9.  **Observability:** Record tool calls, timings, errors, model usage,
    render settings, and quality reports.
10. **Evals:** Test whether the agent produces good plans, valid
    timelines, and technically sound videos.

The harness should be implemented as application code, not just
described in a prompt file.

## Example harness cycle

``` text
User request
   |
   v
Validate input
   |
   v
Build Claude context
   |
   v
Claude proposes storyboard + EDL
   |
   v
Validate JSON schema and asset references
   |
   +---- Invalid ----> Ask model to repair within retry limit
   |
   v
Render using approved media tools
   |
   v
Inspect rendered file
   |
   +---- Failed ----> Diagnose and revise within retry budget
   |
   v
Save successful version
   |
   v
Show preview to user
```

------------------------------------------------------------------------

# 6. Recommended technology stack

Choose a stack that is practical to build and maintain.

## Frontend

-   Next.js
-   React
-   TypeScript
-   Tailwind CSS
-   A polished, responsive dark editing-studio interface
-   Video preview player
-   Upload progress and render progress

## Backend

-   Next.js server routes or a separate Node.js API
-   TypeScript
-   Zod for request and EDL validation
-   PostgreSQL for persistent project data
-   Prisma ORM
-   Background job queue for long-running renders

## AI

-   Anthropic Claude API through server-side code
-   Structured JSON outputs validated with Zod
-   Vision input for image and selected video-frame analysis
-   Model name configurable through environment variables

Never expose the Anthropic API key in browser code.

## Media processing

-   FFmpeg and FFprobe for media inspection, conversion, composition,
    and export
-   Remotion for programmatic, timeline-driven video composition where
    appropriate
-   Image processing library for thumbnails and image preparation
-   Optional speech-to-text service or local model for transcription

Use FFmpeg for reliable media operations. Use Remotion when React-based
scene composition and animated typography provide value. Do not add
technologies just for the sake of adding them.

## Storage

-   Local development storage initially
-   An object-storage adapter for future deployment
-   Database stores metadata and references, not large binary media
    files

## Background processing

-   A job queue for analysis, thumbnail generation, rendering, and
    quality checks
-   Progress updates to the frontend using polling or server-sent events
-   Cancellation support where safe

## Testing

-   Vitest or Jest for unit tests
-   Playwright for end-to-end tests
-   Evals for agent quality
-   FFprobe-based technical verification of rendered files

Pin dependency versions and document installation steps.

------------------------------------------------------------------------

# 7. Agent tools to implement

Create small, typed, testable tools. Suggested contracts:

  -----------------------------------------------------------------------
  Tool                                Purpose
  ----------------------------------- -----------------------------------
  `inspect_media`                     Read metadata using FFprobe

  `generate_thumbnail`                Create a thumbnail

  `extract_keyframes`                 Extract representative video frames

  `analyse_assets`                    Return structured visual
                                      descriptions

  `create_creative_brief`             Convert user prompt into a
                                      structured brief

  `create_storyboard`                 Produce a timed scene plan

  `validate_storyboard`               Check duration, assets, and scene
                                      structure

  `create_edit_decision_list`         Produce structured editing
                                      instructions

  `validate_edl`                      Check the EDL schema and
                                      constraints

  `render_video`                      Render using the approved rendering
                                      pipeline

  `inspect_render`                    Inspect duration, resolution, frame
                                      rate, streams, and audio

  `extract_review_frames`             Extract frames from the output for
                                      visual review

  `run_quality_checks`                Run technical and visual checks

  `revise_edit`                       Apply user feedback to a new EDL
                                      version

  `export_video`                      Prepare the final output and
                                      metadata
  -----------------------------------------------------------------------

Each tool must have: - A typed input schema - A typed output schema -
Clear errors - A timeout - Structured logs - Permission checks - Tests

Tools must operate only on files belonging to the current authorised
project.

------------------------------------------------------------------------

# 8. Quality-control and self-review

The agent must not simply render once and announce success.

## Technical checks

Verify: - File exists and is non-empty - Container can be read - Video
stream exists - Audio stream exists when expected - Resolution matches
requested output - Aspect ratio is correct - Duration is within
tolerance - Frame rate is valid - No unexpected silent audio - No
unexpected black frames - No obvious frozen sections - No corrupt
output - Export is playable

Use FFprobe and suitable deterministic checks.

## Visual checks

Extract frames from the final render at sensible intervals. Use computer
vision and/or Claude vision to review: - Composition and cropping - Text
readability - Safe margins - Unexpected blank or black scenes - Image
stretching - Scene continuity - Visual variety - Whether the opening is
visually engaging - Whether the ending feels intentional

Automated visual review is imperfect. Show uncertain findings rather
than claiming perfect understanding.

## Audio checks

Check: - Peak level and clipping - Unexpected silence - Abrupt audio
endings - Audio duration - Music and voice-over balance where applicable

## Quality report

Every render should produce a report:

``` json
{
  "status": "passed",
  "technical_checks": {
    "file_readable": true,
    "resolution_correct": true,
    "duration_valid": true,
    "audio_valid": true
  },
  "creative_review": {
    "opening_hook": "good",
    "caption_readability": "good",
    "visual_consistency": "needs_review",
    "ending": "good"
  },
  "issues": [],
  "recommendations": []
}
```

This is an illustrative report schema. Implement and validate a real
schema.

------------------------------------------------------------------------

# 9. Evals: how to measure whether the agent works

Do not judge the agent only by whether it successfully calls Claude or
renders a file.

Build a repeatable evaluation set with sample prompts, sample assets,
expected constraints, and measurable checks.

## Core evaluation categories

  -----------------------------------------------------------------------
  Evaluation                          What it measures
  ----------------------------------- -----------------------------------
  Prompt understanding                Does the plan follow the user's
                                      request?

  Asset relevance                     Does it choose appropriate supplied
                                      media?

  Storyboard quality                  Is the story coherent and well
                                      paced?

  Duration accuracy                   Does the timeline match the
                                      requested length?

  EDL validity                        Is the output structurally valid?

  Rendering reliability               Does the render complete?

  Visual clarity                      Are subjects and text visible?

  Audio quality                       Is the audio balanced and clean?

  Revision accuracy                   Does feedback change the intended
                                      part?

  Safety and permissions              Does it use only authorised media
                                      and tools?
  -----------------------------------------------------------------------

## Example test cases

**Test A --- Travel reel** - Input: 12 travel photos and 3 clips. -
Prompt: Create a 30-second cinematic travel reel. - Expected: Correct
vertical format, relevant media selection, coherent story, valid
timeline, playable output.

**Test B --- Product promotion** - Input: 5 product images. - Prompt:
Create a premium 15-second product promo. - Expected: Product remains
visible, text is readable, no invented product claims, clean ending.

**Test C --- Low-quality media** - Input: Blurry and dark photos. -
Prompt: Create a beautiful reel. - Expected: Agent identifies
limitations, avoids misleading claims about HD detail, and asks
permission or chooses better assets where needed.

**Test D --- Conflicting instructions** - Input: 20-second duration and
a prompt asking for a 60-second video. - Expected: Agent detects the
conflict and asks which requirement to prioritise or clearly proposes a
resolution.

**Test E --- Revision** - Input: A completed 30-second reel. - Feedback:
"Make the first 3 seconds more engaging and keep everything else the
same." - Expected: Opening changes; unrelated scenes remain unchanged.

**Test F --- Invalid file** - Input: Unsupported or corrupted media. -
Expected: Clear error, no unsafe processing, no false success.

## Evaluation scoring

Use a rubric from 1 to 5 for subjective creative dimensions: - Story
coherence - Asset relevance - Pacing - Visual consistency - Typography -
Emotional / stylistic fit

Use deterministic pass/fail checks for: - EDL validity - Duration
tolerance - Aspect ratio - File readability - Required streams -
Permission enforcement

Do not rely on a single LLM score for quality. Combine objective checks,
rubric-based review, and human feedback. Keep evaluation results across
versions so improvements can be measured.

------------------------------------------------------------------------

# 10. UI pages

Build these pages:

1.  **Dashboard**
    -   New project
    -   Recent projects
    -   Render status
    -   Project thumbnails
2.  **Create project**
    -   Upload media
    -   Prompt input
    -   Platform and aspect ratio
    -   Duration
    -   Style and language settings
3.  **Creative plan**
    -   Creative brief
    -   Asset selections
    -   Storyboard
    -   Scene timing
    -   Approve or request changes
4.  **Editing workspace**
    -   Video preview
    -   Scene list or simple timeline
    -   Caption and audio settings
    -   Revision chat
    -   Render button
5.  **Render and quality report**
    -   Progress
    -   Technical checks
    -   Visual review findings
    -   Retry or revise options
6.  **Export**
    -   Final video preview
    -   Output settings
    -   Download
    -   Version history

Do not build a complicated professional NLE clone in the first version.
Focus on a clear, reliable AI-directed workflow.

------------------------------------------------------------------------

# 11. Security, privacy, and reliability

-   Keep all API keys on the server.
-   Use environment variables and provide `.env.example`.
-   Never commit secrets.
-   Validate every upload and every model-generated object.
-   Enforce user and project ownership on every operation.
-   Restrict file access to project storage roots.
-   Never execute model-generated shell commands.
-   Use argument arrays rather than shell string concatenation when
    launching media tools.
-   Apply timeouts, resource limits, and file-size limits.
-   Clean up temporary files safely.
-   Preserve original uploads and previous successful exports.
-   Do not send user media to third-party services without making the
    processing clear.
-   Add a deletion workflow for projects and their stored media.
-   Log enough to debug failures without unnecessarily logging private
    media content.

------------------------------------------------------------------------

# 12. Cost and deployment expectations

The application can use open-source rendering tools locally, but Claude
API calls, cloud hosting, storage, and some speech or media services may
incur costs.

Build a local development mode. Make model calls configurable. Add usage
tracking and render limits. Do not claim the complete hosted product is
free unless every service and usage limit has been verified.

The first version should run locally with documented setup instructions.
Keep deployment configuration separate from local development.

------------------------------------------------------------------------

# 13. Development phases

Build incrementally. Do not attempt every advanced feature in one step.

## Phase 1 --- Working foundation

-   Set up the project
-   Build dashboard and project creation
-   Upload images and videos
-   Inspect media with FFprobe
-   Store project metadata
-   Create a basic playable video from selected assets
-   Verify export with FFprobe

**Acceptance:** A user can upload media and produce a valid vertical
MP4.

## Phase 2 --- Claude creative agent

-   Integrate Claude server-side
-   Prompt understanding
-   Image analysis
-   Creative brief
-   Storyboard generation
-   Strict JSON schemas
-   EDL generation and validation

**Acceptance:** The agent creates a valid, reviewable editing plan from
a real prompt and uploaded assets.

## Phase 3 --- Professional rendering

-   Add timeline-based composition
-   Text animation
-   Crop and motion
-   Transitions
-   Audio mixing
-   Subtitles
-   Output presets

**Acceptance:** The output follows the approved storyboard and export
settings.

## Phase 4 --- Harness and self-review

-   Tool registry
-   State machine
-   Retry budgets
-   Timeouts
-   Logs
-   Render inspection
-   Visual review frames
-   Quality reports

**Acceptance:** Failed or invalid renders are detected; the app never
reports false success.

## Phase 5 --- Evals and revision

-   Build evaluation dataset
-   Add automated tests
-   Add creative rubric
-   Support natural-language revisions
-   Preserve version history
-   Compare quality across versions

**Acceptance:** A revision request changes the intended section without
unexpectedly damaging unrelated sections.

## Phase 6 --- Polish

-   Responsive design
-   Better progress feedback
-   Accessible controls
-   Helpful error messages
-   Documentation
-   Performance improvements
-   Deployment readiness

------------------------------------------------------------------------

# 14. Instructions for Claude Code

You are the lead engineer, AI agent architect, product designer, and
implementation partner for ReelCraft AI.

Follow these rules throughout development:

1.  First inspect the existing repository and report its current
    structure. Do not overwrite existing work blindly.
2.  Create a short implementation plan with milestones and acceptance
    criteria.
3.  Explain important architectural decisions in beginner-friendly
    language in the project documentation.
4.  Implement a working feature at a time. Do not generate a huge amount
    of disconnected placeholder code.
5.  Use TypeScript and strict types.
6.  Use Zod to validate user input and model output.
7.  Keep the Claude API key server-side.
8.  Build the harness as real, testable application code.
9.  Use FFmpeg / FFprobe for actual media processing and verification.
10. Use Remotion only where it adds value to timeline-based visual
    composition.
11. Never fake a completed render. A success state requires a real
    output file and successful verification.
12. Never use hardcoded fake progress as if a render were actually
    progressing.
13. Show errors in the UI and log actionable technical details.
14. Add unit tests for important logic and integration tests for media
    processing.
15. Add Evals for agent quality and regression tests for previously
    working prompts.
16. Do not claim a video is HD, 4K, or professional-quality without
    checking the actual output properties.
17. Keep the UI clean, premium, modern, and easy for a beginner to use.
18. Do not add unnecessary features before the end-to-end workflow
    works.
19. Ask before introducing paid external services or sending user media
    to a new external provider.
20. After each milestone, report what works, what was tested, what
    remains, and how to run it.

## First task --- do not skip

Before writing implementation code:

-   Inspect the repository.
-   Identify the existing framework and installed dependencies.
-   Identify whether FFmpeg and FFprobe are available.
-   Identify existing environment variables without printing secret
    values.
-   Present a proposed architecture and phased plan.
-   Identify any missing prerequisites.

Then begin Phase 1. Do not stop after producing a plan; continue
implementing the first working milestone unless a genuine blocker
requires user input.

## Definition of done

A feature is not complete merely because its UI exists.

It is complete only when: - The real backend behaviour is implemented. -
Inputs are validated. - Errors are handled. - Relevant tests pass. - The
feature is documented. - Its result can be demonstrated in the
application.

------------------------------------------------------------------------

# 15. First demo scenario

Use this as the initial end-to-end demonstration:

**User uploads:** - 8 travel photos - 2 short video clips - 1 licensed
background music track

**User prompt:**

"Create a 30-second premium cinematic travel reel. Use the strongest
photo as the opening hook. Build a beautiful story from the journey, use
smooth transitions, natural warm colour grading, elegant captions, and
emotional music. Keep the visuals clear and avoid excessive effects.
Export as a vertical Instagram Reel."

**Expected agent behaviour:** 1. Inspect all 10 media assets. 2. Create
thumbnails and analyse the visual content. 3. Recommend an asset
sequence. 4. Generate a 30-second storyboard. 5. Validate the storyboard
and EDL. 6. Show the plan to the user. 7. Render the actual MP4. 8.
Inspect the rendered output. 9. Produce a quality report. 10. Show the
final preview and export option.

This should be the first complete demonstration before adding more
complex styles or features.

------------------------------------------------------------------------

# Final product principle

ReelCraft AI should not be just a prompt-to-video wrapper.

It should be an **agentic editing system** with creative reasoning,
controlled tools, a persistent workflow, real rendering, measurable
quality checks, and continuous improvement.

The experience should be simple for the user, while the engineering
underneath should be reliable, observable, testable, and safe.
