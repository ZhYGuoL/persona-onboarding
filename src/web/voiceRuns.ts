// Scripted voice runs: real GPT-Live calls with prerecorded clips, driven
// from the page so anyone can rerun them from the reviewer panel. Each run
// starts a fresh session, marks its start and end in the event log, and the
// voice report grades it from that log.

import { useCallback, useRef, useState } from "react";
import type { ClientMessage } from "../shared/protocol.ts";
import type { CallControls } from "./useCall.ts";

const CLIP = {
  name: "/voice/name.m4a",
  need: "/voice/need.m4a",
  bot: "/voice/bot.m4a",
  bye: "/voice/bye.m4a",
  spanish: "/voice/spanish.m4a",
  spell: "/voice/spell.m4a",
  interrupt: "/voice/interrupt.m4a",
  later: "/voice/later.m4a",
} as const;

export interface VoiceRunDeps {
  reset(): Promise<void>;
  sendText(text: string): void;
  sendRaw(msg: ClientMessage): void;
  dropCall(): Promise<void>;
  /** The latest call controls. */
  call(): CallControls;
  /** Messages in the thread so far, for waiting on a reply. */
  agentTexts(): number;
  connected(): boolean;
  sessionId(): string | null;
}

class Stopped extends Error {}

/** Quiet time, on top of the meter's own 450 ms, that ends the agent's reply. */
const REPLY_END_QUIET_MS = 1000;

/** One scripted run. Throws with the step that timed out. */
interface Script {
  id: string;
  label: string;
  run(x: Driver): Promise<void>;
}

class Driver {
  private readonly deps: VoiceRunDeps;
  private readonly isStopped: () => boolean;
  step = "";

  constructor(deps: VoiceRunDeps, isStopped: () => boolean) {
    this.deps = deps;
    this.isStopped = isStopped;
  }

  private async until(what: string, check: () => boolean, timeoutMs: number): Promise<void> {
    this.step = what;
    const end = performance.now() + timeoutMs;
    while (!check()) {
      if (this.isStopped()) throw new Stopped("stopped");
      if (performance.now() > end) throw new Error(`timed out: ${what}`);
      await sleep(100);
    }
  }

  async pause(ms: number): Promise<void> {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (this.isStopped()) throw new Stopped("stopped");
      await sleep(100);
    }
  }

  /** Fresh session, agent named by text, then the caller dials the agent. */
  async setup(scenario: string): Promise<void> {
    const before = this.deps.sessionId();
    await this.deps.reset();
    await this.until(
      "new session",
      () => this.deps.connected() && this.deps.sessionId() !== before,
      15_000,
    );
    this.deps.sendRaw({ t: "voice_run", scenario, status: "start" });
    this.deps.call().setTestVoice(true);
    const texts = this.deps.agentTexts();
    this.deps.sendText("call yourself juno");
    await this.until("the agent's reply by text", () => this.deps.agentTexts() > texts, 30_000);
    this.deps.call().startCall("juno");
    await this.until("the call connects", () => this.deps.call().call.phase === "active", 30_000);
  }

  /**
   * Wait for the agent to start talking, then to finish. A reply ends after 1 s
   * of quiet: the agent often pauses 800 ms between two sentences of one reply.
   */
  async reply(what = "the agent's reply"): Promise<void> {
    await this.until(`${what} starts`, () => this.deps.call().agentSpeaking(), 20_000);
    let quietSince: number | null = null;
    await this.until(
      `${what} ends`,
      () => {
        if (this.deps.call().agentSpeaking()) {
          quietSince = null;
          return false;
        }
        quietSince ??= performance.now();
        return performance.now() - quietSince >= REPLY_END_QUIET_MS;
      },
      30_000,
    );
  }

  async say(clip: keyof typeof CLIP): Promise<void> {
    this.step = `say ${clip}`;
    await this.deps.call().sayClip(CLIP[clip]);
  }

  /**
   * Talk over the agent once it has spoken for `afterMs` without a break, so a
   * short "mm" is not taken for the reply.
   */
  async interrupt(clip: keyof typeof CLIP, afterMs: number): Promise<void> {
    let since: number | null = null;
    await this.until(
      "the agent is mid-reply",
      () => {
        if (!this.deps.call().agentSpeaking()) {
          since = null;
          return false;
        }
        since ??= performance.now();
        return performance.now() - since >= afterMs;
      },
      20_000,
    );
    await this.say(clip);
  }

  async callEnds(timeoutMs: number): Promise<void> {
    await this.until(
      "the call ends",
      () => {
        const p = this.deps.call().call.phase;
        return p === "ended" || p === "idle";
      },
      timeoutMs,
    );
  }

  async textArrives(timeoutMs: number): Promise<void> {
    const texts = this.deps.agentTexts();
    await this.until("a text after the call", () => this.deps.agentTexts() > texts, timeoutMs);
  }

  async drop(): Promise<void> {
    this.step = "drop the call";
    await this.deps.dropCall();
  }
}

