import { useLayoutEffect, useRef, useState } from "react";
import type { LogView } from "../shared/protocol.ts";
import type { CallControls } from "./useCall.ts";

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
      </div>

      <section className="rv-card">
        <h2>Time</h2>
        <div className="rv-buttons">
          {JUMPS.map(([label, ms]) => (
            <button key={label} type="button" onClick={() => onFastForward(ms)}>
              {label}
            </button>
          ))}
          <span className="rv-spacer" />
          <button type="button" className="danger" onClick={onReset}>
            Reset session
          </button>
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
                  <td className="muted">{s?.source ?? "-"}</td>
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
              {state?.graduated ? " · graduated" : ""}
            </dd>
          </div>
          <div>
            <dt>Call</dt>
            <dd>
              {String(callState.status ?? "idle")} · offers {String(callState.autoOffers ?? 0)} ·
              declines {String(callState.declines ?? 0)}
            </dd>
          </div>
          <div>
            <dt>Language</dt>
            <dd>
              {String(state?.language ?? "en")} · {String(state?.casing ?? "normal")} case
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
