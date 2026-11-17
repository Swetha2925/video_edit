/**
 * Creative vocabulary shared by the UI, the Claude agent, and the renderer.
 * Every value here maps to a concrete, tested rendering implementation — the model
 * can only choose from what the renderer genuinely supports.
 */

export const PLATFORMS = {
  instagram_reels: { label: "Instagram Reels", aspect: "9:16", maxSec: 90 },
  tiktok: { label: "TikTok", aspect: "9:16", maxSec: 180 },
  youtube_shorts: { label: "YouTube Shorts", aspect: "9:16", maxSec: 60 },
  instagram_feed: { label: "Instagram Feed (4:5)", aspect: "4:5", maxSec: 60 },
  square: { label: "Square post (1:1)", aspect: "1:1", maxSec: 60 },
  youtube: { label: "YouTube (16:9)", aspect: "16:9", maxSec: 180 },
} as const;
export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_IDS = Object.keys(PLATFORMS) as [Platform, ...Platform[]];

export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTIONS = {
  "720p": { label: "720p (fast preview)", short: 720 },
  "1080p": { label: "1080p Full HD (recommended)", short: 1080 },
  "2160p": { label: "4K UHD (only when sources support it)", short: 2160 },
} as const;
export type ResolutionId = keyof typeof RESOLUTIONS;

export function outputDimensions(aspect: AspectRatio, res: ResolutionId): { width: number; height: number } {
  const s = RESOLUTIONS[res].short;
  switch (aspect) {
    case "9:16":
      return { width: s, height: Math.round((s * 16) / 9 / 2) * 2 };
    case "4:5":
      return { width: s, height: Math.round((s * 5) / 4 / 2) * 2 };
    case "1:1":
      return { width: s, height: s };
    case "16:9":
      return { width: Math.round((s * 16) / 9 / 2) * 2, height: s };
  }
}

export function resolutionIdFor(width: number, height: number): ResolutionId {
  const short = Math.min(width, height);
  if (short >= 2160) return "2160p";
  if (short >= 1080) return "1080p";
  return "720p";
}

/** Areas covered by platform UI (fractions of frame). Text must stay inside the safe area. */
export function safeArea(platform: string, width: number, height: number) {
  const vertical = height > width;
  const f = vertical && ["instagram_reels", "tiktok", "youtube_shorts"].includes(platform)
    ? { top: 0.12, bottom: 0.22, left: 0.06, right: 0.12 }
    : { top: 0.06, bottom: 0.08, left: 0.06, right: 0.06 };
  return {
    top: Math.round(height * f.top),
    bottom: Math.round(height * f.bottom),
    left: Math.round(width * f.left),
    right: Math.round(width * f.right),
  };
}

export const STYLES = {
  cinematic_travel: { label: "Cinematic travel", grade: "warm_natural", typography: "elegant_serif", pacing: "medium", transitions: ["fade", "dissolve", "smooth_left", "zoom_in"], motion: "subtle" },
  emotional_memories: { label: "Emotional memories", grade: "vintage_film", typography: "classic_garamond", pacing: "slow", transitions: ["fade", "dissolve", "fade_white"], motion: "subtle" },
  minimal_aesthetic: { label: "Minimal aesthetic", grade: "bright_airy", typography: "minimal", pacing: "medium", transitions: ["fade", "cut"], motion: "subtle" },
  fashion_lifestyle: { label: "Fashion / lifestyle", grade: "cinematic_teal_orange", typography: "bold_display", pacing: "fast", transitions: ["cut", "slide_up", "smooth_left", "zoom_in"], motion: "medium" },
  food_product: { label: "Food & product showcase", grade: "vibrant", typography: "modern_sans", pacing: "medium", transitions: ["cut", "smooth_up", "fade"], motion: "medium" },
  product_ad: { label: "Product advertisement", grade: "cool_crisp", typography: "modern_sans", pacing: "medium", transitions: ["cut", "fade", "slide_left"], motion: "subtle" },
  event_highlights: { label: "Event highlights", grade: "vibrant", typography: "bold_display", pacing: "fast", transitions: ["cut", "fade", "zoom_in"], motion: "medium" },
  birthday: { label: "Birthday celebration", grade: "bright_airy", typography: "handwritten", pacing: "medium", transitions: ["fade", "circle_open", "fade_white"], motion: "medium" },
  documentary: { label: "Documentary / storytelling", grade: "natural", typography: "classic_garamond", pacing: "slow", transitions: ["cut", "fade", "fade_black"], motion: "subtle" },
  energetic_montage: { label: "Energetic montage", grade: "vibrant", typography: "bold_display", pacing: "fast", transitions: ["cut", "zoom_in", "slide_left", "slide_up"], motion: "strong" },
  business_promo: { label: "Professional business promo", grade: "cool_crisp", typography: "modern_sans", pacing: "medium", transitions: ["fade", "slide_left", "cut"], motion: "subtle" },
} as const;
export type StyleId = keyof typeof STYLES;
export const STYLE_IDS = Object.keys(STYLES) as [StyleId, ...StyleId[]];

