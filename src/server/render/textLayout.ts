import type { TextPosition, TextStyleId, TypographyId } from "@/lib/presets";
import { TYPOGRAPHY } from "@/lib/presets";

/**
 * Deterministic typography layout: font choice, size, wrapping, and placement inside the
 * platform safe area. Width estimates use per-font average glyph widths (conservative),
 * so text that validates here stays inside the frame when rendered.
 */
const AVG_GLYPH: Record<string, number> = {
  "Playfair Display": 0.56,
  Montserrat: 0.64,
  Inter: 0.58,
  "Bebas Neue": 0.42,
  "Cormorant Garamond": 0.5,
  "Dancing Script": 0.5,
};

export interface StyleSpec {
  font: string;
  basePx: number; // at a 1080px short edge
  minPx: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  spacingPx: number;
  maxLines: number;
}

export function styleSpec(style: TextStyleId, typography: TypographyId): StyleSpec {
  const t = TYPOGRAPHY[typography];
  switch (style) {
    case "title":
      return { font: t.title, basePx: t.title === "Bebas Neue" ? 120 : 92, minPx: 56, bold: t.title !== "Bebas Neue" && t.title !== "Dancing Script", italic: false, uppercase: t.title === "Bebas Neue", spacingPx: t.title === "Bebas Neue" ? 4 : 0, maxLines: 3 };
    case "subtitle":
      return { font: t.body, basePx: 58, minPx: 42, bold: false, italic: false, uppercase: false, spacingPx: 1, maxLines: 3 };
    case "caption":
      return { font: t.body, basePx: 52, minPx: 40, bold: true, italic: false, uppercase: false, spacingPx: 0, maxLines: 3 };
    case "kicker":
      return { font: t.body, basePx: 40, minPx: 34, bold: true, italic: false, uppercase: true, spacingPx: 6, maxLines: 2 };
    case "quote":
      return { font: t.title === "Bebas Neue" ? "Playfair Display" : t.title, basePx: 70, minPx: 46, bold: false, italic: true, uppercase: false, spacingPx: 0, maxLines: 4 };
  }
}

export function estimateLineWidth(text: string, font: string, sizePx: number, uppercase: boolean, spacingPx: number): number {
  const g = AVG_GLYPH[font] ?? 0.6;
  let w = 0;
  for (const ch of text) {
    let cw = g;
    if (ch === " ") cw = g * 0.5;
    else if (/[iIl.,'!:;|]/.test(ch)) cw = g * 0.45;
    else if (/[mwMW@]/.test(ch)) cw = g * 1.45;
    else if (uppercase || /[A-Z0-9]/.test(ch)) cw = g * 1.18;
    w += cw * sizePx + spacingPx;
  }
  return w;
}

export function wrapText(text: string, maxWidth: number, font: string, sizePx: number, uppercase: boolean, spacingPx: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const cand = cur ? `${cur} ${word}` : word;
    if (estimateLineWidth(cand, font, sizePx, uppercase, spacingPx) <= maxWidth || !cur) {
      cur = cand;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface LayoutResult {
  lines: string[];
  sizePx: number;
  x: number;
  y: number;
  align: "top" | "center" | "bottom";
  box: { left: number; top: number; right: number; bottom: number };
  fits: boolean;
}

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function layoutText(
  content: string,
  spec: StyleSpec,
  position: TextPosition,
  frame: { width: number; height: number },
  safe: SafeArea,
): LayoutResult {
  const scale = Math.min(frame.width, frame.height) / 1080;
  const maxWidth = frame.width - safe.left - safe.right;
  const text = spec.uppercase ? content.toUpperCase() : content;
  let size = Math.round(spec.basePx * scale);
  const minSize = Math.round(spec.minPx * scale);
  let lines = wrapText(text, maxWidth, spec.font, size, spec.uppercase, spec.spacingPx * scale);
  const widest = (ls: string[], s: number) => Math.max(...ls.map((l) => estimateLineWidth(l, spec.font, s, spec.uppercase, spec.spacingPx * scale)));
  while ((lines.length > spec.maxLines || widest(lines, size) > maxWidth) && size > minSize) {
    size = Math.max(minSize, Math.round(size * 0.92));
    lines = wrapText(text, maxWidth, spec.font, size, spec.uppercase, spec.spacingPx * scale);
  }
  const lineH = size * 1.22;
  const blockH = lineH * lines.length;
  const cx = Math.round(safe.left + maxWidth / 2);
  let y: number;
  let align: LayoutResult["align"];
  let top: number;
  switch (position) {
    case "top":
      align = "top";
      y = Math.round(safe.top + 24 * scale);
      top = y;
      break;
    case "center":
      align = "center";
      y = Math.round(frame.height / 2);
      top = y - blockH / 2;
      break;
    case "lower_third":
      align = "center";
      y = Math.round(Math.min(frame.height * 0.66, frame.height - safe.bottom - blockH / 2 - 16 * scale));
      top = y - blockH / 2;
      break;
    case "bottom":
      align = "bottom";
      y = Math.round(frame.height - safe.bottom - 16 * scale);
      top = y - blockH;
      break;
  }
  const w = widest(lines, size);
  const box = { left: Math.round(cx - w / 2), top: Math.round(top), right: Math.round(cx + w / 2), bottom: Math.round(top + blockH) };
  const fits =
    lines.length <= spec.maxLines &&
    box.left >= safe.left - 1 &&
    box.right <= frame.width - safe.right + 1 &&
    box.top >= safe.top - 1 &&
    box.bottom <= frame.height - safe.bottom + 1;
  return { lines, sizePx: size, x: cx, y, align, box, fits };
}
