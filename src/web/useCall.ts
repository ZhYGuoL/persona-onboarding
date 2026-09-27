// The phone side of a call: ring screen, WebRTC to GPT-Live, and hangup.
// Audio goes straight between the browser and OpenAI. The server only
// exchanges the SDP offer and watches the call through its sideband.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage, VoiceMetricKind } from "../shared/protocol.ts";
import { Ringtone } from "./ringtone.ts";
import { VoiceMeter } from "./voiceMeter.ts";

export type CallPhase =
  | { phase: "idle" }
  | { phase: "ringing"; callId: string; callerName: string }
  | { phase: "outgoing"; callerName: string }
  | { phase: "connecting"; callId: string; callerName: string }
  | { phase: "active"; callId: string; callerName: string; startedAt: number }
  | { phase: "ended"; callerName: string; label: string };

const ENDED_SCREEN_MS = 1600;
const DISCONNECT_GRACE_MS = 4000;

export interface CallControls {
  call: CallPhase;
  muted: boolean;
  testVoice: boolean;
  accept(): void;
  decline(): void;
  hangUp(): void;
  startCall(callerName: string): void;
  toggleMute(): void;
  setTestVoice(on: boolean): void;
  /** Play a prerecorded clip into the call, as if the user said it. Resolves when it ends. Test voice only. */
  sayClip(url: string): Promise<void>;
  /** The agent's audio is playing right now. */
  agentSpeaking(): boolean;
  onServerMessage(msg: ServerMessage): void;
}

