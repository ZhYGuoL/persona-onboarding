import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "../src/llm/openai.ts";
import { GuardedMeter, SpendGuard } from "../src/runtime/spend.ts";
import { Store } from "../src/runtime/store.ts";

describe("spend cap", () => {
  it("counts text and voice spend, survives a restart, and stops calls at the cap", () => {
    const store = new Store();
    const guard = new SpendGuard(store, 1);
    const meter = new GuardedMeter(guard, () => 0);
    meter.add({ usd: 0.6, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: 0 } as never);
    guard.addVoiceSeconds(60, 0);
    expect(guard.spentUsd).toBeCloseTo(0.65);
    expect(guard.exhausted).toBe(false);
    expect(() => meter.check()).not.toThrow();

    // A restart reads the total back from the store.
    const again = new SpendGuard(store, 1);
    expect(again.spentUsd).toBeCloseTo(0.65);
    again.addVoiceSeconds(7 * 60, 0);
    expect(again.exhausted).toBe(true);
    expect(() => new GuardedMeter(again, () => 0).check()).toThrow(BudgetExceededError);
  });
});
