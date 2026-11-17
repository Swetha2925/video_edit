"use client";

/** Typed fetch helper for the browser. Server errors arrive as { error: { code, message, details } }. */
export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

/** Upload one file with real byte-level progress (XHR exposes upload progress; fetch does not). */
export function uploadFile(
  projectId: string,
  file: File,
  opts: { license?: { source: string; license: string; attribution: string }; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<{ asset: { id: string; kind: string; originalName: string } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${projectId}/assets`);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (opts.license) xhr.setRequestHeader("X-License", encodeURIComponent(JSON.stringify(opts.license)));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as { asset: { id: string; kind: string; originalName: string } });
      else {
        const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
        reject(new ApiError(xhr.status, err?.code ?? "UPLOAD_FAILED", err?.message ?? `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "NETWORK", "Network error during upload. Check your connection and retry."));
    xhr.onabort = () => reject(new ApiError(0, "ABORTED", "Upload cancelled."));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