export const VOICE_SCRIPTS: Script[] = [
  {
    id: "happy",
    label: "Happy path",
    async run(x) {
      await x.reply("greeting");
      await x.say("name");
      await x.reply();
      await x.say("need");
      await x.reply();
      await x.say("later");
      await x.callEnds(45_000);
    },
  },
  {
    id: "spelled_name",
    label: "Spelled name",
    async run(x) {
      await x.reply("greeting");
      await x.say("spell");
      await x.reply();
      await x.say("bye");
      await x.callEnds(30_000);
    },
  },
  {
    id: "interrupt",
    label: "Interruption",
    async run(x) {
      await x.reply("greeting");
      await x.say("name");
      await x.interrupt("interrupt", 1200);
      await x.reply();
      await x.say("bye");
      await x.callEnds(30_000);
    },
  },
  {
    id: "interrupt_greeting",
    label: "Talks over the greeting",
    async run(x) {
      await x.interrupt("interrupt", 1500);
      await x.reply();
      await x.say("bye");
      await x.callEnds(30_000);
    },
  },
  {
    id: "silence",
    label: "Silence",
    async run(x) {
      await x.reply("greeting");
      await x.callEnds(60_000);
    },
  },
  {
    id: "spanish",
    label: "Spanish",
    async run(x) {
      await x.reply("greeting");
      await x.say("spanish");
      await x.reply();
      await x.say("bye");
      await x.callEnds(30_000);
    },
  },
  {
    id: "bot",
    label: "Are you a bot?",
    async run(x) {
      await x.reply("greeting");
      await x.say("bot");
      await x.reply();
      await x.say("bye");
      await x.callEnds(30_000);
    },
  },
  {
    id: "gotta_go",
    label: "Gotta go",
    async run(x) {
      await x.reply("greeting");
      await x.say("bye");
      await x.callEnds(30_000);
    },
  },
  {
    id: "drop",
    label: "Dropped line",
    async run(x) {
      await x.reply("greeting");
      await x.say("name");
      await x.reply();
      await x.drop();
      await x.textArrives(10_000);
    },
  },
];

export interface VoiceRunState {
  running: string | null;
  step: string;
  results: Array<{ id: string; ok: boolean; detail: string }>;
}

export function useVoiceRuns(deps: VoiceRunDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const stopped = useRef(false);
  const [state, setState] = useState<VoiceRunState>({ running: null, step: "", results: [] });

  const runOne = useCallback(async (script: Script) => {
    const x = new Driver(
      {
        reset: () => depsRef.current.reset(),
        sendText: (t) => depsRef.current.sendText(t),
        sendRaw: (m) => depsRef.current.sendRaw(m),
        dropCall: () => depsRef.current.dropCall(),
        call: () => depsRef.current.call(),
        agentTexts: () => depsRef.current.agentTexts(),
        connected: () => depsRef.current.connected(),
        sessionId: () => depsRef.current.sessionId(),
      },
      () => stopped.current,
    );
    const ticker = setInterval(() => setState((s) => ({ ...s, step: x.step })), 250);
    setState((s) => ({ ...s, running: script.id, step: "" }));
    let ok = true;
    let detail = "";
    try {
      await x.setup(script.id);
      await script.run(x);
      // Give the recap text a moment to land in the log.
      await x.pause(4000);
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? err.message : String(err);
      const call = depsRef.current.call();
      if (call.call.phase === "active" || call.call.phase === "connecting") call.hangUp();
    } finally {
      clearInterval(ticker);
    }
    depsRef.current.sendRaw({
      t: "voice_run",
      scenario: script.id,
      status: "end",
      ...(detail ? { detail } : {}),
    });
    setState((s) => ({
      running: null,
      step: "",
      results: [...s.results, { id: script.id, ok, detail }],
    }));
    return ok;
  }, []);

  const run = useCallback(
    async (ids: string[]) => {
      stopped.current = false;
      setState({ running: null, step: "", results: [] });
      for (const id of ids) {
        const script = VOICE_SCRIPTS.find((s) => s.id === id);
        if (!script || stopped.current) continue;
        await runOne(script);
        await sleep(1500);
      }
    },
    [runOne],
  );

  const stop = useCallback(() => {
    stopped.current = true;
  }, []);

  return { state, run, stop };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