export const COLOR_GRADES = {
  natural: "Natural, true-to-life with a touch of contrast",
  warm_natural: "Warm, sunlit natural tones",
  cinematic_teal_orange: "Cinematic teal shadows, warm skin and highlights",
  cool_crisp: "Clean, cool and crisp",
  vintage_film: "Soft, faded film look with warm highlights",
  moody_dark: "Moody, deeper shadows, restrained colour",
  vibrant: "Punchy, saturated colour",
  bright_airy: "Bright, airy, soft pastel feel",
  black_white: "Black and white with rich contrast",
} as const;
export type ColorGrade = keyof typeof COLOR_GRADES;
export const COLOR_GRADE_IDS = Object.keys(COLOR_GRADES) as [ColorGrade, ...ColorGrade[]];

export const TYPOGRAPHY = {
  elegant_serif: { label: "Elegant serif", title: "Playfair Display", body: "Montserrat" },
  modern_sans: { label: "Modern sans", title: "Montserrat", body: "Inter" },
  bold_display: { label: "Bold display", title: "Bebas Neue", body: "Inter" },
  classic_garamond: { label: "Classic Garamond", title: "Cormorant Garamond", body: "Cormorant Garamond" },
  handwritten: { label: "Handwritten", title: "Dancing Script", body: "Montserrat" },
  minimal: { label: "Minimal", title: "Inter", body: "Inter" },
} as const;
export type TypographyId = keyof typeof TYPOGRAPHY;
export const TYPOGRAPHY_IDS = Object.keys(TYPOGRAPHY) as [TypographyId, ...TypographyId[]];

/** Transition vocabulary → FFmpeg xfade names ("cut" is a hard cut via concat). */
export const TRANSITIONS = {
  cut: { label: "Hard cut", xfade: null },
  fade: { label: "Crossfade", xfade: "fade" },
  // xfade "dissolve" is a pixel-noise effect that looks cheap; we map it to a soft crossfade.
  dissolve: { label: "Soft dissolve", xfade: "fade" },
  fade_black: { label: "Dip to black", xfade: "fadeblack" },
  fade_white: { label: "Dip to white", xfade: "fadewhite" },
  smooth_left: { label: "Smooth push left", xfade: "smoothleft" },
  smooth_up: { label: "Smooth push up", xfade: "smoothup" },
  slide_left: { label: "Slide left", xfade: "slideleft" },
  slide_up: { label: "Slide up", xfade: "slideup" },
  wipe_left: { label: "Wipe left", xfade: "wipeleft" },
  circle_open: { label: "Circle reveal", xfade: "circleopen" },
  zoom_in: { label: "Zoom-in blend", xfade: "zoomin" },
  radial: { label: "Radial wipe", xfade: "radial" },
} as const;
export type TransitionId = keyof typeof TRANSITIONS;
export const TRANSITION_IDS = Object.keys(TRANSITIONS) as [TransitionId, ...TransitionId[]];

export const MOTIONS = {
  none: "Static frame",
  push_in: "Slow push in (Ken Burns zoom in)",
  pull_out: "Slow pull out (zoom out)",
  pan_left: "Pan towards the left",
  pan_right: "Pan towards the right",
  pan_up: "Tilt upwards",
  pan_down: "Tilt downwards",
  drift: "Gentle diagonal drift with slight zoom",
} as const;
export type MotionId = keyof typeof MOTIONS;
export const MOTION_IDS = Object.keys(MOTIONS) as [MotionId, ...MotionId[]];

export const MOTION_INTENSITIES = ["subtle", "medium", "strong"] as const;
export type MotionIntensity = (typeof MOTION_INTENSITIES)[number];

export const TEXT_STYLES = ["title", "subtitle", "caption", "kicker", "quote"] as const;
export type TextStyleId = (typeof TEXT_STYLES)[number];
export const TEXT_POSITIONS = ["top", "center", "lower_third", "bottom"] as const;
export type TextPosition = (typeof TEXT_POSITIONS)[number];
export const TEXT_ANIMATIONS = ["fade", "rise", "fade_scale", "blur_in"] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

export const FIT_MODES = {
  cover: "Fill the frame (crop around the focal point)",
  contain_blur: "Show the whole image over a soft blurred background (no black bars)",
} as const;
export type FitMode = keyof typeof FIT_MODES;
export const FIT_MODE_IDS = Object.keys(FIT_MODES) as [FitMode, ...FitMode[]];
