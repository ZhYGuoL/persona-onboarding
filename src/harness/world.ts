// A simulated world around one session: fake clock, in-memory store, the real
// hub, and a brain. Tests and the stress harness both drive the brain through it.

import type { Brain } from "../brain/brain.ts";
import type { Action, BrainEvent, Bubble, Capabilities, SessionState } from "../brain/types.ts";
import { FakeClock } from "../runtime/clock.ts";
import { Hub } from "../runtime/hub.ts";
import { Store } from "../runtime/store.ts";

export interface SentTurn {
  turnId: number;
  texts: string[];
  links: string[];
  drafts: Array<Extract<Bubble, { kind: "draft" }>>;
  /** Every bubble in order, for checks on layout. */
  bubbles: Bubble[];
  at: number;
}

export interface WorldOptions {
  brain: Brain;
  caps?: Partial<Capabilities>;
  store?: Store;
  sid?: string;
  start?: number;
}

export class SimWorld {
  readonly clock: FakeClock;
  readonly store: Store;
  readonly brain: Brain;
  readonly hub: Hub;
  readonly sid: string;
  readonly actions: Array<{ action: Action; at: number; state: SessionState }> = [];
  readonly errors: unknown[] = [];

  constructor(opts: WorldOptions) {
    this.clock = new FakeClock(opts.start);
    this.store = opts.store ?? new Store(":memory:");
    this.brain = opts.brain;
    this.hub = new Hub({
      store: this.store,
      clock: this.clock,
      brain: this.brain,
      defaultCaps: { voice: false, gmail: false, tasks: false, ...opts.caps },
      onError: (err) => this.errors.push(err),
    });
    this.sid = opts.sid ?? "s1";
    this.hub.subscribe(this.sid, (msg) => {
      if (msg.type === "action") {
        this.actions.push({
          action: msg.action,
          at: this.hub.now(this.sid),
          state: this.hub.state(this.sid),
        });
      }
    });
  }

  get cfg() {
    return this.brain.cfg;
  }

  get state(): SessionState {
    return this.hub.state(this.sid);
  }

  settle = (): Promise<void> => this.hub.settle();

  async advance(ms: number): Promise<void> {
    await this.clock.advance(ms, this.settle);
  }

  /** Send a text without waiting for the reply. */
  async send(text: string): Promise<void> {
    await this.hub.dispatch(this.sid, { type: "text_in", text });
  }

  async event(ev: BrainEvent): Promise<void> {
    await this.hub.dispatch(this.sid, ev);
    await this.settle();
  }

  turns(): SentTurn[] {
    const out: SentTurn[] = [];
    for (const { action, at } of this.actions) {
      if (action.type !== "send_text") continue;
      out.push({
        turnId: action.turnId,
        texts: action.bubbles
          .filter((b): b is Extract<Bubble, { kind: "text" }> => b.kind === "text")
          .map((b) => b.text),
        links: action.bubbles
          .filter((b): b is Extract<Bubble, { kind: "link" }> => b.kind === "link")
          .map((b) => b.url),
        drafts: action.bubbles.filter(
          (b): b is Extract<Bubble, { kind: "draft" }> => b.kind === "draft",
        ),
        bubbles: action.bubbles,
        at,
      });
    }
    return out;
  }

  last(): SentTurn | null {
    const t = this.turns();
    return t[t.length - 1] ?? null;
  }

  of<T extends Action["type"]>(type: T): Array<Extract<Action, { type: T }>> {
    return this.actions
      .map((a) => a.action)
      .filter((a): a is Extract<Action, { type: T }> => a.type === type);
  }

  /** The kind of question the agent is waiting on. */
  awaiting(): string | null {
    const q = this.state.awaiting?.question;
    if (!q) return null;
    return q.kind === "ask_slot" ? `ask:${q.slot}` : q.kind;
  }
}
