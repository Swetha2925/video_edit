/** Asset facts the planner/compiler/validator need (all project-scoped). */
export interface PlanAsset {
  id: string;
  kind: "image" | "video" | "audio";
  storedName: string;
  originalName: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasAudio: boolean;
  excluded: boolean;
  status: string;
  brightness?: number;
  blur?: number;
  focalPoint?: { x: number; y: number };
  beats?: number[];
  bpm?: number | null;
}

export interface CompileProject {
  platform: string;
  width: number;
  height: number;
  fps: 24 | 25 | 30 | 60;
  durationSec: number;
  silentOutput: boolean;
}

export interface CompileContext {
  project: CompileProject;
  assets: Map<string, PlanAsset>;
  render: { crf: number; preset: string };
  maxOutputDurationSec: number;
}

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
