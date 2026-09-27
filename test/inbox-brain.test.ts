// Milestone 3: Gmail connect, the inbox scan, and the finding in the live call.

import { describe, expect, it } from "vitest";
import { GMAIL_SCOPE } from "../src/brain/brain.ts";
import { World } from "./world.ts";

const name = (value: string, correction = false) => ({ value, correction });
const SCOPES = ["openid", "email", "profile", GMAIL_SCOPE];
const PF = "Your Planet Fitness membership renews Oct 3 for $24.99.";

async function onCallWithNeed(w: World) {
  await w.say("hi");
  await w.say("juno", { agent_name: name("juno") });
  await w.say("sure", { reply_to_pending: "yes" });
  await w.event({ type: "call_answered", callId: w.of("ring_phone").at(-1)?.callId ?? "" });
  await w.hear("I'm Dana, D-A-N-A", { user_name: name("Dana"), confirms_name: "Dana" });
  await w.hear("I keep paying for a gym I never go to", {
    help_need: "canceling the gym membership",
  });
  return w.callId();
}

describe("the magic moment on a call", () => {
  it("texts the link, waits for the connect, shares one finding, then wraps up", async () => {
    const w = new World({ caps: { voice: true, gmail: true } });
    const callId = await onCallWithNeed(w);
    expect(w.last()?.links[0]).toContain("/connect/gmail");
    expect(w.pushes("commentary").at(-1)).toMatch(/texted them a link to connect Gmail/);
    // The user chats while they connect. The call does not wrap up yet.
    await w.hear("ok hang on, opening it", {});
    expect(w.state.call.wrapUpAt).toBeNull();

    await w.event({
      type: "oauth_done",
      scopes: SCOPES,
      email: "dana@gmail.com",
      name: "Dana Lee",
    });
    expect(w.state.slots.gmail).toMatchObject({ status: "confirmed", value: "dana@gmail.com" });
    expect(w.of("scan_inbox").at(-1)?.need).toBe("canceling the gym membership");
    expect(w.pushes("commentary").at(-1)).toMatch(/taking a quick look/);

    await w.event({
      type: "scan_done",
      findings: [{ fact: PF, related: true }],
      source: "gmail",
      ms: 1800,
    });
    expect(w.pushes("commentary").at(-1)).toContain(PF);
    expect(w.state.call.wrapUpAt).toBeNull();

    // A line still queued from before the finding is not the finding.
    await w.agentSays("Thanks, I just texted you a link to connect your Gmail.", 0);
    expect(w.state.call.wrapUpAt).toBeNull();
    await w.agentSays("Found it: your Planet Fitness renews October 3rd for $24.99.", 0);
    expect(w.pushes("instructions").at(-1)).toMatch(/say goodbye/i);
    await w.agentSays("I'll text you a recap. Bye!", 0);
    expect(w.of("end_call").at(-1)?.callId).toBe(callId);

    await w.event({ type: "call_ended", callId, reason: "close_requested" });
    await w.advance(1000);
    const recap = w.last()?.texts.join(" ") ?? "";
    expect(recap).toMatch(/gmail is connected/i);
    expect(recap).toContain(PF);
  });

  it("a finding said in the same breath as 'taking a look' counts as delivered", async () => {
    const w = new World({ caps: { voice: true, gmail: true } });
    await onCallWithNeed(w);
    await w.event({ type: "oauth_done", scopes: SCOPES, email: "dana@gmail.com", name: null });
    await w.event({
      type: "scan_done",
      findings: [{ fact: PF, related: true }],
      source: "gmail",
      ms: 1800,
    });
    await w.agentSays(
      "I'm in, taking a look. Your Planet Fitness renews October 3rd for twenty-five dollars.",
      4000,
    );
    expect(w.pushes("instructions").at(-1)).toMatch(/say goodbye/i);
  });

  it("if the agent never says the finding, the call still wraps up and the text has it", async () => {
    const w = new World({ caps: { voice: true, gmail: true } });
    await onCallWithNeed(w);
    await w.event({ type: "oauth_done", scopes: SCOPES, email: "dana@gmail.com", name: null });
    await w.event({
      type: "scan_done",
      findings: [{ fact: PF, related: true }],
      source: "gmail",
      ms: 1800,
    });
    await w.agentSays("Give me one second.", 0);
    expect(w.state.call.wrapUpAt).toBeNull();
    await w.advance(w.cfg.callFindingWaitMs + 100);
    expect(w.pushes("instructions").at(-1)).toMatch(/say goodbye/i);
  });

  it("if they never connect, the call wraps up with the link left in their texts", async () => {
    const w = new World({ caps: { voice: true, gmail: true } });
    await onCallWithNeed(w);
    await w.advance(w.cfg.callGmailWaitMs + 100);
    expect(w.pushes("instructions").at(-1)).toMatch(/link is in their texts/);
  });

  it("an unchecked Gmail box is said plainly on the call, and no scan runs", async () => {
    const w = new World({ caps: { voice: true, gmail: true } });
    await onCallWithNeed(w);
    await w.event({
      type: "oauth_done",
      scopes: ["openid", "email"],
      email: "dana@gmail.com",
      name: null,
    });
    expect(w.pushes("commentary").at(-1)).toMatch(/Gmail box was unchecked/);
    expect(w.of("scan_inbox")).toHaveLength(0);
  });

  it("a scan with nothing useful is said gracefully", async () => {
    const w = new World({ caps: { voice: true, gmail: true } });
    await onCallWithNeed(w);
    await w.event({ type: "oauth_done", scopes: SCOPES, email: "dana@gmail.com", name: null });
    await w.event({ type: "scan_done", findings: [], source: "gmail", ms: 900 });
    expect(w.pushes("commentary").at(-1)).toMatch(/nothing urgent/);
  });
});

