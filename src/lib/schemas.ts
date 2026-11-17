import { z } from "zod";
import {
  ASPECT_RATIOS,
  COLOR_GRADE_IDS,
  FIT_MODE_IDS,
  MOTION_IDS,
  MOTION_INTENSITIES,
  PLATFORM_IDS,
  STYLE_IDS,
  TEXT_ANIMATIONS,
  TEXT_POSITIONS,
  TEXT_STYLES,
  TRANSITION_IDS,
  TYPOGRAPHY_IDS,
} from "./presets";

/* ------------------------------------------------------------------ */
/* Project input                                                       */
/* ------------------------------------------------------------------ */

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1, "Give your project a name").max(120),
  description: z.string().trim().max(2000).default(""),
  prompt: z.string().trim().max(4000).default(""),
  platform: z.enum(PLATFORM_IDS).default("instagram_reels"),
  aspectRatio: z.enum(ASPECT_RATIOS).default("9:16"),
  durationSec: z.number().min(5).max(180).default(30),
  resolution: z.enum(["720p", "1080p", "2160p"]).default("1080p"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
  style: z.enum(STYLE_IDS).default("cinematic_travel"),
  mood: z.string().trim().max(200).default(""),
  language: z.string().trim().min(2).max(40).default("en"),
  captionsEnabled: z.boolean().default(true),
  musicPreference: z.string().trim().max(300).default(""),
  silentOutput: z.boolean().default(false),
  requireApproval: z.boolean().default(true),
});
export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export const ProjectUpdateSchema = ProjectInputSchema.partial();

/* ------------------------------------------------------------------ */
/* Creative brief                                                      */
/* ------------------------------------------------------------------ */

export const CreativeBriefSchema = z.object({
  title: z.string().max(120),
  subject: z.string().max(600),
  story: z.string().max(1500),
  audience: z.string().max(300),
  platform: z.string().max(60),
  durationSec: z.number().min(3).max(600),
  aspectRatio: z.enum(ASPECT_RATIOS),
  mood: z.array(z.string().max(40)).max(8),
  visualStyle: z.string().max(400),
  pacing: z.enum(["slow", "medium", "fast", "dynamic"]),
  musicPreference: z.string().max(300),
  captionLanguage: z.string().max(40),
  requiredText: z.array(z.string().max(200)).max(10),
  avoid: z.array(z.string().max(200)).max(12),
  ending: z.string().max(300),
  hookIdea: z.string().max(400),
  colorGrade: z.enum(COLOR_GRADE_IDS),
  typography: z.enum(TYPOGRAPHY_IDS),
  assumptions: z.array(z.string().max(300)).max(12),
  conflicts: z
    .array(z.object({ topic: z.string().max(120), description: z.string().max(500), proposedResolution: z.string().max(400) }))
    .max(6),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().max(500).nullable(),
  qualityConcerns: z.array(z.string().max(300)).max(10),
});
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;

/* ------------------------------------------------------------------ */
/* Asset analysis (vision)                                             */
/* ------------------------------------------------------------------ */

export const STORY_ROLES = ["hook", "establishing", "detail", "people", "transition", "emotional_peak", "closing", "b_roll"] as const;

export const AssetAnalysisSchema = z.object({
  summary: z.string().max(400),
  mainSubject: z.string().max(200),
  setting: z.string().max(200),
  people: z.string().max(200),
  objects: z.array(z.string().max(60)).max(12),
  composition: z.string().max(300),
  lighting: z.string().max(200),
  dominantColors: z.array(z.string().max(30)).max(6),
  visualQuality: z.enum(["excellent", "good", "fair", "poor"]),
  qualityIssues: z.array(z.string().max(200)).max(8),
  storyRoles: z.array(z.enum(STORY_ROLES)).max(4),
  hookStrength: z.number().int().min(1).max(5),
  focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  verticalCropSuitability: z.enum(["good", "tight", "unsuitable"]),
  uncertainObservations: z.array(z.string().max(200)).max(6),
  moments: z
    .array(z.object({ startSec: z.number().min(0), endSec: z.number().min(0), description: z.string().max(200), quality: z.enum(["strong", "usable", "weak"]) }))
    .max(10),
  recommended: z.boolean(),
  recommendationReason: z.string().max(300),
  /** Who produced the analysis: Claude vision, or on-device measurements. */
  analyzer: z.enum(["claude_vision", "local_metrics"]).default("claude_vision"),
});
export type AssetAnalysis = z.infer<typeof AssetAnalysisSchema>;

/* ------------------------------------------------------------------ */
/* Storyboard — the creative plan (source of creative intent)          */
/* ------------------------------------------------------------------ */

export const SceneTextSchema = z.object({
  content: z.string().trim().min(1).max(120),
  style: z.enum(TEXT_STYLES),
  position: z.enum(TEXT_POSITIONS),
  animation: z.enum(TEXT_ANIMATIONS),
});
export type SceneText = z.infer<typeof SceneTextSchema>;

