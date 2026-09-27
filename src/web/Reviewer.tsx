import { useLayoutEffect, useRef, useState } from "react";
import type { LogView } from "../shared/protocol.ts";
import type { CallControls } from "./useCall.ts";
import { VOICE_SCRIPTS, type VoiceRunState } from "./voiceRuns.ts";

/**
 * Scripted voice runs spend real money on each click, so a public deploy hides
 * them. Add ?qa to the URL to show them.
 */
const SHOW_VOICE_RUNS =
  import.meta.env.DEV || new URLSearchParams(window.location.search).has("qa");

interface Slot {
  status: string;
  value: string | null;
  attempts: number;
  source: string | null;
}

interface ReviewerProps {
  state: Record<string, unknown> | null;
  log: LogView[];
  now: number | null;
  sessionId: string | null;
  connected: boolean;
  onFastForward: (ms: number) => void;
  onReset: () => void;
  call: CallControls;
  callLive: boolean;
  lagMs: number;
  onDropCall: () => void;
  onLag: (ms: number) => void;
  onOAuth: (outcome: "scope_denied" | "cancelled" | "admin_blocked") => void;
  voiceRuns: {
    state: VoiceRunState;
    run(ids: string[]): Promise<void>;
    stop(): void;
  };
}

/** Prerecorded lines the test voice can say on a call, for QA without a microphone. */
const CLIPS: Array<[string, string]> = [
  ["My name is David", "/voice/name.m4a"],
  ["Cancel subscriptions", "/voice/need.m4a"],
  ["Are you a bot?", "/voice/bot.m4a"],
  ["Gotta go", "/voice/bye.m4a"],
  ["Spanish", "/voice/spanish.m4a"],
  ["Stop", "/voice/stop.m4a"],
];

/** Short labels that fit the ledger's Source column. The raw value shows on hover. */
const SOURCE_LABELS: Record<string, string> = {
  text: "text",
  voice: "call",
  google_profile: "Google",
  inferred: "picked",
  sample_inbox: "sample",
};

const SLOT_LABELS: Array<[string, string]> = [
  ["agent_name", "Agent name"],
  ["user_name", "User name"],
  ["help_need", "Help need"],
  ["gmail", "Gmail"],
];

const JUMPS: Array<[string, number]> = [
  ["+1 min", 60_000],
  ["+10 min", 10 * 60_000],
  ["+1 h", 60 * 60_000],
  ["+3 h", 3 * 60 * 60_000],
  ["+1 day", 24 * 60 * 60_000],
];

