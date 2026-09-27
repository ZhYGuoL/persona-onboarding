// Messages between the server and the simulator page. Shared by both sides.

export type ThreadItem =
  | { id: string; from: "user"; kind: "text"; text: string; ts: number; clientId?: string }
  | { id: string; from: "agent"; kind: "text"; text: string; ts: number }
  | { id: string; from: "agent"; kind: "link"; url: string; title: string; ts: number };

export interface LogView {
  seq: number;
  ts: number;
  dir: "in" | "out" | "note";
  type: string;
  payload: unknown;
}

export type ServerMessage =
  | {
      t: "hello";
      sessionId: string;
      thread: ThreadItem[];
      log: LogView[];
      state: unknown;
      now: number;
    }
  | { t: "thread"; items: ThreadItem[] }
  | { t: "typing"; on: boolean }
  | { t: "log"; entry: LogView }
  | { t: "state"; state: unknown; now: number }
  | { t: "ring"; callId: string; callerName: string }
  /** The agent picked up a call the user placed. */
  | { t: "call_accepted"; callId: string }
  /** The call is over: the brain hung up, the ring timed out, or the line dropped. */
  | { t: "call_end"; callId: string; reason: string };

export type CallAction = "accept" | "decline" | "hangup" | "mic_denied" | "failed" | "start";

export type ClientMessage =
  | { t: "text"; text: string; clientId: string }
  | { t: "hello"; voice: boolean }
  | { t: "call"; action: CallAction; callId?: string };

export function threadFromLog(entries: LogView[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const e of entries) items.push(...threadItemsFor(e));
  return items;
}

export function threadItemsFor(e: LogView): ThreadItem[] {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.dir === "in" && e.type === "text_in" && typeof p.text === "string") {
    const clientId = typeof p.clientId === "string" ? p.clientId : undefined;
    return [{ id: `u${e.seq}`, from: "user", kind: "text", text: p.text, ts: e.ts, clientId }];
  }
  if (e.dir === "out" && e.type === "send_text" && Array.isArray(p.bubbles)) {
    return (p.bubbles as Array<Record<string, string>>).map((b, i) =>
      b.kind === "link"
        ? {
            id: `a${e.seq}-${i}`,
            from: "agent",
            kind: "link",
            url: b.url ?? "",
            title: b.title ?? "",
            ts: e.ts,
          }
        : { id: `a${e.seq}-${i}`, from: "agent", kind: "text", text: b.text ?? "", ts: e.ts },
    );
  }
  return [];
}
