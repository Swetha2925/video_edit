/**
 * File signature ("magic bytes") detection. Uploads are accepted only when the declared
 * extension/MIME type and the actual file contents agree on a supported format.
 */
export type AssetKind = "image" | "video" | "audio";

export interface DetectedFormat {
  kind: AssetKind;
  mime: string;
  ext: string;
}

export const SUPPORTED_FORMATS: Record<string, DetectedFormat> = {
  jpeg: { kind: "image", mime: "image/jpeg", ext: "jpg" },
  png: { kind: "image", mime: "image/png", ext: "png" },
  webp: { kind: "image", mime: "image/webp", ext: "webp" },
  mp4: { kind: "video", mime: "video/mp4", ext: "mp4" },
  mov: { kind: "video", mime: "video/quicktime", ext: "mov" },
  mp3: { kind: "audio", mime: "audio/mpeg", ext: "mp3" },
  m4a: { kind: "audio", mime: "audio/mp4", ext: "m4a" },
  wav: { kind: "audio", mime: "audio/wav", ext: "wav" },
  aac: { kind: "audio", mime: "audio/aac", ext: "aac" },
};

/** Extensions accepted from the client, mapped to the format family they must match. */
export const EXTENSION_FAMILY: Record<string, (keyof typeof SUPPORTED_FORMATS)[]> = {
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  png: ["png"],
  webp: ["webp"],
  mp4: ["mp4", "mov"],
  m4v: ["mp4"],
  mov: ["mov", "mp4"],
  mp3: ["mp3"],
  m4a: ["m4a", "mp4"],
  wav: ["wav"],
  aac: ["aac"],
};

export const ACCEPT_ATTRIBUTE = ".jpg,.jpeg,.png,.webp,.mp4,.m4v,.mov,.mp3,.m4a,.wav,.aac";

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString("latin1");
}

/** Detect the format from the first bytes of a file (at least 32 bytes recommended). */
export function detectFormat(head: Buffer): (keyof typeof SUPPORTED_FORMATS) | undefined {
  if (head.length < 12) return undefined;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "webp";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return "wav";
  const box = ascii(head, 4, 8);
  if (box === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "qt  ") return "mov";
    if (brand === "M4A " || brand === "M4B ") return "m4a";
    return "mp4";
  }
  // Legacy QuickTime files may start with other atoms.
  if (["moov", "mdat", "wide", "free", "skip", "pnot"].includes(box)) return "mov";
  if (ascii(head, 0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && head[1] !== undefined) {
    const b1 = head[1];
    if ((b1 & 0xf6) === 0xf0) return "aac"; // ADTS sync word, layer 0
    if ((b1 & 0xe0) === 0xe0) return "mp3"; // MPEG audio frame sync
  }
  return undefined;
}

export function extensionOf(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(name);
  return m ? (m[1] as string).toLowerCase() : "";
}

export type SignatureCheck =
  | { ok: true; format: DetectedFormat; family: keyof typeof SUPPORTED_FORMATS }
  | { ok: false; reason: string };

/** Validate that extension and content agree on a supported format. */
export function checkSignature(fileName: string, head: Buffer): SignatureCheck {
  const ext = extensionOf(fileName);
  const allowed = EXTENSION_FAMILY[ext];
  if (!allowed) return { ok: false, reason: `Files of type ".${ext || "?"}" are not supported. Use JPEG, PNG, WebP, MP4, MOV, MP3, M4A, WAV or AAC.` };
  const detected = detectFormat(head);
  if (!detected) return { ok: false, reason: "The file contents do not match any supported media format. It may be corrupted or mislabelled." };
  if (!allowed.includes(detected)) {
    return { ok: false, reason: `The file is named ".${ext}" but its contents look like ${detected.toUpperCase()}. Please re-export the file.` };
  }
  return { ok: true, format: SUPPORTED_FORMATS[detected] as DetectedFormat, family: detected };
}