export function Reviewer({
  state,
  log,
  now,
  sessionId,
  connected,
  onFastForward,
  onReset,
  call,
  callLive,
  lagMs,
  onDropCall,
  onLag,
  onOAuth,
  voiceRuns,
}: ReviewerProps) {
  const slots = (state?.slots ?? {}) as Record<string, Slot>;
  const callState = (state?.call ?? {}) as Record<string, unknown>;
  return (
    <aside className="reviewer" aria-label="Reviewer panel">
      <div className="rv-head">
        <div>
          <h1>Reviewer panel</h1>
          <p className="rv-sub">
            <span className={`dot ${connected ? "on" : ""}`} />{" "}
            {connected ? "Live" : "Reconnecting"} · session{" "}
            <code>{sessionId?.slice(0, 8) ?? "…"}</code> ·{" "}
            {now ? new Date(now).toLocaleString() : "…"}
          </p>
        </div>
        <div className="rv-buttons">
          <button type="button" className="danger" onClick={onReset}>
            Reset session
          </button>
        </div>
      </div>

      {/* A first visit shows an empty phone. The hint lives here, never in the product UI. */}
      {Array.isArray(state?.history) && state.history.length === 0 && (
        <p className="rv-start">
          Start on the phone: text it the way a new user would. Accept its call, pick the sample
          inbox when it asks for Gmail, and use the controls below to break things.
        </p>
      )}

      <section className="rv-card">
        <h2>Time</h2>
        <div className="rv-buttons">
          {JUMPS.map(([label, ms]) => (
            <button key={label} type="button" onClick={() => onFastForward(ms)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="rv-card">
        <h2>Chaos</h2>
        <div className="rv-buttons">
          <button type="button" onClick={onDropCall} disabled={!callLive}>
            Drop call
          </button>
          <button
            type="button"
            aria-pressed={lagMs > 0}
            onClick={() => onLag(lagMs > 0 ? 0 : 3000)}
          >
            {lagMs > 0 ? "Lag on (+3 s)" : "Simulate lag"}
          </button>
          <label className="rv-check">
            <input
              type="checkbox"
              checked={call.testVoice}
              onChange={(e) => call.setTestVoice(e.target.checked)}
              disabled={call.call.phase !== "idle"}
            />
            Test voice
          </label>
        </div>
        {call.testVoice && (
          <div className="rv-buttons rv-clips">
            {CLIPS.map(([label, url]) => (
              <button
                key={url}
                type="button"
                disabled={call.call.phase !== "active"}
                onClick={() => void call.sayClip(url)}
              >
                Say “{label}”
              </button>
            ))}
          </div>
        )}
      </section>

      {SHOW_VOICE_RUNS && (
        <section className="rv-card">
          <h2>Voice runs</h2>
          <div className="rv-buttons">
            <button
              type="button"
              disabled={voiceRuns.state.running !== null || callLive}
              onClick={() => void voiceRuns.run(VOICE_SCRIPTS.map((s) => s.id))}
            >
              Run all {VOICE_SCRIPTS.length}
            </button>
            {VOICE_SCRIPTS.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={voiceRuns.state.running !== null || callLive}
                onClick={() => void voiceRuns.run([s.id])}
              >
                {s.label}
              </button>
            ))}
            {voiceRuns.state.running && (
              <button type="button" className="danger" onClick={voiceRuns.stop}>
                Stop
              </button>
            )}
          </div>
          {voiceRuns.state.running && (
            <p className="rv-note">
              Running {voiceRuns.state.running}: {voiceRuns.state.step || "starting"}
            </p>
          )}
          {voiceRuns.state.results.length > 0 && (
            <ul className="rv-runs">
              {voiceRuns.state.results.map((r) => (
                <li key={r.id}>
                  <span className={`pill ${r.ok ? "confirmed" : "declined"}`}>
                    {r.ok ? "done" : r.detail === "stopped" ? "stopped" : "failed"}
                  </span>{" "}
                  {r.id}
                  {r.detail && <span className="muted"> · {r.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="rv-note">
            Real calls with prerecorded clips. Each run starts a fresh session. Grade them with
            <code> pnpm voice:report</code>.
          </p>
        </section>
      )}

      <section className="rv-card">
        <h2>Google consent</h2>
        <div className="rv-buttons">
          <button type="button" onClick={() => onOAuth("scope_denied")}>
            Uncheck Gmail box
          </button>
          <button type="button" onClick={() => onOAuth("cancelled")}>
            Cancel sign-in
          </button>
          <button type="button" onClick={() => onOAuth("admin_blocked")}>
            Admin block
          </button>
        </div>
        <Inbox inbox={state?.inbox as InboxView | undefined} />
      </section>

      <section className="rv-card">
        <h2>Tasks</h2>
        <Tasks
          tasks={(state?.tasks ?? []) as TaskView[]}
          outbox={(state?.outbox ?? []) as SentView[]}
          reminders={(state?.reminders ?? []) as ReminderView[]}
        />
      </section>

      <section className="rv-card">
        <h2>Slot ledger</h2>
        <table className="ledger">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Status</th>
              <th>Value</th>
              <th className="num">Asks</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {SLOT_LABELS.map(([key, label]) => {
              const s = slots[key];
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td>
                    <span className={`pill ${s?.status ?? "unknown"}`}>
                      {s?.status ?? "unknown"}
                    </span>
                  </td>
                  <td className="value" title={s?.value ?? ""}>
                    {s?.value ?? "-"}
                  </td>
                  <td className="num">{s?.attempts ?? 0}</td>
                  <td className="muted source" title={s?.source ?? ""}>
                    {s?.source ? (SOURCE_LABELS[s.source] ?? s.source) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <dl className="facts">
          <div>
            <dt>Phase</dt>
            <dd>
              {String(state?.phase ?? "…")}
              {state?.graduated ? <span className="sub">graduated</span> : null}
            </dd>
          </div>
          <div>
            <dt>Call</dt>
            <dd>
              {String(callState.status ?? "idle")}
              <span className="sub">
                offers {String(callState.autoOffers ?? 0)} · declines{" "}
                {String(callState.declines ?? 0)}
              </span>
            </dd>
          </div>
          <div>
            <dt>Language</dt>
            <dd>
              {String(state?.language ?? "en")}
              <span className="sub">{String(state?.casing ?? "normal")} case</span>
            </dd>
          </div>
        </dl>
      </section>

      <Timeline log={log} />
    </aside>
  );
}

function Timeline({ log }: { log: LogView[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const [open, setOpen] = useState<number | null>(null);
  const shown = log.filter((e) => !HIDDEN.has(e.type));
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new entries
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  return (
    <section className="rv-card rv-timeline">
      <h2>Event timeline</h2>
      <ol ref={ref}>
        {shown.map((e) => (
          <li key={e.seq} className={`ev ${e.dir}`}>
            <button
              type="button"
              onClick={() => setOpen(open === e.seq ? null : e.seq)}
              aria-expanded={open === e.seq}
            >
              <time>
                {new Date(e.ts).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hourCycle: "h23",
                })}
              </time>
              <span className="dir">{e.dir}</span>
              <span className="type">{e.type}</span>
              <span className="summary">{summarize(e)}</span>
            </button>
            {open === e.seq && <pre>{JSON.stringify(e.payload, null, 2)}</pre>}
          </li>
        ))}
      </ol>
    </section>
  );
}

const HIDDEN = new Set(["typing", "client_connected"]);

function summarize(e: LogView): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "text_in":
      return `“${String(p.text ?? "")}”`;
    case "transcript_final":
      return `${String(p.role)} said “${String(p.text ?? "")}”`;
    case "push_to_call":
      return `${String(p.kind)}: ${String(p.text ?? "")}`;
    case "call_ended":
      return String(p.reason ?? "");
    case "call_turn": {
      const plan = (p.plan ?? {}) as {
        pushes?: Array<{ kind: string }>;
        wrapUp?: boolean;
        end?: boolean;
      };
      const kinds = (plan.pushes ?? []).map((x) => x.kind).join(", ");
      return [kinds && `push ${kinds}`, plan.wrapUp && "wrap up", plan.end && "end"]
        .filter(Boolean)
        .join(" · ");
    }
    case "send_text":
      return ((p.bubbles as Array<Record<string, string>>) ?? [])
        .map((b) => (b.kind === "link" ? `[${b.title}]` : b.text))
        .join(" / ");
    case "schedule_timer":
      return `${String(p.kind)} at ${new Date(Number(p.fireAt)).toLocaleTimeString()}`;
    case "cancel_timer":
    case "timer_fired":
      return String(p.timerId ?? "");
    case "turn": {
      const plan = (p.plan ?? {}) as Record<string, unknown>;
      const acks = ((plan.acks as Array<{ kind: string }>) ?? []).map((a) => a.kind);
      const answers = ((plan.answers as Array<{ kind: string }>) ?? []).map((a) => a.kind);
      const q = plan.question as { kind: string; slot?: string } | null;
      const meta = (p.meta ?? {}) as Record<string, unknown>;
      const parts = [
        acks.length ? `ack ${acks.join(", ")}` : null,
        answers.length ? `answer ${answers.join(", ")}` : null,
        q ? `ask ${q.slot ?? q.kind}` : "no question",
        `${String(meta.renderer)} ${Math.round(Number(meta.renderMs ?? 0))}ms`,
      ].filter(Boolean);
      return parts.join(" · ");
    }
    case "fast_forward":
      return `+${Math.round(Number(p.ms) / 60_000)} min`;
    default:
      return "";
  }
}

interface InboxView {
  source: "gmail" | "demo" | null;
  scanning: boolean;
  scannedAt: number | null;
  findings: Array<{ fact: string; related: boolean }>;
}

function Inbox({ inbox }: { inbox: InboxView | undefined }) {
  if (!inbox?.source) return <p className="rv-note">No inbox connected.</p>;
  const label = inbox.source === "demo" ? "Sample inbox" : "Gmail";
  if (inbox.scanning) return <p className="rv-note">{label} connected · scanning…</p>;
  return (
    <div className="rv-inbox">
      <p className="rv-note">
        {label} connected · {inbox.findings.length} finding{inbox.findings.length === 1 ? "" : "s"}
      </p>
      {inbox.findings.length > 0 && (
        <ol>
          {inbox.findings.map((f) => (
            <li key={f.fact}>
              {f.fact}
              {!f.related && <span className="muted"> (not tied to their need)</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

interface DraftView {
  to: string;
  subject: string;
  body: string;
}

interface TaskView {
  id: number;
  summary: string;
  status: string;
  result:
    | { kind: "draft"; draft: DraftView }
    | { kind: "remind"; at: number }
    | { kind: "question" | "answer" | "cannot"; text: string }
    | null;
}

interface SentView {
  taskId: number;
  draft: DraftView;
  at: number;
}

interface ReminderView {
  taskId: number;
  at: number;
  sent: boolean;
  canceled?: boolean;
}

/** Task statuses, in the ledger's pill colors. */
const TASK_PILLS: Record<string, [label: string, tone: string]> = {
  open: ["queued", "deferred"],
  waiting_gmail: ["needs Gmail", "deferred"],
  working: ["working", "tentative"],
  needs_yes: ["needs yes", "tentative"],
  needs_info: ["asked", "tentative"],
  done: ["done", "confirmed"],
  dropped: ["dropped", ""],
  failed: ["failed", "declined"],
};

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function taskDetail(t: TaskView, reminders: ReminderView[]): string | null {
  const r = t.result;
  if (!r) return null;
  switch (r.kind) {
    case "draft":
      return `Draft to ${r.draft.to}: “${r.draft.subject}”`;
    case "remind": {
      const rem = reminders.find((x) => x.taskId === t.id);
      return `Reminder ${when(r.at)}${rem?.sent ? " · sent" : rem?.canceled ? " · canceled" : ""}`;
    }
    case "question":
      return `Asked: ${r.text}`;
    case "answer":
      return "Answered in the thread";
    case "cannot":
      return `Said it can't: ${r.text}`;
  }
}

function Tasks({
  tasks,
  outbox,
  reminders,
}: {
  tasks: TaskView[];
  outbox: SentView[];
  reminders: ReminderView[];
}) {
  if (tasks.length === 0) return <p className="rv-note">No tasks yet.</p>;
  return (
    <div className="rv-tasks">
      <ul>
        {tasks.map((t) => {
          const [label, tone] = TASK_PILLS[t.status] ?? [t.status, ""];
          const detail = taskDetail(t, reminders);
          return (
            <li key={t.id}>
              <div className="rv-task-row">
                <span className="rv-task-name">{t.summary}</span>
                <span className={`pill ${tone}`}>{label}</span>
              </div>
              {detail && <div className="rv-task-detail">{detail}</div>}
            </li>
          );
        })}
      </ul>
      {outbox.length > 0 && (
        <>
          <h3>Outbox (simulated, nothing sent)</h3>
          <ul>
            {outbox.map((o) => (
              <li key={`${o.taskId}-${o.at}`}>
                <details>
                  <summary>
                    {when(o.at)} · to {o.draft.to} · “{o.draft.subject}”
                  </summary>
                  <pre>{o.draft.body}</pre>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
