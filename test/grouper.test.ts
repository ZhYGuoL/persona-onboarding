import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/runtime/clock.ts";
import { type Speaker, UtteranceGrouper } from "../src/voice/grouper.ts";

function setup() {
  const clock = new FakeClock(0);
  const finals: Array<{ speaker: Speaker; text: string; startedAt: number }> = [];
  let userStarts = 0;
  const g = new UtteranceGrouper({
    clock,
    onFinal: (speaker, text, startedAt) => finals.push({ speaker, text, startedAt }),
    onUserStart: () => {
      userStarts += 1;
    },
  });
  return { clock, g, finals, starts: () => userStarts };
}

describe("utterance grouper", () => {
  it("joins fragments into one utterance and ends it after quiet", async () => {
    const { clock, g, finals, starts } = setup();
    g.delta("user", "Hi");
    await clock.advance(200);
    g.delta("user", ", my name");
    await clock.advance(200);
    g.delta("user", " is David");
    expect(finals).toHaveLength(0);
    await clock.advance(1000);
    expect(finals).toEqual([{ speaker: "user", text: "Hi, my name is David", startedAt: 0 }]);
    expect(starts()).toBe(1);
  });

  it("ends the user's utterance as soon as the agent answers", async () => {
    const { clock, g, finals } = setup();
    g.delta("user", "I'm Dana");
    await clock.advance(500);
    g.delta("agent", "Nice to meet you");
    expect(finals.map((f) => f.text)).toEqual(["I'm Dana"]);
  });

  it("ignores a backchannel while the user is still talking", async () => {
    const { clock, g, finals } = setup();
    g.delta("user", "So my name is");
    await clock.advance(100);
    g.delta("agent", "mm-hmm");
    await clock.advance(100);
    g.delta("user", " Dana");
    await clock.advance(1000);
    const user = finals.filter((f) => f.speaker === "user").map((f) => f.text);
    expect(user).toEqual(["So my name is Dana"]);
  });

  it("the user speaking ends the agent's utterance", async () => {
    const { clock, g, finals } = setup();
    g.delta("agent", "What's your first name?");
    await clock.advance(400);
    g.delta("user", "Omar");
    expect(finals).toEqual([{ speaker: "agent", text: "What's your first name?", startedAt: 0 }]);
  });

  it("flushes everything on close", () => {
    const { g, finals } = setup();
    g.delta("user", "gotta");
    g.flushAll();
    expect(finals.map((f) => f.text)).toEqual(["gotta"]);
  });
});
