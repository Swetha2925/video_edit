"use client";

import { useState } from "react";
import { Activity, CheckCircle2, CircleHelp, Loader2, MessageSquare, Send, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtAgo } from "@/lib/format";
import { Badge, Button, cx, inputCls } from "../ui";
import type { ProjectDetail } from "./types";

const SUGGESTIONS = ["Make the opening more exciting", "Reduce the transitions", "Make the text smaller", "Make the colours more natural", "Use a slower, emotional pace", "Make it 20 seconds"];

export function RevisionChat({ detail, aiOn, busy, refresh, onError, onSent }: { detail: ProjectDetail; aiOn: boolean; busy: boolean; refresh: () => void; onError: (m: string) => void; onSent: () => void }) {
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const pid = detail.project.id;
  const canRevise = Boolean(detail.storyboard);
  const send = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      await api(`/api/projects/${pid}/revise`, { method: "POST", json: { message: msg.trim() } });
      setMsg("");
      refresh();
      onSent();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Could not send feedback");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="card flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="h-4 w-4 text-accent" /> Ask for changes
      </div>
      {!detail.storyboard ? (
        <p className="text-xs text-muted">Create a plan first, then describe changes in plain language.</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => setMsg(s)} className="focus-ring rounded-full border border-line-strong px-2.5 py-1 text-[11px] text-muted hover:text-fg">
                {s}
              </button>
            ))}
          </div>
          <textarea
            className={cx(inputCls, "min-h-20 resize-y text-sm")}
            placeholder="e.g. Use the beach photo first and keep everything else the same"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            maxLength={2000}
            disabled={busy || !canRevise}
            aria-label="Describe the change you want"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-faint">{aiOn ? "Only the parts you mention change; earlier versions are kept." : 'Local engine: use direct requests like the chips above, "remove scene 3", or quotes for text.'}</span>
            <Button variant="primary" className="px-3 py-1.5" onClick={send} loading={sending} disabled={busy || !msg.trim()} icon={<Send className="h-3.5 w-3.5" />}>
              Revise
            </Button>
          </div>
        </>
      )}
      {detail.feedback.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-line pt-3">
          {detail.feedback.slice(0, 6).map((f) => (
            <li key={f.id} className="text-xs">
              <div className="flex items-start gap-1.5">
                {f.status === "applied" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> : f.status === "failed" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" /> : f.status === "needs_clarification" ? <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" /> : <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />}
                <div>
                  <div className="text-fg">“{f.message}”</div>
                  {f.summary && <div className="text-muted">{f.summary}</div>}
                  {f.toStoryboardVer && <div className="text-faint">→ storyboard v{f.toStoryboardVer}</div>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ActivityFeed({ detail }: { detail: ProjectDetail }) {
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between text-sm font-medium">
        <span className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" /> Agent activity
        </span>
        {detail.usage.modelCalls > 0 && (
          <Badge title="Claude API usage for this project">
            {detail.usage.modelCalls} AI calls · {Math.round((detail.usage.inputTokens + detail.usage.outputTokens) / 1000)}k tokens
          </Badge>
        )}
      </div>
      <ol className="max-h-[420px] space-y-2.5 overflow-y-auto pr-1">
        {detail.events.map((e) => (
          <li key={e.id} className="flex gap-2 text-xs">
            <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", e.level === "success" ? "bg-ok" : e.level === "error" ? "bg-bad" : e.level === "warning" ? "bg-warn" : "bg-accent")} />
            <div className="min-w-0">
              <div className="break-words text-muted">{e.message}</div>
              <div className="text-faint">{fmtAgo(e.createdAt)}</div>
            </div>
          </li>
        ))}
        {detail.events.length === 0 && <li className="text-xs text-faint">Nothing yet.</li>}
      </ol>
    </div>
  );
}