describe("inbox by text", () => {
  async function toGmailAsk(w: World) {
    await w.say("hi");
    await w.say("juno", { agent_name: name("juno") });
    await w.say("dana", { user_name: name("dana") });
    await w.say("bills", { help_need: "keeping up with bills" });
    expect(w.awaiting()).toBe("gmail_link");
  }

  it("says it is taking a look, then shares the finding and offers to start there", async () => {
    const w = new World({ caps: { gmail: true } });
    await toGmailAsk(w);
    await w.event({ type: "oauth_done", scopes: SCOPES, email: "dana@gmail.com", name: "Dana" });
    await w.advance(1000);
    const connected = w.last();
    expect(connected?.texts.join(" ")).toMatch(/taking a quick look/i);
    expect(connected?.texts.join(" ")).not.toMatch(/\?/);
    await w.event({
      type: "scan_done",
      findings: [{ fact: "Your Con Edison bill of $86.42 is due Oct 6.", related: true }],
      source: "gmail",
      ms: 1500,
    });
    await w.advance(1000);
    const found = w.last()?.texts.join(" ") ?? "";
    expect(found).toContain("Your Con Edison bill of $86.42 is due Oct 6.");
    expect(found).toMatch(/start there\?/i);
  });

  it("the sample inbox is labeled as such, never passed off as their email", async () => {
    const w = new World({ caps: { gmail: true } });
    await toGmailAsk(w);
    await w.event({ type: "oauth_done", scopes: SCOPES, email: "sample", name: null, demo: true });
    await w.advance(1000);
    expect(w.state.slots.gmail).toMatchObject({ value: "sample inbox", source: "sample_inbox" });
    expect(w.last()?.texts.join(" ")).toMatch(/sample inbox/i);
  });

  it("a lost token asks for a fresh connect", async () => {
    const w = new World({ caps: { gmail: true } });
    await toGmailAsk(w);
    await w.event({ type: "oauth_done", scopes: SCOPES, email: "dana@gmail.com", name: null });
    await w.event({ type: "scan_failed", reason: "auth" });
    await w.advance(1000);
    expect(w.state.slots.gmail.status).toBe("unknown");
    expect(
      w
        .turns()
        .flatMap((t) => t.texts)
        .join(" "),
    ).toMatch(/lost access to your inbox/);
  });
});
