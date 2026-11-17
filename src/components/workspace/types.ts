import type { AssetAnalysis, CreativeBrief, QualityReport, Storyboard } from "@/lib/schemas";

export interface AssetView {
  id: string;
  kind: "image" | "video" | "audio";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  orientation: string | null;
  fps: number | null;
  hasAudio: boolean;
  status: string;
  excluded: boolean;
  hasThumbnail: boolean;
  metrics: { brightness: number; blur: number; dark: boolean; veryDark: boolean; soft: boolean; blurry: boolean; notes: string[] } | null;
  audio: { bpm: number | null; bpmConfidence: number; peakDb: number; rmsDb: number; durationSec: number } | null;
  analysis: AssetAnalysis | null;
  license: { source: string; license: string; attribution: string } | null;
}

export interface RenderView {
  id: string;
  version: number;
  edlVersion: number;
  status: string;
  label: string;
  hasFile: boolean;
  sizeBytes: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  renderMs: number | null;
  autoFixAttempt: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  qc: QualityReport | null;
}

export interface JobView {
  id: string;
  type: string;
  status: string;
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
}

export interface ProjectDetail {
  project: {
    id: string;
    name: string;
    description: string;
    prompt: string;
    platform: string;
    aspectRatio: string;
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    style: string;
    mood: string;
    language: string;
    captionsEnabled: boolean;
    musicPreference: string;
    silentOutput: boolean;
    requireApproval: boolean;
    stage: string;
    stageLabel: string;
    stageMessage: string;
    resolution: string;
  };
  assets: AssetView[];
  brief: (CreativeBrief & { version: number }) | null;
  storyboard: { version: number; source: string; note: string; approved: boolean; parentVersion: number | null; createdAt: string; data: Storyboard } | null;
  storyboardVersions: { version: number; source: string; note: string; approved: boolean; parentVersion: number | null; createdAt: string }[];
  renders: RenderView[];
  jobs: JobView[];
  events: { id: string; level: string; kind: string; message: string; createdAt: string }[];
  feedback: { id: string; message: string; status: string; summary: string; fromStoryboardVer: number | null; toStoryboardVer: number | null; createdAt: string }[];
  usage: { modelCalls: number; inputTokens: number; outputTokens: number };
}

export interface SystemInfo {
  ai: { configured: boolean; model: string };
  media: { ok: boolean };
  limits: { maxImageBytes: number; maxVideoBytes: number; maxAudioBytes: number };
  accept: string;
}
