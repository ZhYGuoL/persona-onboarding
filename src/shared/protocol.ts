// Messages between the server and the simulator page. Shared by both sides.

export type ThreadItem =
  | { id: string; from: "user"; kind: "text"; text: string; ts: number; clientId?: string }
  | { id: string; from: "agent"; kind: "text"; text: string; ts: number }
  | { id: string; from: "agent"; kind: "link"; url: string; title: string; ts: number }
  | {
      id: string;
      from: "agent";
      kind: "draft";
      to: string;
      subject: string;
      body: string;
      ts: number;
    };

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

/**
 * Voice timings the phone measures on the agent's audio, in milliseconds:
 * connect (tap to live session), first_audio (tap to the agent's first
 * sound), turn_latency (end of the caller's clip to the agent's reply), and
 * barge_in_stop (caller starts talking over the agent to the agent going quiet).
 */
export type VoiceMetricKind = "connect" | "first_audio" | "turn_latency" | "barge_in_stop";

export type ClientMessage =
  | { t: "text"; text: string; clientId: string }
  | { t: "hello"; voice: boolean; timeZone?: string }
  | { t: "call"; action: CallAction; callId?: string }
  /** The Gmail connect popup closed. */
  | { t: "oauth_closed" }
  | { t: "voice_metric"; callId: string; kind: VoiceMetricKind; ms: number }
  /** A scripted voice run starts or ends, so the report can grade it. */
  | { t: "voice_run"; scenario: string; status: "start" | "end"; detail?: string };

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
    return (p.bubbles as Array<Record<string, string>>).map((b, i): ThreadItem => {
      const id = `a${e.seq}-${i}`;
      if (b.kind === "link") {
        return {
          id,
          from: "agent",
          kind: "link",
          url: b.url ?? "",
          title: b.title ?? "",
          ts: e.ts,
        };
      }
      if (b.kind === "draft") {
        return {
          id,
          from: "agent",
          kind: "draft",
          to: b.to ?? "",
          subject: b.subject ?? "",
          body: b.body ?? "",
          ts: e.ts,
        };
      }
      return { id, from: "agent", kind: "text", text: b.text ?? "", ts: e.ts };
    });
  }
  return [];
}
