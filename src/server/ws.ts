// The text channel: a WebSocket between the simulator page and the hub.
// It also streams the ledger and the event log to the reviewer panel.

import type { WebSocket } from "ws";
import type { Hub, HubMessage } from "../runtime/hub.ts";
import type { LogEntry } from "../runtime/store.ts";
import {
  type ClientMessage,
  type ServerMessage,
  threadFromLog,
  threadItemsFor,
} from "../shared/protocol.ts";

const MAX_TEXTS_PER_MINUTE = 40;

export function attachTextChannel(hub: Hub, sessionId: string, socket: WebSocket): void {
  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const onLog = (entry: LogEntry) => {
    send({ t: "log", entry });
    const items = threadItemsFor(entry);
    if (items.length) send({ t: "thread", items });
  };
  const unsubscribe = hub.subscribe(sessionId, (msg: HubMessage) => {
    switch (msg.type) {
      case "action":
        onLog(msg.entry);
        if (msg.action.type === "typing") send({ t: "typing", on: msg.action.on });
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
  void hub.dispatch(sessionId, { type: "client_connected" });

  const recent: number[] = [];
  socket.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
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

  const ping = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, 25_000);
  socket.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}
