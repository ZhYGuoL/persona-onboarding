// The voice adapter. For each call it creates a GPT-Live WebRTC session from
// the browser's SDP offer, attaches a server-side sideband WebSocket, turns
// transcript fragments into brain events, and carries out the brain's call
// actions (context pushes and hangups). Audio never touches this server.

import { appendFileSync } from "node:fs";
import OpenAI from "openai";
import WebSocket from "ws";
import { callInstructions, callSeedHistory } from "../brain/call.ts";
import type { BrainConfig } from "../brain/config.ts";
import type { Action, CallEndReason, PushKind } from "../brain/types.ts";
import type { Clock } from "../runtime/clock.ts";
import type { Hub } from "../runtime/hub.ts";
import { UtteranceGrouper } from "./grouper.ts";

export const LIVE_MODEL = "gpt-live-1";
const CLOSE_TIMEOUT_MS = 8000;
const MAX_PUSH_CHARS = 1800;

export interface VoiceOptions {
  hub: Hub;
  cfg: BrainConfig;
  apiKey: string;
  clock: Clock;
  voice?: string;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

type LiveEvent = { type: string; [key: string]: unknown };

const CLOSE_REASONS: CallEndReason[] = [
  "close_requested",
  "expired",
  "content",
  "remote_hangup",
  "connection_lost",
];

class LiveCall {
  readonly sessionId: string;
  readonly callId: string;
  liveSessionId: string | null = null;
  private socket: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private closing = false;
  private readonly queue: LiveEvent[] = [];
  private readonly grouper: UtteranceGrouper;
  private seq = 0;
  seconds = 0;

  private readonly mgr: VoiceManager;

  constructor(mgr: VoiceManager, sessionId: string, callId: string) {
    this.mgr = mgr;
    this.sessionId = sessionId;
    this.callId = callId;
    this.grouper = new UtteranceGrouper({
      clock: mgr.opts.clock,
      onUserStart: () => {
        void mgr.opts.hub.dispatch(sessionId, { type: "voice_activity", callId, role: "user" });
      },
      onAgentStart: () => {
        void mgr.opts.hub.dispatch(sessionId, { type: "voice_activity", callId, role: "agent" });
      },
      onFinal: (role, text, startedAt) => {
        void mgr.opts.hub.dispatch(sessionId, {
          type: "transcript_final",
          callId,
          role,
          text,
          startedAgoMs: mgr.opts.clock.now() - startedAt,
        });
      },
    });
  }

