// The simulator's channel: a WebSocket between the page and the hub. It
// carries the text thread and the phone's call controls, and streams the
// ledger and the event log to the reviewer panel.

import type { WebSocket } from "ws";
import type { CallEndReason } from "../brain/types.ts";
import type { Hub, HubMessage } from "../runtime/hub.ts";
import type { LogEntry } from "../runtime/store.ts";
import {
  type ClientMessage,
  type ServerMessage,
  threadFromLog,
  threadItemsFor,
} from "../shared/protocol.ts";
import type { VoiceManager } from "../voice/live.ts";

const MAX_TEXTS_PER_MINUTE = 40;

export interface ChannelDeps {
  hub: Hub;
  voice: VoiceManager | null;
  /** The Gmail connect popup closed. No callback by then means the user backed out. */
  onOAuthClosed: (sessionId: string) => void;
}

export function attachChannel(
  { hub, voice, onOAuthClosed }: ChannelDeps,
  sessionId: string,
  socket: WebSocket,
): void {
  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const onLog = (entry: LogEntry) => {
    send({ t: "log", entry });
    const items = threadItemsFor(entry);
    if (items.length) send({ t: "thread", items });
    // Any end of a call, however it happened, tears down the phone's call screen.
    if (entry.dir === "in" && entry.type === "call_ended") {
      const p = entry.payload as { callId: string; reason: string };
      send({ t: "call_end", callId: p.callId, reason: p.reason });
    }
  };
  const unsubscribe = hub.subscribe(sessionId, (msg: HubMessage) => {
    switch (msg.type) {
      case "action":
        onLog(msg.entry);
        if (msg.action.type === "typing") send({ t: "typing", on: msg.action.on });
        if (msg.action.type === "ring_phone") {
          send({ t: "ring", callId: msg.action.callId, callerName: msg.action.callerName });
        }
        if (msg.action.type === "call_accepted")
          send({ t: "call_accepted", callId: msg.action.callId });
        if (msg.action.type === "end_call") {
          // The brain hung up or the ring timed out. The phone stops ringing at once;
          // a live call stays up until the agent's session closes.
          const state = hub.state(sessionId);
          if (state.call.status !== "active")
            send({ t: "call_end", callId: msg.action.callId, reason: "ended" });
        }
        break;
      case "log":
        onLog(msg.entry);
        break;
      case "state":
        send({ t: "state", state: msg.state, now: msg.now });
        break;
    }
  });

  const log = hub.log(sessionId);
  send({
    t: "hello",
    sessionId,
    thread: threadFromLog(log),
    log: log.slice(-300),
    state: hub.state(sessionId),
    now: hub.now(sessionId),
  });
  const state = hub.state(sessionId);
  if (state.call.status === "ringing" && state.call.callId) {
    // A reload while the phone rings shows the ring screen again.
    send({
      t: "ring",
      callId: state.call.callId,
      callerName: state.slots.agent_name.value ?? "Persona",
    });
  }
  void hub.dispatch(sessionId, { type: "client_connected" });

  const recent: number[] = [];
  socket.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (msg?.t === "hello") {
      void hub.dispatch(sessionId, {
        type: "capabilities",
        caps: { voice: voice !== null && msg.voice === true },
      });
      if (typeof msg.timeZone === "string" && msg.timeZone.length <= 64) {
        void hub.dispatch(sessionId, { type: "client_info", timeZone: msg.timeZone });
      }
      return;
    }
    if (msg?.t === "oauth_closed") {
      onOAuthClosed(sessionId);
      return;
    }
    if (msg?.t === "call") {
      onCallAction(
        msg.action,
        typeof msg.callId === "string" ? msg.callId.slice(0, 200) : undefined,
      );
      return;
    }
    if (msg?.t !== "text" || typeof msg.text !== "string" || typeof msg.clientId !== "string")
      return;
    const now = Date.now();
    while (recent.length && (recent[0] ?? 0) < now - 60_000) recent.shift();
    if (recent.length >= MAX_TEXTS_PER_MINUTE) return;
    recent.push(now);
    void hub.dispatch(
      sessionId,
      { type: "text_in", text: msg.text.slice(0, 2000) },
      { clientId: msg.clientId.slice(0, 64) },
    );
  });

  function onCallAction(action: string, callId: string | undefined): void {
    if (action === "start") {
      void hub.dispatch(sessionId, { type: "user_called" });
      return;
    }
    if (!callId) return;
    switch (action) {
      case "accept":
        void hub.dispatch(sessionId, { type: "call_answered", callId });
        break;
      case "decline":
        void hub.dispatch(sessionId, { type: "call_declined", callId });
        break;
      case "hangup":
      case "mic_denied":
      case "failed": {
        const reason: CallEndReason =
          action === "hangup"
            ? "remote_hangup"
            : action === "mic_denied"
              ? "mic_denied"
              : "connection_lost";
        if (voice) voice.endFromClient(sessionId, callId, reason);
        else void hub.dispatch(sessionId, { type: "call_ended", callId, reason });
        break;
      }
    }
  }

  const ping = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, 25_000);
  socket.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}
