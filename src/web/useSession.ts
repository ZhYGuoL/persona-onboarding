// Connects the page to the server: session cookie, WebSocket with reconnect,
// and the thread, typing, state, and log it streams.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, LogView, ServerMessage, ThreadItem } from "../shared/protocol.ts";

export interface SessionView {
  connected: boolean;
  sessionId: string | null;
  thread: ThreadItem[];
  typing: boolean;
  state: Record<string, unknown> | null;
  now: number | null;
  log: LogView[];
  /** Ids of items that arrived live (not from history), so the UI can animate them. */
  fresh: Set<string>;
}

const EMPTY: SessionView = {
  connected: false,
  sessionId: null,
  thread: [],
  typing: false,
  state: null,
  now: null,
  log: [],
  fresh: new Set(),
};

export interface SessionOptions {
  /** Whether this browser can place a voice call. */
  voice: boolean;
  /** Every server message also goes here (the call hook listens for rings). */
  onMessage?: (msg: ServerMessage) => void;
}

export function useSession({ voice, onMessage }: SessionOptions) {
  const [view, setView] = useState<SessionView>(EMPTY);
  const [epoch, setEpoch] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new epoch (after reset) reconnects with the new session cookie
  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      await fetch("/api/session", { credentials: "same-origin" });
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      socketRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        ws.send(JSON.stringify({ t: "hello", voice } satisfies ClientMessage));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        setView((v) => reduce(v, msg));
        onMessageRef.current?.(msg);
      };
      ws.onclose = () => {
        setView((v) => ({ ...v, connected: false, typing: false }));
        if (closed) return;
        retry += 1;
        timer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry));
      };
    };
    setView(EMPTY);
    void connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socketRef.current?.close();
    };
  }, [epoch]);

  const sendRaw = useCallback((msg: ClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendText = useCallback((text: string) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const clientId = crypto.randomUUID();
    setView((v) => ({
      ...v,
      thread: [
        ...v.thread,
        { id: clientId, from: "user", kind: "text", text, ts: v.now ?? Date.now(), clientId },
      ],
      fresh: new Set(v.fresh).add(clientId),
    }));
    ws.send(JSON.stringify({ t: "text", text, clientId }));
    return true;
  }, []);

  const reset = useCallback(async () => {
    await fetch("/api/reset", { method: "POST", credentials: "same-origin" });
    setEpoch((e) => e + 1);
  }, []);

  const fastForward = useCallback(async (ms: number) => {
    await fetch("/api/reviewer/fast-forward", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ms }),
    });
  }, []);

  const reviewer = useCallback(async (path: string, body: object = {}) => {
    await fetch(`/api/reviewer/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }, []);

  return { view, sendText, sendRaw, reset, fastForward, reviewer };
}

function reduce(v: SessionView, msg: ServerMessage): SessionView {
  switch (msg.t) {
    case "hello":
      return {
        connected: true,
        sessionId: msg.sessionId,
        thread: msg.thread,
        typing: false,
        state: msg.state as Record<string, unknown>,
        now: msg.now,
        log: msg.log,
        fresh: new Set(),
      };
    case "thread": {
      let thread = v.thread;
      const fresh = new Set(v.fresh);
      for (const item of msg.items) {
        if (thread.some((t) => t.id === item.id)) continue;
        const echo =
          item.from === "user" && item.clientId
            ? thread.findIndex((t) => t.id === item.clientId)
            : -1;
        if (echo >= 0) {
          thread = thread.map((t, i) => (i === echo ? item : t));
          fresh.add(item.id);
        } else {
          thread = [...thread, item];
          fresh.add(item.id);
        }
      }
      return { ...v, thread, fresh };
    }
    case "typing":
      return { ...v, typing: msg.on };
    case "state":
      return { ...v, state: msg.state as Record<string, unknown>, now: msg.now };
    case "log":
      if (v.log.some((e) => e.seq === msg.entry.seq)) return v;
      return { ...v, log: [...v.log, msg.entry].slice(-500) };
    default:
      return v;
  }
}