export function voiceSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function useCall(send: (msg: ClientMessage) => void): CallControls {
  const [call, setCall] = useState<CallPhase>({ phase: "idle" });
  const [muted, setMuted] = useState(false);
  const [testVoice, setTestVoice] = useState(false);
  const callRef = useRef(call);
  callRef.current = call;
  const testVoiceRef = useRef(testVoice);
  testVoiceRef.current = testVoice;

  const pc = useRef<RTCPeerConnection | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const clipDest = useRef<MediaStreamAudioDestinationNode | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const ringtone = useRef<Ringtone | null>(null);
  const endedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dropTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepAlive = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Voice timings, measured on the audio the phone plays.
  const meter = useRef<VoiceMeter | null>(null);
  const tapAt = useRef<number | null>(null);
  const metricCallId = useRef<string | null>(null);
  const firstAudioSent = useRef(false);
  const clipEndedAt = useRef<number | null>(null);
  const bargeInAt = useRef<number | null>(null);

  const metric = useCallback(
    (kind: VoiceMetricKind, ms: number) => {
      const callId = metricCallId.current;
      if (callId) send({ t: "voice_metric", callId, kind, ms: Math.round(ms) });
    },
    [send],
  );

  const stopRinging = useCallback(() => ringtone.current?.stop(), []);

  const teardown = useCallback(() => {
    clearTimeout(dropTimer.current);
    clearInterval(keepAlive.current);
    meter.current?.stop();
    meter.current = null;
    tapAt.current = null;
    metricCallId.current = null;
    firstAudioSent.current = false;
    clipEndedAt.current = null;
    bargeInAt.current = null;
    pc.current?.close();
    pc.current = null;
    for (const t of mic.current?.getTracks() ?? []) t.stop();
    mic.current = null;
    void audioCtx.current?.close();
    audioCtx.current = null;
    clipDest.current = null;
    if (player.current) player.current.srcObject = null;
    setMuted(false);
  }, []);

  const showEnded = useCallback(
    (callerName: string, label: string) => {
      stopRinging();
      teardown();
      clearTimeout(endedTimer.current);
      setCall({ phase: "ended", callerName, label });
      endedTimer.current = setTimeout(() => setCall({ phase: "idle" }), ENDED_SCREEN_MS);
    },
    [stopRinging, teardown],
  );

  const connect = useCallback(
    async (callId: string, callerName: string) => {
      setCall({ phase: "connecting", callId, callerName });
      metricCallId.current = callId;
      tapAt.current ??= performance.now();
      let stream: MediaStream;
      try {
        if (testVoiceRef.current) {
          const ctx = new AudioContext();
          audioCtx.current = ctx;
          clipDest.current = ctx.createMediaStreamDestination();
          // Stream silence between clips, like an open mic. GPT-Live's timeline only
          // moves while audio arrives, so a silent gap would freeze the agent.
          const hum = ctx.createOscillator();
          const mute = ctx.createGain();
          mute.gain.value = 0;
          hum.connect(mute).connect(clipDest.current);
          hum.start();
          // Chrome can suspend audio in a background tab (for example, behind the
          // Gmail popup). Resume it, or the silence stops and the call freezes.
          keepAlive.current = setInterval(() => {
            if (ctx.state === "suspended") void ctx.resume();
          }, 500);
          (window as unknown as { __testVoiceState?: () => string }).__testVoiceState = () =>
            ctx.state;
          stream = clipDest.current.stream;
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        }
      } catch {
        send({ t: "call", action: "mic_denied", callId });
        showEnded(callerName, "Microphone Blocked");
        return;
      }
      mic.current = stream;
      try {
        const conn = new RTCPeerConnection();
        pc.current = conn;
        if (!player.current) {
          player.current = new Audio();
          player.current.autoplay = true;
        }
        conn.addEventListener("track", (e) => {
          if (!player.current) return;
          const remote = new MediaStream([e.track]);
          player.current.srcObject = remote;
          void player.current.play().catch(() => {});
          meter.current?.stop();
          meter.current = new VoiceMeter(remote, {
            onStart: (at) => {
              if (!firstAudioSent.current && tapAt.current !== null) {
                firstAudioSent.current = true;
                metric("first_audio", at - tapAt.current);
              }
              if (clipEndedAt.current !== null && at >= clipEndedAt.current) {
                metric("turn_latency", at - clipEndedAt.current);
                clipEndedAt.current = null;
              }
            },
            onEnd: (at) => {
              if (bargeInAt.current !== null) {
                metric("barge_in_stop", at - bargeInAt.current);
                bargeInAt.current = null;
              }
            },
          });
        });
        for (const track of stream.getAudioTracks()) conn.addTrack(track, stream);
        // GPT-Live needs this data channel. The server allows it to carry only start and close.
        const events = conn.createDataChannel("oai-events");
        events.addEventListener("message", ({ data }) => {
          const ev = JSON.parse(String(data)) as { type: string };
          if (ev.type === "session.started") {
            if (tapAt.current !== null) metric("connect", performance.now() - tapAt.current);
            setCall((c) =>
              c.phase === "connecting" && c.callId === callId
                ? { phase: "active", callId, callerName, startedAt: Date.now() }
                : c,
            );
          }
        });
        conn.addEventListener("connectionstatechange", () => {
          const state = conn.connectionState;
          clearTimeout(dropTimer.current);
          if (state === "failed") {
            send({ t: "call", action: "failed", callId });
            showEnded(callerName, "Call Failed");
          } else if (state === "disconnected") {
            dropTimer.current = setTimeout(() => {
              send({ t: "call", action: "failed", callId });
              showEnded(callerName, "Call Failed");
            }, DISCONNECT_GRACE_MS);
          }
        });
        await conn.setLocalDescription(await conn.createOffer());
        await iceGathered(conn);
        const res = await fetch("/api/call/offer", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId, sdp: conn.localDescription?.sdp }),
        });
        if (!res.ok) throw new Error(`offer failed: ${res.status}`);
        const { sdp } = (await res.json()) as { sdp: string };
        await conn.setRemoteDescription({ type: "answer", sdp });
      } catch {
        if (callRef.current.phase === "connecting") {
          send({ t: "call", action: "failed", callId });
          showEnded(callerName, "Call Failed");
        }
      }
    },
    [send, showEnded, metric],
  );

  const onServerMessage = useCallback(
    (msg: ServerMessage) => {
      const current = callRef.current;
      if (msg.t === "ring") {
        clearTimeout(endedTimer.current);
        setCall({ phase: "ringing", callId: msg.callId, callerName: msg.callerName });
        ringtone.current ??= new Ringtone();
        ringtone.current.start();
      } else if (msg.t === "call_accepted") {
        const name = current.phase === "outgoing" ? current.callerName : "Persona";
        void connect(msg.callId, name);
      } else if (msg.t === "call_end") {
        const same = "callId" in current && current.callId === msg.callId;
        if (!same) return;
        const label =
          current.phase === "ringing"
            ? "Missed Call"
            : msg.reason === "connection_lost"
              ? "Call Lost"
              : "Call Ended";
        showEnded(current.callerName, label);
      }
    },
    [connect, showEnded],
  );

  const accept = useCallback(() => {
    const c = callRef.current;
    if (c.phase !== "ringing") return;
    stopRinging();
    tapAt.current = performance.now();
    send({ t: "call", action: "accept", callId: c.callId });
    void connect(c.callId, c.callerName);
  }, [connect, send, stopRinging]);

  const decline = useCallback(() => {
    const c = callRef.current;
    if (c.phase !== "ringing") return;
    send({ t: "call", action: "decline", callId: c.callId });
    showEnded(c.callerName, "Declined");
  }, [send, showEnded]);

  const hangUp = useCallback(() => {
    const c = callRef.current;
    if (c.phase !== "connecting" && c.phase !== "active") return;
    send({ t: "call", action: "hangup", callId: c.callId });
    showEnded(c.callerName, "Call Ended");
  }, [send, showEnded]);

  const startCall = useCallback(
    (callerName: string) => {
      if (callRef.current.phase !== "idle") return;
      tapAt.current = performance.now();
      setCall({ phase: "outgoing", callerName });
      send({ t: "call", action: "start" });
    },
    [send],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      for (const t of mic.current?.getAudioTracks() ?? []) t.enabled = m;
      return !m;
    });
  }, []);

  const sayClip = useCallback(async (url: string) => {
    const ctx = audioCtx.current;
    const dest = clipDest.current;
    if (!ctx || !dest) return;
    const data = await (await fetch(url)).arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    // Talking over the agent: time how long it takes to go quiet.
    if (meter.current?.isSpeaking) bargeInAt.current = performance.now();
    clipEndedAt.current = null;
    await new Promise<void>((resolve) => {
      source.onended = () => {
        clipEndedAt.current = performance.now();
        resolve();
      };
      source.start();
    });
  }, []);

  const agentSpeaking = useCallback(() => meter.current?.isSpeaking ?? false, []);

  useEffect(
    () => () => {
      stopRinging();
      teardown();
      clearTimeout(endedTimer.current);
    },
    [stopRinging, teardown],
  );

  return {
    call,
    muted,
    testVoice,
    accept,
    decline,
    hangUp,
    startCall,
    toggleMute,
    setTestVoice,
    sayClip,
    agentSpeaking,
    onServerMessage,
  };
}

function iceGathered(conn: RTCPeerConnection): Promise<void> {
  if (conn.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ICE gathering timed out")), 10_000);
    const check = () => {
      if (conn.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      conn.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    conn.addEventListener("icegatheringstatechange", check);
  });
}
