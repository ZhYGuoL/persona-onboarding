import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ThreadItem } from "../shared/protocol.ts";
import { ActiveCall, Banner, IncomingCall, PhoneGlyph } from "./CallScreens.tsx";
import type { CallControls } from "./useCall.ts";

const REVEAL_GAP_MS = 650;
const SEPARATOR_GAP_MS = 15 * 60_000;

interface PhoneProps {
  thread: ThreadItem[];
  fresh: Set<string>;
  typing: boolean;
  now: number | null;
  contactName: string;
  connected: boolean;
  onSend: (text: string) => boolean;
  call: CallControls;
  voiceAvailable: boolean;
}

export function Phone({
  thread,
  fresh,
  typing,
  now,
  contactName,
  connected,
  onSend,
  call,
  voiceAvailable,
}: PhoneProps) {
  const { visible, revealing } = useStaggered(thread, fresh);
  const scrollRef = useRef<HTMLDivElement>(null);
  const showTyping = typing || revealing;
  const phase = call.call.phase;
  const onCall =
    phase === "connecting" || phase === "active" || phase === "outgoing" || phase === "ended";
  const banner = useCallBanner(thread, fresh, onCall);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the thread grows or typing starts
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, showTyping]);

  const lastUserId = [...visible].reverse().find((i) => i.from === "user")?.id;
  const lastItem = visible[visible.length - 1];

  return (
    <section className="phone" aria-label="Phone simulator">
      <div className="phone-screen">
        <StatusBar now={now} dark={phase !== "idle"} />
        {phase === "ringing" && call.call.phase === "ringing" && (
          <IncomingCall
            name={call.call.callerName}
            onAccept={call.accept}
            onDecline={call.decline}
          />
        )}
        {onCall && <ActiveCall controls={call} />}
        {banner.item && <Banner item={banner.item} sender={contactName} onDone={banner.dismiss} />}
        <header className="thread-header">
          <button
            type="button"
            className="header-call"
            aria-label={`Call ${contactName}`}
            disabled={!voiceAvailable || phase !== "idle"}
            onClick={() => call.startCall(contactName)}
          >
            <PhoneGlyph size={20} />
          </button>
          <div className="avatar" aria-hidden="true">
            {initial(contactName)}
          </div>
          <div className="contact-name">
            {contactName}
            <svg width="7" height="11" viewBox="0 0 7 11" aria-hidden="true">
              <path
                d="M1 1l4.5 4.5L1 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </header>
        <div className="thread" ref={scrollRef}>
          {visible.map((item, i) => {
            const prev = visible[i - 1];
            const next = visible[i + 1];
            const separator = !prev || item.ts - prev.ts >= SEPARATOR_GAP_MS;
            const groupEnd =
              !next || next.from !== item.from || next.ts - item.ts >= SEPARATOR_GAP_MS;
            const groupStart = !prev || prev.from !== item.from || separator;
            return (
              <div key={item.id} className="thread-row-wrap">
                {separator && <div className="separator">{formatSeparator(item.ts, now)}</div>}
                <Bubble
                  item={item}
                  tail={groupEnd && !(showTyping && item === lastItem && item.from === "agent")}
                  spaced={groupStart}
                  animate={fresh.has(item.id)}
                />
                {item.id === lastUserId && item === lastItem && !showTyping && (
                  <div className="receipt">Delivered</div>
                )}
              </div>
            );
          })}
          {showTyping && (
            <div className="row them spaced">
              <div className="typing" role="status" aria-label={`${contactName} is typing`}>
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
        <Composer connected={connected} onSend={onSend} />
        <div className="home-indicator" aria-hidden="true" />
      </div>
    </section>
  );
}

function Bubble({
  item,
  tail,
  spaced,
  animate,
}: {
  item: ThreadItem;
  tail: boolean;
  spaced: boolean;
  animate: boolean;
}) {
  const side = item.from === "user" ? "me" : "them";
  const cls = `row ${side}${spaced ? " spaced" : ""}${animate ? " pop" : ""}`;
  if (item.kind === "link") {
    return (
      <div className={cls}>
        <a
          className={`link-card${tail ? " tail" : ""}`}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="link-title">{item.title}</span>
          <span className="link-domain">{domainOf(item.url)}</span>
        </a>
      </div>
    );
  }
  return (
    <div className={cls}>
      <div className={`bubble ${side}${tail ? " tail" : ""}`}>{item.text}</div>
    </div>
  );
}

function Composer({
  connected,
  onSend,
}: {
  connected: boolean;
  onSend: (text: string) => boolean;
}) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (onSend(value)) setText("");
  };
  return (
    <form className="composer" onSubmit={submit}>
      <div className="plus" aria-hidden="true">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
          <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <div className="field">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={connected ? "iMessage" : "Connecting…"}
          aria-label="Message"
          maxLength={2000}
          autoComplete="off"
        />
        {text.trim() && (
          <button type="submit" className="send" aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M7 12V2M2.5 6.5L7 2l4.5 4.5"
                fill="none"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}

/** While a call screen is up, a new agent text shows as a notification banner. */
function useCallBanner(thread: ThreadItem[], fresh: Set<string>, onCall: boolean) {
  const [item, setItem] = useState<ThreadItem | null>(null);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!onCall) return;
    const latest = [...thread].reverse().find((t) => t.from === "agent" && fresh.has(t.id));
    if (latest && !shown.current.has(latest.id)) {
      shown.current.add(latest.id);
      setItem(latest);
    }
  }, [thread, fresh, onCall]);
  const dismiss = useCallback(() => setItem(null), []);
  return { item: onCall ? item : null, dismiss };
}

