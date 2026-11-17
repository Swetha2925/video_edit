"use client";

import { useState } from "react";
import { Download, Film, Layers } from "lucide-react";
import { fmtAgo, fmtBytes, fmtSec } from "@/lib/format";
import { PLATFORMS, type Platform } from "@/lib/presets";
import { Badge, cx, Notice, SectionTitle } from "../ui";
import type { ProjectDetail } from "./types";

export function ExportPanel({ detail }: { detail: ProjectDetail }) {
  const pid = detail.project.id;
  const passed = detail.renders.filter((r) => r.status === "passed" && r.hasFile);
  const final = passed[0];
  const [compare, setCompare] = useState<[number | null, number | null]>([passed[1]?.version ?? null, passed[0]?.version ?? null]);
  const vertical = detail.project.height > detail.project.width;

  if (!final) {
    return (
      <div className="space-y-4">
        <SectionTitle title="Export" />
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Film className="h-8 w-8 text-faint" />
          <div>No exportable render yet</div>
          <p className="max-w-md text-sm text-muted">Only renders that pass the quality checks can be exported. Render a plan to get started.</p>
        </div>
      </div>
    );
  }
  const qc = final.qc;
  return (
    <div className="space-y-8">
      <SectionTitle title="Export" subtitle="Download the latest render that passed quality checks. Every property below was measured from the file." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        <video controls playsInline preload="metadata" className={cx("w-full rounded-2xl border border-line bg-black", vertical ? "aspect-[9/16]" : "aspect-video")} src={`/api/projects/${pid}/renders/${final.version}/video`} />
        <div className="space-y-5">
          <div>
            <Badge tone="ok">Version {final.version} · passed QC</Badge>
            <h3 className="mt-2 font-display text-2xl">{detail.project.name}</h3>
            <p className="text-sm text-muted">{qc?.qualityLabel}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {[
              ["Resolution", `${final.width}×${final.height}`],
              ["Frame rate", `${final.fps} fps`],
              ["Duration", fmtSec(final.durationSec, 2)],
              ["Video", qc?.output.videoCodec ? `${qc.output.videoCodec.toUpperCase()} (MP4)` : "—"],
              ["Audio", qc?.output.audioCodec ? `${qc.output.audioCodec.toUpperCase()} 48 kHz stereo` : "None (silent)"],
              ["File size", fmtBytes(final.sizeBytes)],
              ["Bitrate", qc?.output.bitrateKbps ? `${(qc.output.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"],
              ["Platform", PLATFORMS[detail.project.platform as Platform]?.label ?? detail.project.platform],
              ["Loudness target", qc?.output.audioCodec ? "−14 LUFS, peak ≤ −1.5 dBTP" : "—"],
            ].map(([k, v]) => (
              <div key={k} className="card p-3">
                <dt className="text-[11px] uppercase tracking-wider text-faint">{k}</dt>
                <dd className="mt-0.5 text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          <a href={`/api/projects/${pid}/renders/${final.version}/video?download=1`} className="btn-primary focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-medium text-white">
            <Download className="h-4 w-4" /> Download MP4
          </a>
          <Notice tone="info">ReelCraft focuses on clarity, pacing and platform-correct output. Reach and virality depend on audience, timing and distribution, which no editor can guarantee.</Notice>
        </div>
      </div>

      <div>
        <h3 className="mb-3 flex items-center gap-2 font-display text-lg">
          <Layers className="h-4 w-4 text-accent" /> Compare versions
        </h3>
        {passed.length < 2 ? (
          <p className="text-sm text-muted">Render a revision to compare versions side by side.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[0, 1].map((side) => (
              <div key={side} className="space-y-2">
                <select
                  className="focus-ring w-full rounded-xl border border-line-strong bg-panel-2 px-3 py-2 text-sm"
                  value={compare[side] ?? ""}
                  onChange={(e) => setCompare((c) => (side === 0 ? [Number(e.target.value), c[1]] : [c[0], Number(e.target.value)]))}
                  aria-label={`Version for ${side === 0 ? "left" : "right"} player`}
                >
                  {passed.map((r) => (
                    <option key={r.version} value={r.version}>
                      v{r.version} — {r.label}
                    </option>
                  ))}
                </select>
                {compare[side] && <video key={compare[side]} controls playsInline preload="metadata" className={cx("w-full rounded-xl border border-line bg-black", vertical ? "aspect-[9/16] max-h-[520px]" : "aspect-video")} src={`/api/projects/${pid}/renders/${compare[side]}/video`} />}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-3 font-display text-lg">Version history</h3>
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="p-3">Version</th>
                <th className="p-3">Source</th>
                <th className="p-3">Status</th>
                <th className="p-3">Output</th>
                <th className="p-3">Created</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {detail.renders.map((r) => (
                <tr key={r.id}>
                  <td className="p-3">v{r.version}</td>
                  <td className="p-3 text-muted">{r.label}</td>
                  <td className="p-3">
                    <Badge tone={r.status === "passed" ? "ok" : r.status === "failed" || r.status === "cancelled" ? "bad" : "accent"}>{r.status}</Badge>
                  </td>
                  <td className="p-3 text-muted">{r.width ? `${r.width}×${r.height} · ${fmtSec(r.durationSec, 1)} · ${fmtBytes(r.sizeBytes)}` : "—"}</td>
                  <td className="p-3 text-muted">{fmtAgo(r.createdAt)}</td>
                  <td className="p-3 text-right">
                    {r.status === "passed" && r.hasFile && (
                      <a className="text-accent hover:underline" href={`/api/projects/${pid}/renders/${r.version}/video?download=1`}>
                        Download
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
