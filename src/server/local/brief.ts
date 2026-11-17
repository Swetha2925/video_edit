import { CreativeBriefSchema, type CreativeBrief } from "@/lib/schemas";
import { PLATFORMS, STYLES, type ColorGrade, type Platform, type StyleId, type TypographyId } from "@/lib/presets";
import type { AgentAsset, AgentProject } from "../agent/context";

/**
 * On-device prompt understanding. Deterministic language rules extract the creative
 * intent from the user's request. It never invents facts: on-screen words come only from
 * text the user wrote (quoted text, title, call to action).
 */

const WORD_NUM: Record<string, number> = {
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, "twenty-five": 25, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60, ninety: 90,
};

export function parseDurationSec(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bhalf (a|an) minute\b/.test(t)) return 30;
  const num = /(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m)\b/.exec(t);
  if (num) {
    const v = Number(num[1]);
    const unit = num[2] as string;
    if (Number.isFinite(v) && v > 0) return unit.startsWith("m") ? v * 60 : v;
  }
  const word = /\b(five|six|seven|eight|nine|ten|twelve|fifteen|twenty-five|twenty|thirty|forty-five|forty|fifty|sixty|ninety)\s*(?:-|\s)\s*(seconds?|second|sec)\b/.exec(t);
  if (word) return WORD_NUM[word[1] as string] ?? null;
  if (/\b(a|one)\s*(?:-|\s)\s*minute\b/.test(t)) return 60;
  if (/\btwo\s*(?:-|\s)\s*minutes?\b/.test(t)) return 120;
  return null;
}

export function extractQuoted(text: string): string[] {
  const out: string[] = [];
  const re = /["“”]([^"“”]{2,80})["“”]|(?:^|\s)'([^']{2,80})'(?=\s|[.,!?]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MOODS = ["cinematic", "emotional", "warm", "nostalgic", "uplifting", "energetic", "calm", "peaceful", "romantic", "playful", "premium", "luxurious", "dramatic", "joyful", "elegant", "moody", "minimal", "fun", "inspiring", "dreamy", "heartfelt", "bold", "serene", "adventurous"];

const has = (t: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(t));

export function detectGrade(t: string, fallback: ColorGrade): ColorGrade {
  if (has(t, "black and white", "black & white", "monochrome", "b&w", "grayscale", "greyscale")) return "black_white";
  if (has(t, "vintage", "retro", "film look", "filmic", "nostalgic", "old film")) return "vintage_film";
  if (has(t, "teal", "orange and teal", "blockbuster")) return "cinematic_teal_orange";
  if (has(t, "moody", "dark and moody", "noir")) return "moody_dark";
  if (has(t, "vibrant", "colourful", "colorful", "saturated", "punchy colours", "punchy colors", "bold colours", "bold colors")) return "vibrant";
  if (has(t, "airy", "pastel", "light and bright", "bright and airy")) return "bright_airy";
  if (has(t, "cool tones", "cool colour", "cool color", "crisp", "clean look")) return "cool_crisp";
  if (has(t, "warm", "golden", "sunlit", "sunset tones")) return "warm_natural";
  if (has(t, "natural", "true to life", "realistic colours", "realistic colors")) return "natural";
  if (has(t, "cinematic")) return fallback === "natural" ? "cinematic_teal_orange" : fallback;
  return fallback;
}

export function detectTypography(t: string, fallback: TypographyId): TypographyId {
  if (has(t, "handwritten", "script font", "cursive")) return "handwritten";
  if (has(t, "bold text", "bold typography", "impact", "big bold")) return "bold_display";
  if (has(t, "elegant", "serif", "luxury", "luxurious", "premium", "classy")) return "elegant_serif";
  if (has(t, "classic", "timeless", "editorial")) return "classic_garamond";
  if (has(t, "minimal", "minimalist", "simple text")) return "minimal";
  if (has(t, "modern", "clean text", "sans")) return "modern_sans";
  return fallback;
}

export function detectPacing(t: string, fallback: CreativeBrief["pacing"]): CreativeBrief["pacing"] {
  const slow = has(t, "slow", "slower", "calm", "gentle", "relaxed", "peaceful", "emotional", "unhurried", "serene");
  const fast = has(t, "fast", "faster", "energetic", "punchy", "quick", "upbeat", "hype", "high energy", "dynamic", "snappy");
  if (fast && slow) return "dynamic";
  if (fast) return "fast";
  if (slow) return "slow";
  return fallback;
}

function extractAvoid(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:avoid|without|no|don't use|do not use|not too|not overly|never)\s+([a-z][a-z \-']{2,60}?)(?=[.,;!?]|\band\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = (m[1] as string).trim();
    if (v && !/^(more than|longer than)/.test(v)) out.push(v.replace(/^(overly|too) /, "overly "));
  }
  return [...new Set(out)].slice(0, 12);
}