  attach(liveSessionId: string): void {
    this.liveSessionId = liveSessionId;
    const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${liveSessionId}/attach`, {
      headers: { Authorization: `Bearer ${this.mgr.opts.apiKey}` },
    });
    this.socket = ws;
    ws.on("open", () => {
      this.ready = true;
      for (const ev of this.queue.splice(0)) ws.send(JSON.stringify(ev));
    });
    ws.on("message", (raw) => {
      let ev: LiveEvent;
      try {
        ev = JSON.parse(String(raw)) as LiveEvent;
      } catch {
        return;
      }
      this.onEvent(ev);
    });
    ws.on("error", (err) =>
      this.mgr.opts.log.warn({ err: err.message, callId: this.callId }, "sideband error"),
    );
    ws.on("close", () => {
      this.ready = false;
      // A sideband that dies before session.closed means we lost the call.
      if (!this.ended) this.finish(this.closing ? "close_requested" : "connection_lost");
    });
  }

  private onEvent(ev: LiveEvent): void {
    const debugFile = process.env.VOICE_DEBUG_FILE;
    if (
      debugFile &&
      ev.type !== "session.input_audio.append" &&
      ev.type !== "session.output_audio.delta"
    ) {
      appendFileSync(debugFile, `${JSON.stringify({ at: Date.now(), callId: this.callId, ev })}\n`);
    }
    switch (ev.type) {
      case "session.input_transcript.delta":
        if (typeof ev.delta === "string") this.grouper.delta("user", ev.delta);
        break;
      case "session.output_transcript.delta":
        if (typeof ev.delta === "string") this.grouper.delta("agent", ev.delta);
        break;
      case "session.delegation.created": {
        // There is no backend on calls. Answer any delegation right away.
        const delegation = ev.delegation as { id?: string } | undefined;
        if (delegation?.id) {
          this.send({
            type: "session.commentary.append",
            event_id: this.eventId("delegation"),
            delegation_id: delegation.id,
            content:
              "You cannot do that during this call. Say so plainly, and say you will follow up by text.",
          });
        }
        break;
      }
      case "session.usage.updated": {
        const usage = ev.usage as { seconds?: number } | undefined;
        if (typeof usage?.seconds === "number") this.seconds = usage.seconds;
        break;
      }
      case "session.closed": {
        const reason = CLOSE_REASONS.includes(ev.reason as CallEndReason)
          ? (ev.reason as CallEndReason)
          : "error";
        const usage = ev.usage as { seconds?: number } | undefined;
        if (typeof usage?.seconds === "number") this.seconds = usage.seconds;
        this.finish(reason);
        break;
      }
      case "error":
        this.mgr.opts.log.warn({ callId: this.callId, error: ev.error }, "live session error");
        break;
    }
  }

  push(kind: PushKind, text: string): void {
    this.send({
      type: `session.${kind}.append`,
      event_id: this.eventId(kind),
      delegation_id: null,
      content: text.slice(0, MAX_PUSH_CHARS),
    });
  }

  /** Graceful close. The session.closed event reports `close_requested`. */
  hangUp(): void {
    if (this.ended || this.closing) return;
    this.closing = true;
    this.send({ type: "session.close", event_id: this.eventId("close") });
    this.mgr.opts.clock.setTimeout(() => {
      if (!this.ended) this.finish("close_requested");
    }, CLOSE_TIMEOUT_MS);
  }

  /** The browser hung up or lost the call. Tell the brain now, close the session quietly. */
  endFromClient(reason: CallEndReason): void {
    if (this.ended) return;
    this.finish(reason);
    if (this.ready) this.send({ type: "session.close", event_id: this.eventId("close") });
  }

  private finish(reason: CallEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.grouper.flushAll();
    void this.mgr.opts.hub.dispatch(this.sessionId, {
      type: "call_ended",
      callId: this.callId,
      reason,
    });
    this.mgr.opts.log.info({ callId: this.callId, reason, seconds: this.seconds }, "call ended");
    this.mgr.forget(this);
    this.mgr.opts.clock.setTimeout(() => this.socket?.close(), 2000);
  }

  private send(ev: LiveEvent): void {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(ev));
    else this.queue.push(ev);
  }

  private eventId(kind: string): string {
    this.seq += 1;
    return `${kind}_${this.seq}`;
  }
}

export class VoiceManager {
  readonly opts: VoiceOptions;
  private readonly client: OpenAI;
  private readonly calls = new Map<string, LiveCall>();
  /** Pushes the brain sent before the browser's offer arrived. */
  private readonly outbox = new Map<string, Array<{ kind: PushKind; text: string }>>();

  constructor(opts: VoiceOptions) {
    this.opts = opts;
    this.client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 1 });
  }

  /** Called for every hub action. Only call actions matter here. */
  onAction(sessionId: string, action: Action): void {
    if (action.type === "push_to_call") {
      const call = this.calls.get(action.callId);
      if (call) call.push(action.kind, action.text);
      else {
        const box = this.outbox.get(action.callId) ?? [];
        box.push({ kind: action.kind, text: action.text });
        this.outbox.set(action.callId, box);
      }
    } else if (action.type === "end_call") {
      const call = this.calls.get(action.callId);
      if (call) call.hangUp();
      this.outbox.delete(action.callId);
    }
    void sessionId;
  }

  /** Create the GPT-Live session for an answered call and return the SDP answer. */
  async connect(sessionId: string, callId: string, sdp: string): Promise<string> {
    const s = this.opts.hub.state(sessionId);
    if (s.call.callId !== callId || s.call.status !== "active") throw new CallNotActiveError();
    if (this.calls.has(callId)) throw new CallNotActiveError();
    const result = await this.client.live.create({
      session: {
        model: LIVE_MODEL,
        instructions: callInstructions(s, this.opts.cfg),
        input: callSeedHistory(s.history).map((m) =>
          m.role === "user"
            ? { type: "message", role: "user", content: [{ type: "input_text", text: m.text }] }
            : {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: m.text }],
              },
        ),
        audio: { output: { voice: this.opts.voice ?? "marin" } },
        delegation: { type: "client" },
        // The browser is untrusted. It may not send any event, and it only hears start and close.
        client: {
          data_channel: {
            allowed_client_events: [],
            allowed_server_events: [{ type: "session.started" }, { type: "session.closed" }],
          },
        },
      },
      transport: { type: "webrtc", sdp },
    });
    const call = new LiveCall(this, sessionId, callId);
    this.calls.set(callId, call);
    for (const p of this.outbox.get(callId) ?? []) call.push(p.kind, p.text);
    this.outbox.delete(callId);
    call.attach(result.session.id);
    this.opts.log.info({ callId, liveSessionId: result.session.id }, "live session created");
    return result.transport.sdp;
  }

  /** The browser reports the end of the call (hangup, failure, or no mic). */
  endFromClient(sessionId: string, callId: string, reason: CallEndReason): void {
    const call = this.calls.get(callId);
    if (call) call.endFromClient(reason);
    else void this.opts.hub.dispatch(sessionId, { type: "call_ended", callId, reason });
    this.outbox.delete(callId);
  }

  forget(call: LiveCall): void {
    this.calls.delete(call.callId);
  }
}

export class CallNotActiveError extends Error {
  constructor() {
    super("no active call with that id");
  }
}
