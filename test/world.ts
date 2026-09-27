// The test world: the shared SimWorld with a scripted interpreter and the
// template renderer, so tests are fast and deterministic.

import { Brain } from "../src/brain/brain.ts";
import { type BrainConfig, DEFAULT_CONFIG } from "../src/brain/config.ts";
import {
  blankInterpretation,
  type Interpreter,
  type InterpretInput,
} from "../src/brain/interpret.ts";
import { TemplateRenderer } from "../src/brain/render.ts";
import type { Capabilities, Interpretation } from "../src/brain/types.ts";
import { type SentTurn, SimWorld } from "../src/harness/world.ts";
import type { Store } from "../src/runtime/store.ts";

export type { SentTurn };
export type Reading = Partial<Interpretation>;

/** Maps exact user texts to interpretations. Unknown texts read as blank. */
export class ScriptedInterpreter implements Interpreter {
  readonly readings = new Map<string, Reading>();
  calls = 0;
  gate: Promise<void> | null = null;

  async interpret({ texts, state }: InterpretInput): Promise<Interpretation> {
    this.calls += 1;
    if (this.gate) await this.gate;
    const out = blankInterpretation(state.language);
    for (const t of texts) Object.assign(out, this.readings.get(t.text) ?? {});
    return out;
  }
}

export class World extends SimWorld {
  readonly interp: ScriptedInterpreter;

  constructor(
    opts: {
      caps?: Partial<Capabilities>;
      cfg?: Partial<BrainConfig>;
      store?: Store;
      sid?: string;
      start?: number;
    } = {},
  ) {
    const cfg = { ...DEFAULT_CONFIG, ...opts.cfg };
    const interp = new ScriptedInterpreter();
    const brain = new Brain({
      cfg,
      interpreter: interp,
      renderer: null,
      template: new TemplateRenderer(cfg.nameIdeas),
      links: (id) => ({ legal: "http://test/legal", gmail: `http://test/connect/gmail?s=${id}` }),
    });
    super({ brain, caps: opts.caps, store: opts.store, sid: opts.sid, start: opts.start });
    this.interp = interp;
  }

  /** Send one user text with its reading, then let the debounce fire. */
  async say(
    text: string,
    reading: Reading = {},
    wait = this.cfg.replyDebounceMs + 10,
  ): Promise<SentTurn | null> {
    const before = this.turns().length;
    this.interp.readings.set(text, reading);
    await this.send(text);
    await this.advance(wait);
    const turns = this.turns();
    return turns.length > before ? (turns[turns.length - 1] ?? null) : null;
  }

  /** Send a text without waiting for the reply. */
  async type(text: string, reading: Reading = {}): Promise<void> {
    this.interp.readings.set(text, reading);
    await this.send(text);
  }

  /** The user says something on the live call. */
  async hear(text: string, reading: Reading = {}): Promise<void> {
    this.interp.readings.set(text, reading);
    await this.event({ type: "transcript_final", callId: this.callId(), role: "user", text });
  }

  /** The agent says something on the live call. */
  async agentSays(text: string, startedAgoMs = 1000): Promise<void> {
    await this.event({
      type: "transcript_final",
      callId: this.callId(),
      role: "agent",
      text,
      startedAgoMs,
    });
  }

  callId(): string {
    return this.state.call.callId ?? "";
  }

  pushes(kind?: "thinking" | "commentary" | "instructions"): string[] {
    return this.of("push_to_call")
      .filter((p) => !kind || p.kind === kind)
      .map((p) => p.text);
  }
}

export function questionCount(turn: SentTurn | null): number {
  if (!turn) return 0;
  return turn.texts.join(" ").match(/[?？]/g)?.length ?? 0;
}