export interface LocalBriefInput {
  project: AgentProject;
  assets: AgentAsset[];
  clarification?: string | null;
}

export function createLocalBrief({ project, assets, clarification }: LocalBriefInput): CreativeBrief {
  const prompt = project.prompt.trim();
  const all = `${prompt}\n${project.mood}\n${project.musicPreference}`;
  const style = (project.style in STYLES ? project.style : "cinematic_travel") as StyleId;
  const preset = STYLES[style];
  const assumptions: string[] = [];
  const conflicts: CreativeBrief["conflicts"] = [];
  const qualityConcerns: string[] = [];

  // Duration: settings are authoritative unless the user resolves a conflict otherwise.
  let durationSec = project.durationSec;
  const asked = prompt ? parseDurationSec(prompt) : null;
  let needsClarification = false;
  let clarificationQuestion: string | null = null;
  if (asked !== null && Math.abs(asked - project.durationSec) > Math.max(2, project.durationSec * 0.15)) {
    if (clarification) {
      const answerNum = parseDurationSec(clarification) ?? (/^\s*\d+(\.\d+)?\s*$/.test(clarification) ? Number(clarification) : null);
      const wantsPrompt = /\b(prompt|longer|shorter|first|that one)\b/i.test(clarification) && !/\b(setting|keep|project)\b/i.test(clarification);
      if (answerNum && answerNum >= 5 && answerNum <= 180) durationSec = answerNum;
      else if (wantsPrompt && asked >= 5 && asked <= 180) durationSec = asked;
      conflicts.push({ topic: "duration", description: `Prompt asked for ${asked}s; settings were ${project.durationSec}s.`, proposedResolution: `Resolved by your answer: ${durationSec}s.` });
    } else {
      needsClarification = true;
      clarificationQuestion = `Your prompt asks for a ${asked}-second video, but the project is set to ${project.durationSec} seconds. Which length should I use? (Reply "${project.durationSec} seconds" or "${asked} seconds".)`;
      conflicts.push({ topic: "duration", description: `The prompt asks for ${asked}s but the project setting is ${project.durationSec}s.`, proposedResolution: `Ask you; if unanswered, keep the ${project.durationSec}s setting.` });
    }
  } else if (asked === null) {
    assumptions.push(`No length in the prompt — using ${project.durationSec}s from the project settings.`);
  }
  const platformMention = (Object.keys(PLATFORMS) as Platform[]).find((p) => new RegExp(PLATFORMS[p].label.split(" (")[0] as string, "i").test(prompt));
  if (platformMention && platformMention !== project.platform) {
    assumptions.push(`The prompt mentions ${PLATFORMS[platformMention].label}; keeping the chosen output (${PLATFORMS[project.platform as Platform]?.label ?? project.platform}, ${project.aspectRatio}).`);
  }
  if (project.silentOutput && has(all, "music", "song", "soundtrack", "audio")) {
    conflicts.push({ topic: "audio", description: "The prompt mentions music but silent output is switched on.", proposedResolution: "Keeping the video silent as set in the project." });
  }
  if (has(all, "voice-over", "voiceover", "narration", "narrator")) assumptions.push("Voice-over isn't available in this version; the story is told with on-screen text instead.");

  const quoted = extractQuoted(prompt);
  const sents = sentences(prompt);
  const endSentence = sents.find((s) => /\b(end|ending|finish|close|closing|call to action|cta|sign[- ]off)\b/i.test(s)) ?? "";
  const ctaQuoted = extractQuoted(endSentence);
  const endWith = /\b(?:saying|with the (?:text|words?)|the (?:text|words?))\s+["“]?([^"”.!?]{2,60})["”]?/i.exec(endSentence)?.[1]?.trim();
  const titleQuoted = (() => {
    const s = sents.find((x) => /\b(title|headline|called|named)\b/i.test(x));
    return s ? extractQuoted(s)[0] : undefined;
  })();
  const requiredText = quoted.filter((q) => q !== titleQuoted && !ctaQuoted.includes(q));

  const moods = MOODS.filter((m) => new RegExp(`\\b${m}`, "i").test(all));
  if (moods.length === 0) {
    moods.push(...(style === "energetic_montage" || style === "event_highlights" ? ["energetic"] : style === "emotional_memories" ? ["emotional", "warm"] : style === "business_promo" || style === "product_ad" ? ["confident", "clean"] : ["cinematic"]));
    assumptions.push(`No mood stated — using "${moods.join(", ")}" from the ${preset.label} style.`);
  }
  const pacing = detectPacing(all, preset.pacing as CreativeBrief["pacing"]);
  const colorGrade = detectGrade(all, preset.grade as ColorGrade);
  const typography = detectTypography(all, preset.typography as TypographyId);
  if (colorGrade === preset.grade) assumptions.push(`Colour grade "${colorGrade.replace(/_/g, " ")}" from the style preset.`);
  if (project.captionsEnabled && quoted.length === 0) assumptions.push("No on-screen text was provided, so text is limited to the title and any call to action — nothing is invented.");

  const visuals = assets.filter((a) => !a.excluded && a.kind !== "audio");
  const weak = visuals.filter((a) => a.metrics?.dark || a.metrics?.blurry || a.metrics?.soft || (Math.min(a.width ?? 0, a.height ?? 0) > 0 && Math.min(a.width ?? 0, a.height ?? 0) < 720) || a.analysis?.visualQuality === "poor");
  if (weak.length > 0) {
    const kinds = [
      visuals.some((a) => a.metrics?.dark) && "dark",
      visuals.some((a) => a.metrics?.blurry || a.metrics?.soft) && "soft/blurry",
      visuals.some((a) => Math.min(a.width ?? 9999, a.height ?? 9999) < 720) && "low-resolution",
    ].filter(Boolean);
    qualityConcerns.push(`${weak.length} of ${visuals.length} visuals look ${kinds.join(", ") || "weak"}. They will be brightened gently and used sparingly; upscaling can't add real detail, so the result won't be presented as true HD for those shots.`);
  }
  if (visuals.length > 0 && durationSec / visuals.length > 7) qualityConcerns.push(`Only ${visuals.length} visual${visuals.length === 1 ? "" : "s"} for ${durationSec}s — shots will be held longer and some may be reused with different camera moves.`);
  const music = assets.find((a) => a.kind === "audio" && !a.excluded);
  if (!music && !project.silentOutput) assumptions.push("No music uploaded — the video will have no soundtrack. Add a licensed track to include music.");

  const first = sents[0] ?? "";
  const brief: CreativeBrief = {
    title: (titleQuoted ?? project.name).slice(0, 120),
    subject: (first || project.description || project.name).slice(0, 600),
    story: `A ${pacing}-paced ${preset.label.toLowerCase()} edit that opens on the strongest measured shot, builds through the remaining media in a deliberate order, holds longest on the most vivid moment, and ${endWith || ctaQuoted[0] ? `ends on "${endWith ?? ctaQuoted[0]}"` : "closes on a calm, warm frame"}.`.slice(0, 1500),
    audience: `Viewers on ${PLATFORMS[project.platform as Platform]?.label ?? project.platform}`,
    platform: project.platform,
    durationSec,
    aspectRatio: project.aspectRatio as CreativeBrief["aspectRatio"],
    mood: moods.slice(0, 8),
    visualStyle: `${preset.label}: ${colorGrade.replace(/_/g, " ")} grade, ${typography.replace(/_/g, " ")} type, ${preset.motion} camera motion.`,
    pacing,
    musicPreference: project.silentOutput ? "Silent output" : project.musicPreference || (music ? `Uploaded track "${music.originalName}"` : "None uploaded"),
    captionLanguage: project.language,
    requiredText: requiredText.slice(0, 10),
    avoid: extractAvoid(prompt),
    ending: (endSentence || "A strong final image with a gentle fade.").slice(0, 300),
    hookIdea: (sents.find((s) => /\b(hook|start with|open with|opening|begin with|first shot)\b/i.test(s)) ?? "Open on the shot with the highest measured hook strength.").slice(0, 400),
    colorGrade,
    typography,
    assumptions: assumptions.slice(0, 12),
    conflicts: conflicts.slice(0, 6),
    needsClarification,
    clarificationQuestion,
    qualityConcerns: qualityConcerns.slice(0, 10),
  };
  // Keep call-to-action text where the director can find it.
  if (endWith || ctaQuoted[0]) brief.requiredText = [...brief.requiredText.filter((x) => x !== (endWith ?? ctaQuoted[0]))].slice(0, 9);
  (brief as CreativeBrief & { callToAction?: string }).callToAction = endWith ?? ctaQuoted[0];
  return CreativeBriefSchema.parse(brief) as CreativeBrief;
}

/** The CTA isn't part of the strict schema; re-derive it from the prompt when needed. */
export function callToActionFrom(prompt: string): string | undefined {
  const endSentence = sentences(prompt).find((s) => /\b(end|ending|finish|close|closing|call to action|cta|sign[- ]off)\b/i.test(s)) ?? "";
  return /\b(?:saying|with the (?:text|words?)|the (?:text|words?))\s+["“]?([^"”.!?]{2,60})["”]?/i.exec(endSentence)?.[1]?.trim() ?? extractQuoted(endSentence)[0];
}
