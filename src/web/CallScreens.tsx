import { useEffect, useState } from "react";
import type { ThreadItem } from "../shared/protocol.ts";
import type { CallControls } from "./useCall.ts";

function PhoneGlyph({ size = 30 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z"
      />
    </svg>
  );
}

function initial(name: string): string {
  return ([...name.trim()][0] ?? "P").toUpperCase();
}

export function IncomingCall({
  name,
  onAccept,
  onDecline,
}: {
  name: string;
  onAccept(): void;
  onDecline(): void;
}) {
  return (
    <div className="call-screen incoming" role="dialog" aria-label={`Incoming call from ${name}`}>
      <div className="call-top">
        <div className="call-name">{name}</div>
        <div className="call-sub">mobile</div>
      </div>
      <div className="call-actions two">
        <div className="call-action">
          <button type="button" className="round decline" onClick={onDecline} aria-label="Decline">
            <span className="hangup-glyph">
              <PhoneGlyph />
            </span>
          </button>
          <span>Decline</span>
        </div>
        <div className="call-action">
          <button type="button" className="round accept" onClick={onAccept} aria-label="Accept">
            <PhoneGlyph />
          </button>
          <span>Accept</span>
        </div>
      </div>
    </div>
  );
}

export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ActiveCall({
  controls,
  onMinimize,
  hideMinimize = false,
}: {
  controls: CallControls;
  onMinimize(): void;
  /** A banner sits where this control is, and tapping the banner does the same job. */
  hideMinimize?: boolean;
}) {
  const c = controls.call;
  const startedAt = c.phase === "active" ? c.startedAt : null;
  const elapsed = useElapsed(startedAt);
  if (
    c.phase !== "connecting" &&
    c.phase !== "active" &&
    c.phase !== "outgoing" &&
    c.phase !== "ended"
  )
    return null;
  const status =
    c.phase === "ended"
      ? c.label
      : c.phase === "active"
        ? elapsed
        : c.phase === "outgoing"
          ? "calling…"
          : "connecting…";
  const live = c.phase === "active";
  return (
    <div
      className={`call-screen active${c.phase === "ended" ? " ended" : ""}`}
      role="dialog"
      aria-label={`Call with ${c.callerName}`}
    >
      <button type="button" className="call-minimize" onClick={onMinimize} hidden={hideMinimize}>
        <svg aria-hidden="true" width="9" height="15" viewBox="0 0 9 15">
          <path
            d="M7.5 1.5L1.5 7.5l6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Messages
      </button>
      <div className="call-top">
        <div className="call-avatar" aria-hidden="true">
          {initial(c.callerName)}
        </div>
        <div className="call-name">{c.callerName}</div>
        <div className="call-sub" aria-live="polite">
          {status}
        </div>
      </div>
      <div className="call-grid">
        <div className="call-action">
          <button
            type="button"
            className={`round soft${controls.muted ? " on" : ""}`}
            onClick={controls.toggleMute}
            aria-pressed={controls.muted}
            aria-label="Mute"
            disabled={!live}
          >
            <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2Z"
              />
              {controls.muted && <path stroke="currentColor" strokeWidth="2" d="M4 3l16 18" />}
            </svg>
          </button>
          <span>mute</span>
        </div>
        <div className="call-action">
          <button type="button" className="round soft" disabled aria-label="Keypad">
            <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24">
              {[4, 12, 20].flatMap((y) =>
                [5, 12, 19].map((x) => (
                  <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="currentColor" />
                )),
              )}
            </svg>
          </button>
          <span>keypad</span>
        </div>
        <div className="call-action">
          <button type="button" className="round soft" disabled aria-label="Speaker">
            <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M4 9v6h4l5 5V4L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Z"
              />
            </svg>
          </button>
          <span>speaker</span>
        </div>
      </div>
      <div className="call-actions one">
        <button
          type="button"
          className="round decline"
          onClick={controls.hangUp}
          aria-label="End call"
          disabled={c.phase === "ended" || c.phase === "outgoing"}
        >
          <span className="hangup-glyph">
            <PhoneGlyph />
          </span>
        </button>
      </div>
    </div>
  );
}

/** A Messages notification that slides in over the call screen. */
export function Banner({
  item,
  sender,
  onDone,
  onOpenLink,
}: {
  item: ThreadItem;
  sender: string;
  onDone(): void;
  onOpenLink: (url: string) => boolean;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [onDone]);
  const body =
    item.kind === "link"
      ? item.title
      : item.kind === "draft"
        ? `Draft email: ${item.subject}`
        : item.text;
  const content = (
    <>
      <span className="banner-icon" aria-hidden="true">
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24">
          <path
            fill="#fff"
            d="M12 4C7 4 3 7.3 3 11.4c0 2.3 1.3 4.4 3.4 5.8-.2 1-.8 2-1.7 2.8 1.8-.1 3.3-.7 4.3-1.6.9.2 1.9.4 3 .4 5 0 9-3.3 9-7.4S17 4 12 4Z"
          />
        </svg>
      </span>
      <span className="banner-text">
        <span className="banner-row">
          <strong>{sender}</strong>
          <span className="banner-time">now</span>
        </span>
        <span className="banner-body">{body}</span>
      </span>
    </>
  );
  return item.kind === "link" ? (
    <a
      className="banner"
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (onOpenLink(item.url)) e.preventDefault();
        onDone();
      }}
    >
      {content}
    </a>
  ) : (
    <button type="button" className="banner" onClick={onDone}>
      {content}
    </button>
  );
}

export { PhoneGlyph };
