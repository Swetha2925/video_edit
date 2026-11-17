import type { Edl, EdlText } from "@/lib/schemas";

/**
 * Generate an Advanced SubStation Alpha (ASS) script for all on-screen text.
 * libass renders it with anti-aliased fonts, soft shadows, fades and motion.
 * User/model text is sanitised so it can never inject ASS override tags.
 */
export function sanitizeAssText(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\\/g, "∖")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .trim();
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** #RRGGBB → ASS &HAABBGGRR */
function assColor(hex: string, alpha = 0): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  const a = Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function alignment(a: EdlText["align"]): number {
  // numpad layout, horizontally centred
  return a === "top" ? 8 : a === "center" ? 5 : 2;
}

function eventTags(t: EdlText, scale: number): string {
  const tags: string[] = [`\\an${alignment(t.align)}`];
  const rise = Math.round(36 * scale);
  const slide = Math.round(90 * scale);
  switch (t.animation) {
    case "slide_in":
      tags.push(`\\move(${t.x + slide},${t.y},${t.x},${t.y},0,${Math.max(350, t.fadeInMs + 150)})`);
      break;
    case "pop":
      tags.push(`\\pos(${t.x},${t.y})`, "\\fscx70\\fscy70", "\\t(0,220,\\fscx108\\fscy108)", "\\t(220,380,\\fscx100\\fscy100)");
      break;
    case "typewriter":
      tags.push(`\\pos(${t.x},${t.y})`);
      break;
    case "rise":
      tags.push(`\\move(${t.x},${t.y + rise},${t.x},${t.y},0,${Math.max(300, t.fadeInMs + 200)})`);
      break;
    case "fade_scale":
      tags.push(`\\pos(${t.x},${t.y})`, "\\fscx94\\fscy94", `\\t(0,${t.fadeInMs + 300},\\fscx100\\fscy100)`);
      break;
    case "blur_in":
      tags.push(`\\pos(${t.x},${t.y})`, "\\blur10", `\\t(0,${t.fadeInMs + 200},\\blur0.6)`);
      break;
    default:
      tags.push(`\\pos(${t.x},${t.y})`);
  }
  tags.push(t.animation === "typewriter" ? `\\fad(0,${t.fadeOutMs})` : `\\fad(${t.fadeInMs},${t.fadeOutMs})`);
  if (t.animation !== "blur_in") tags.push("\\blur0.6");
  return `{${tags.join("")}}`;
}

/** Reveal characters one by one (≤ 1.4 s total) with per-character alpha transforms. */
function typewriter(lines: string[]): string {
  const chars = lines.join("").length;
  const step = Math.max(18, Math.min(60, Math.round(1400 / Math.max(1, chars))));
  let k = 0;
  return lines
    .map((line) =>
      [...line]
        .map((ch) => {
          const t0 = k++ * step;
          return ch === " " ? " " : `{\\alpha&HFF&\\t(${t0},${t0 + 80},\\alpha&H00&)}${ch}`;
        })
        .join(""),
    )
    .join("\\N");
}

export function buildAssScript(edl: Edl): string {
  const { width, height } = edl.output;
  const scale = Math.min(width, height) / 1080;
  const styles = new Map<string, string>();
  const events: string[] = [];
  for (const t of edl.texts) {
    const key = `${t.font}|${t.sizePx}|${t.bold}|${t.italic}|${t.spacingPx}|${t.color}|${t.boxed ? 1 : 0}`;
    let name = styles.get(key);
    if (!name) {
      name = `S${styles.size + 1}`;
      styles.set(key, name);
    }
    const text = t.animation === "typewriter" ? typewriter(t.lines.map(sanitizeAssText)) : t.lines.map(sanitizeAssText).join("\\N");
    events.push(`Dialogue: 0,${assTime(t.startSec)},${assTime(t.endSec)},${name},,0,0,0,,${eventTags(t, scale)}${text}`);
  }
  const styleLines = [...styles.entries()].map(([key, name]) => {
    const [font, size, bold, italic, spacing, color, boxed] = key.split("|");
    const isBox = boxed === "1";
    const outline = Math.max(1, Math.round(2.2 * scale * 10) / 10);
    const shadow = Math.max(1, Math.round(3 * scale * 10) / 10);
    return [
      `Style: ${name}`,
      font,
      size,
      assColor(color ?? "#FFFFFF"),
      assColor("#FFFFFF"),
      // Outline colour doubles as the box colour for BorderStyle 3 (label style).
      isBox ? assColor("#0b0d14", 0x50) : assColor("#000000", 0x70),
      isBox ? assColor("#000000", 0xc0) : assColor("#000000", 0x90),
      bold === "true" ? "-1" : "0",
      italic === "true" ? "-1" : "0",
      "0",
      "0",
      "100",
      "100",
      spacing,
      "0",
      isBox ? "3" : "1",
      isBox ? String(Math.round(14 * scale)) : String(outline),
      isBox ? "0" : String(shadow),
      "5",
      "0",
      "0",
      "0",
      "1",
    ].join(",");
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
