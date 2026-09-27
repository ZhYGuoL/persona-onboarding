import { describe, expect, it } from "vitest";
import { questionCount, World } from "./world.ts";

const name = (value: string, correction = false) => ({ value, correction });

describe("text-only onboarding", () => {
  it("greets with value first, then asks for the agent name", async () => {
    const w = new World();
    const t = await w.say("hey what's a persona");
    expect(t?.texts[0]).toMatch(/new assistant/i);
    expect(t?.links).toEqual(["http://test/legal"]);
    expect(w.awaiting()).toBe("ask:agent_name");
    expect(questionCount(t)).toBe(1);
  });

  it("collects every slot one question at a time and lands in the main experience", async () => {
    const w = new World({ caps: { gmail: true } });
    await w.say("hi");
    const t1 = await w.say("juno", { agent_name: name("juno") });
    expect(t1?.texts.join(" ")).toMatch(/juno it is/i);
    expect(w.awaiting()).toBe("ask:user_name");

    const t2 = await w.say("david", { user_name: name("david") });
    expect(t2?.texts.join(" ")).toMatch(/david/i);
    expect(w.awaiting()).toBe("ask:help_need");

    await w.say("my classes are a mess", { help_need: "scheduling my classes" });
    expect(w.awaiting()).toBe("gmail_link");
    expect(w.last()?.links[0]).toContain("/connect/gmail");

    await w.event({
      type: "oauth_done",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      email: "david@gmail.com",
      name: "David Smith",
    });
    await w.advance(1000);
    expect(w.state.slots.gmail.status).toBe("confirmed");
    expect(w.state.slots.user_name).toMatchObject({ value: "david", status: "confirmed" });
    expect(w.state.phase).toBe("main");
    for (const turn of w.turns()) expect(questionCount(turn)).toBeLessThanOrEqual(1);
    expect(w.errors).toEqual([]);
  });

  it("never re-asks a confirmed slot", async () => {
    const w = new World();
    await w.say("hey i'm david", { user_name: name("david") });
    expect(w.awaiting()).toBe("ask:agent_name");
    await w.say("nova", { agent_name: name("nova") });
    expect(w.awaiting()).toBe("ask:help_need");
    expect(w.state.slots.user_name.attempts).toBe(0);
  });

  it("offers three name ideas only after the user stalls", async () => {
    const w = new World();
    const first = await w.say("hi");
    expect(first?.texts.join(" ")).not.toMatch(/Nova/);
    const second = await w.say("idk");
    expect(second?.texts.join(" ")).toMatch(/Nova, Juno, Milo/);
  });

  it("defers a slot after two unanswered asks and goes by Persona", async () => {
    const w = new World();
    await w.say("hi");
    await w.say("idk");
    const t = await w.say("whatever");
    expect(w.state.slots.agent_name.status).toBe("deferred");
    expect(t?.texts.join(" ")).toMatch(/go by Persona/i);
    expect(w.awaiting()).toBe("ask:user_name");
  });

  it("lets the agent pick its own name", async () => {
    const w = new World();
    await w.say("hi");
    const t = await w.say("you pick", { let_agent_pick_name: true });
    expect(w.state.slots.agent_name).toMatchObject({
      value: "Nova",
      status: "confirmed",
      source: "inferred",
    });
    expect(t?.texts.join(" ")).toMatch(/nova/i);
  });

  it("fills everything from one message and asks only what is left", async () => {
    const w = new World({ caps: { gmail: true } });
    const t = await w.say("i'm david, call yourself juno, i need to cancel my gym membership", {
      user_name: name("david"),
      agent_name: name("juno"),
      task: { summary: "cancel my gym membership", needs_gmail: true },
      help_need: "cancel my gym membership",
    });
    expect(w.state.slots.user_name.value).toBe("david");
    expect(w.state.slots.agent_name.value).toBe("juno");
    expect(w.state.graduated).toBe(true);
    expect(w.awaiting()).toBe("gmail_link");
    expect(questionCount(t)).toBeLessThanOrEqual(1);
  });

  it("applies corrections", async () => {
    const w = new World();
    await w.say("hi i'm david", { user_name: name("david") });
    const t = await w.say("actually call me Z", { user_name: name("Z", true) });
    expect(w.state.slots.user_name.value).toBe("Z");
    expect(t?.texts.join(" ")).toMatch(/Z it is/);
  });

  it("gives one reply to a burst of texts", async () => {
    const w = new World();
    await w.type("hey");
    await w.advance(400);
    await w.type("i'm david", { user_name: name("david") });
    await w.advance(400);
    await w.type("what is this", { confused: true });
    await w.advance(2000);
    expect(w.turns()).toHaveLength(1);
    expect(w.state.slots.user_name.value).toBe("david");
  });

  it("drops a stale turn when the user texts while the model is thinking", async () => {
    const w = new World();
    let open!: () => void;
    w.interp.gate = new Promise((r) => {
      open = r;
    });
    await w.type("hey");
    await w.clock.advance(1300); // debounce fires, turn 1 waits on the model
    await w.type("i'm david", { user_name: name("david") });
    await w.clock.advance(1300); // turn 2 starts and also waits
    w.interp.gate = null;
    open();
    await w.settle();
    await w.advance(2000);
    const turns = w.turns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.texts.join(" ")).toMatch(/david/i);
    expect(w.state.slots.user_name.value).toBe("david");
  });
});