function StatusBar({ now, dark = false }: { now: number | null; dark?: boolean }) {
  const time = new Date(now ?? Date.now())
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(/\s?[AP]M$/i, "");
  return (
    <div className={`status-bar${dark ? " on-dark" : ""}`}>
      <span className="status-time">{time}</span>
      <div className="island" aria-hidden="true" />
      <span className="status-icons" aria-hidden="true">
        <svg aria-hidden="true" width="18" height="12" viewBox="0 0 18 12">
          <rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor" />
          <rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor" />
          <rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor" />
        </svg>
        <svg aria-hidden="true" width="16" height="12" viewBox="0 0 16 12">
          <path
            d="M8 11.5l2.2-2.6a3.2 3.2 0 00-4.4 0L8 11.5zM3.9 6.9a6 6 0 018.2 0l1.4-1.6a8.2 8.2 0 00-11 0l1.4 1.6zM1.1 3.6a10.3 10.3 0 0113.8 0L16 2.3A12 12 0 000 2.3l1.1 1.3z"
            fill="currentColor"
          />
        </svg>
        <svg aria-hidden="true" width="26" height="12" viewBox="0 0 26 12">
          <rect
            x="0.5"
            y="0.5"
            width="22"
            height="11"
            rx="3.5"
            fill="none"
            stroke="currentColor"
            opacity="0.4"
          />
          <rect x="2" y="2" width="17" height="8" rx="2" fill="currentColor" />
          <path d="M24 4v4a2 2 0 000-4z" fill="currentColor" opacity="0.4" />
        </svg>
      </span>
    </div>
  );
}

/** Live agent texts appear one at a time, like a person typing several texts. */
function useStaggered(thread: ThreadItem[], fresh: Set<string>) {
  const [shown, setShown] = useState<Set<string>>(() => new Set(thread.map((t) => t.id)));
  const queue = useMemo(
    () => thread.filter((t) => !shown.has(t.id) && t.from === "agent" && fresh.has(t.id)),
    [thread, shown, fresh],
  );

  // Items that do not need staggering show at once.
  useEffect(() => {
    const instant = thread.filter(
      (t) => !shown.has(t.id) && !(t.from === "agent" && fresh.has(t.id)),
    );
    if (instant.length) setShown((s) => new Set([...s, ...instant.map((t) => t.id)]));
  }, [thread, shown, fresh]);

  const lastReveal = useRef(0);
  useEffect(() => {
    const next = queue[0];
    if (!next) return;
    const wait = Math.max(0, lastReveal.current + REVEAL_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      lastReveal.current = Date.now();
      setShown((s) => new Set(s).add(next.id));
    }, wait);
    return () => clearTimeout(timer);
  }, [queue]);

  const visible = thread.filter((t) => shown.has(t.id));
  return { visible, revealing: queue.length > 0 };
}

function initial(name: string): string {
  const first = [...name.trim()][0] ?? "P";
  return first.toUpperCase();
}

function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatSeparator(ts: number, now: number | null): string {
  const d = new Date(ts);
  const today = new Date(now ?? Date.now());
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}