export const SceneSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,24}$/),
  purpose: z.string().max(120),
  durationSec: z.number().min(0.6).max(30),
  assetId: z.string().min(8).max(64),
  /** For video assets: where in the source the scene starts (seconds). Ignored for images. */
  sourceInSec: z.number().min(0).max(36000),
  fit: z.enum(FIT_MODE_IDS),
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable(),
  motion: z.enum(MOTION_IDS),
  motionIntensity: z.enum(MOTION_INTENSITIES),
  transitionIn: z.object({ type: z.enum(TRANSITION_IDS), durationSec: z.number().min(0).max(2) }),
  text: SceneTextSchema.nullable(),
  useClipAudio: z.boolean(),
  clipAudioVolume: z.number().min(0).max(1.5),
  visualDescription: z.string().max(400),
  musicCue: z.string().max(200),
  reason: z.string().max(400),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z.object({
  title: z.string().max(120),
  logline: z.string().max(400),
  colorGrade: z.enum(COLOR_GRADE_IDS),
  gradeIntensity: z.number().min(0).max(1),
  typography: z.enum(TYPOGRAPHY_IDS),
  music: z
    .object({
      assetId: z.string().min(8).max(64),
      startSec: z.number().min(0).max(3600),
      volume: z.number().min(0).max(1.5),
      beatSync: z.boolean(),
    })
    .nullable(),
  endCard: z.object({ text: z.string().trim().min(1).max(80), subtext: z.string().max(80).nullable() }).nullable(),
  fadeOutEnding: z.boolean(),
  /** Global multiplier for on-screen text size (used by "make the text smaller/bigger"). */
  textScale: z.number().min(0.7).max(1.4).optional(),
  scenes: z.array(SceneSchema).min(1).max(60),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/* ------------------------------------------------------------------ */
/* Revision patch — controlled edits from natural-language feedback   */
/* ------------------------------------------------------------------ */

const ScenePatchFields = SceneSchema.omit({ id: true }).partial();

export const RevisionOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update_scene"), sceneId: z.string(), changes: ScenePatchFields }),
  z.object({ op: z.literal("remove_scene"), sceneId: z.string() }),
  z.object({ op: z.literal("insert_scene"), afterSceneId: z.string().nullable(), scene: SceneSchema }),
  z.object({ op: z.literal("move_scene"), sceneId: z.string(), afterSceneId: z.string().nullable() }),
  z.object({
    op: z.literal("update_global"),
    changes: StoryboardSchema.pick({ colorGrade: true, gradeIntensity: true, typography: true, music: true, endCard: true, fadeOutEnding: true, title: true, textScale: true }).partial(),
  }),
  z.object({ op: z.literal("set_total_duration"), durationSec: z.number().min(3).max(600) }),
]);
export type RevisionOp = z.infer<typeof RevisionOpSchema>;

export const RevisionPlanSchema = z.object({
  understanding: z.string().max(600),
  ops: z.array(RevisionOpSchema).max(40),
  untouchedSceneIds: z.array(z.string()).max(60),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().max(400).nullable(),
});
export type RevisionPlan = z.infer<typeof RevisionPlanSchema>;

/* ------------------------------------------------------------------ */
/* EDL — exact, validated render instructions (render source of truth) */
/* ------------------------------------------------------------------ */

export const GradeSchema = z.object({
  preset: z.enum(COLOR_GRADE_IDS),
  intensity: z.number().min(0).max(1),
  /** Per-asset exposure correction from deterministic metrics (−0.15…0.15). */
  exposureFix: z.number().min(-0.15).max(0.15),
});

export const EdlClipSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  assetId: z.string(),
  kind: z.enum(["image", "video"]),
  /** Project-relative path, e.g. "originals/<assetId>.jpg". Resolved through the storage guard. */
  source: z.string().regex(/^originals\/[a-zA-Z0-9-]+\.[a-z0-9]{2,5}$/),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  sourceDurationSec: z.number().positive().nullable(),
  /** Media in-point (video only). */
  inSec: z.number().min(0),
  /** Total frames this clip contributes, including transition overlaps. */
  frames: z.number().int().positive(),
  timelineStartFrame: z.number().int().min(0),
  fit: z.enum(FIT_MODE_IDS),
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  motion: z.object({
    type: z.enum(MOTION_IDS),
    zoomFrom: z.number().min(1).max(1.6),
    zoomTo: z.number().min(1).max(1.6),
    xFrom: z.number().min(0).max(1),
    xTo: z.number().min(0).max(1),
    yFrom: z.number().min(0).max(1),
    yTo: z.number().min(0).max(1),
  }),
  grade: GradeSchema,
  transitionIn: z.object({ type: z.enum(TRANSITION_IDS), frames: z.number().int().min(0) }),
  audio: z.object({ use: z.boolean(), volume: z.number().min(0).max(1.5) }),
  upscaled: z.boolean(),
});
export type EdlClip = z.infer<typeof EdlClipSchema>;

