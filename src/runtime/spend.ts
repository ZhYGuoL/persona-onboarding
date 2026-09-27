// A spend cap for a public deploy. Every model call and every call minute is
// recorded in SQLite, so a restart does not reset the count. Past the cap, voice
// is off and text calls fail fast, so the brain uses its keyword reader and
// templates. The app keeps working, just plainer.

import { BudgetExceededError, CostMeter, type Usage } from "../llm/openai.ts";
import type { Store } from "./store.ts";

/** GPT-Live, billed per second. */
export const VOICE_USD_PER_MINUTE = 0.05;

export class SpendGuard {
  private readonly store: Store;
  readonly capUsd: number;
  private total: number;

  constructor(store: Store, capUsd: number) {
    this.store = store;
    this.capUsd = capUsd;
    this.total = store.spentUsd();
  }

  add(kind: "text" | "voice", usd: number, at: number): void {
    if (!(usd > 0)) return;
    this.store.addSpend(kind, usd, at);
    this.total += usd;
  }

  addVoiceSeconds(seconds: number, at: number): void {
    this.add("voice", (seconds / 60) * VOICE_USD_PER_MINUTE, at);
  }

  get spentUsd(): number {
    return this.total;
  }

  get exhausted(): boolean {
    return this.total >= this.capUsd;
  }
}

/** A cost meter that records into the guard and refuses calls past the cap. */
export class GuardedMeter extends CostMeter {
  private readonly guard: SpendGuard;
  private readonly now: () => number;

  constructor(guard: SpendGuard, now: () => number) {
    super(guard.capUsd);
    this.guard = guard;
    this.now = now;
  }

  override add(u: Usage): void {
    super.add(u);
    this.guard.add("text", u.usd, this.now());
  }

  override check(): void {
    if (this.guard.exhausted) {
      throw new BudgetExceededError(`spend cap of $${this.guard.capUsd.toFixed(2)} reached`);
    }
  }
}