export const EdlTextSchema = z.object({
  id: z.string(),
  sceneId: z.string().nullable(),
  lines: z.array(z.string().min(1).max(60)).min(1).max(4),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  font: z.string(),
  sizePx: z.number().int().min(16).max(400),
  bold: z.boolean(),
  italic: z.boolean(),
  uppercase: z.boolean(),
  spacingPx: z.number().min(0).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Anchor point in output pixels. */
  x: z.number().int(),
  y: z.number().int(),
  align: z.enum(["top", "center", "bottom"]),
  animation: z.enum(TEXT_ANIMATIONS),
  /** Draw a translucent box behind the text (label style) for busy backgrounds. */
  boxed: z.boolean().default(false),
  fadeInMs: z.number().int().min(0).max(3000),
  fadeOutMs: z.number().int().min(0).max(3000),
  /** Estimated rendered box, used for safe-area validation. */
  box: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }),
});
export type EdlText = z.infer<typeof EdlTextSchema>;

export const EdlSchema = z.object({
  schemaVersion: z.literal(1),
  output: z.object({
    width: z.number().int().min(240).max(4096).refine((v) => v % 2 === 0, "width must be even"),
    height: z.number().int().min(240).max(4096).refine((v) => v % 2 === 0, "height must be even"),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
    totalFrames: z.number().int().positive(),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac"),
    pixFmt: z.literal("yuv420p"),
    crf: z.number().int().min(0).max(35),
    preset: z.string(),
  }),
  platform: z.string(),
  safeArea: z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() }),
  clips: z.array(EdlClipSchema).min(1).max(80),
  texts: z.array(EdlTextSchema).max(120),
  music: z
    .object({
      assetId: z.string(),
      source: z.string().regex(/^originals\/[a-zA-Z0-9-]+\.[a-z0-9]{2,5}$/),
      startSec: z.number().min(0),
      sourceDurationSec: z.number().positive(),
      volume: z.number().min(0).max(1.5),
      fadeInSec: z.number().min(0).max(5),
      fadeOutSec: z.number().min(0).max(8),
      duckUnderClipAudio: z.boolean(),
    })
    .nullable(),
  fadeIn: z.object({ videoSec: z.number().min(0).max(2) }),
  fadeOut: z.object({ videoSec: z.number().min(0).max(3), audioSec: z.number().min(0).max(8) }),
  loudness: z.object({ targetLufs: z.number().min(-24).max(-9), truePeakDb: z.number().min(-6).max(0) }),
  /** Timeline ranges that are intentionally dark/static (QC must not flag them). */
  intentional: z.object({
    darkRanges: z.array(z.tuple([z.number(), z.number()])),
    staticRanges: z.array(z.tuple([z.number(), z.number()])),
  }),
  expectsAudio: z.boolean(),
  warnings: z.array(z.string()),
});
export type Edl = z.infer<typeof EdlSchema>;

/* ------------------------------------------------------------------ */
/* Quality report                                                      */
/* ------------------------------------------------------------------ */

export const CheckResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "fail", "warn", "skipped"]),
  detail: z.string(),
  /** Whether a failure of this check blocks marking the render successful. */
  blocking: z.boolean(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ReviewRating = z.enum(["good", "needs_review", "poor", "not_assessed"]);

export const QcIssueSchema = z.object({
  source: z.enum(["technical", "audio", "visual", "creative"]),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
  timeSec: z.number().nullable(),
  sceneId: z.string().nullable(),
  suggestedFix: z.string(),
  certainty: z.enum(["confirmed", "likely", "uncertain"]),
});
export type QcIssue = z.infer<typeof QcIssueSchema>;

export const QualityReportSchema = z.object({
  status: z.enum(["passed", "passed_with_warnings", "failed"]),
  generatedAt: z.string(),
  output: z.object({
    width: z.number().nullable(),
    height: z.number().nullable(),
    fps: z.number().nullable(),
    durationSec: z.number().nullable(),
    videoCodec: z.string().nullable(),
    audioCodec: z.string().nullable(),
    sizeBytes: z.number().nullable(),
    bitrateKbps: z.number().nullable(),
  }),
  technicalChecks: z.array(CheckResultSchema),
  audioChecks: z.array(CheckResultSchema),
  visualChecks: z.array(CheckResultSchema),
  creativeReview: z.object({
    assessedBy: z.enum(["claude_vision", "local_heuristics", "not_available"]),
    openingHook: ReviewRating,
    captionReadability: ReviewRating,
    visualConsistency: ReviewRating,
    composition: ReviewRating,
    ending: ReviewRating,
    summary: z.string(),
  }),
  issues: z.array(QcIssueSchema),
  recommendations: z.array(z.string()),
  reviewFrames: z.array(z.object({ timeSec: z.number(), path: z.string() })),
  contactSheet: z.string().nullable(),
  qualityLabel: z.string(),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;
