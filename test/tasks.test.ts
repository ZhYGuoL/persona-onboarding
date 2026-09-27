import { describe, expect, it } from "vitest";
import { GMAIL_SCOPE } from "../src/brain/brain.ts";
import type { Draft, TaskResult } from "../src/brain/types.ts";
import { questionCount, World } from "./world.ts";

const name = (value: string) => ({ value, correction: false });
const SCOPES = ["openid", "email", "profile", GMAIL_SCOPE];
const DAY = 24 * 60 * 60_000;

const NYT_DRAFT: Draft = {
  to: "help@nytimes.com",
  subject: "Please cancel my trial",
  body: "Hi,\n\nPlease cancel my All Access trial before it renews.\n\nThanks,\nDan",
  threadId: "nyt-trial",
};

function draftResult(draft: Draft = NYT_DRAFT): TaskResult {
  return {
    kind: "draft",
    text: "Here's a note to NYT Customer Care that cancels your trial.",
    draft,
    receipt: {
      threadId: "nyt-trial",
      from: "The New York Times",
      subject: "Your free trial ends in 2 days",
      date: Date.UTC(2026, 8, 26, 15),
      quote: "Cancel before Tue, Sep 29 and you won't be charged.",
    },
  };
}

/** Onboard by text, connect the sample inbox, and land on "want me to start on X?". */
async function toFinding(w: World) {
  await w.say("hi");
  await w.say("juno", { agent_name: name("juno") });
  await w.say("dan", { user_name: name("dan") });
  await w.say("i keep forgetting subscriptions", { help_need: "forgotten subscriptions" });
  await w.event({ type: "oauth_done", scopes: SCOPES, email: "sample", name: null, demo: true });
  await w.advance(1000);
  await w.event({
    type: "scan_done",
    findings: [
      {
        fact: "Your New York Times free trial ends Sep 29, then it costs $17 every 4 weeks.",
        next: "canceling the New York Times trial",
        threadId: "nyt-trial",
        related: true,
      },
      {
        fact: "Your Adobe Creative Cloud plan renews Oct 4 for $659.88.",
        next: "canceling the Adobe plan",
        threadId: "adobe-renewal",
        related: true,
      },
    ],
    source: "demo",
    ms: 900,
  });
  await w.advance(1000);
}

/** From the finding, say yes and get a draft back. */
async function toDraft(w: World) {
  await toFinding(w);
  await w.say("yes", { reply_to_pending: "yes" });
  await w.event({
    type: "task_done",
    taskId: 1,
    result: draftResult(),
    threadId: "nyt-trial",
    ms: 900,
  });
  await w.advance(1000);
}

describe("a task from an inbox finding", () => {
  it("offers the finding's next step, starts on yes, and shows a draft that waits for a yes", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toFinding(w);
    expect(w.last()?.texts.join(" ")).toMatch(
      /want me to start on canceling the New York Times trial\?/i,
    );

    const started = await w.say("yes", { reply_to_pending: "yes" });
    expect(started?.texts.join(" ")).toMatch(/on it: canceling the New York Times trial/i);
    // "On it" asks nothing else. The result is the next thing they hear.
    expect(questionCount(started)).toBe(0);
    expect(w.of("run_task").at(-1)).toMatchObject({
      taskId: 1,
      job: { threadId: "nyt-trial", inbox: "demo", userName: "dan" },
    });

    await w.event({
      type: "task_done",
      taskId: 1,
      result: draftResult(),
      threadId: "nyt-trial",
      ms: 900,
    });
    await w.advance(1000);
    const result = w.last();
    const text = result?.texts.join(" ") ?? "";
    expect(text).toMatch(/from The New York Times, Sep 26:/i);
    expect(text).toContain("“Cancel before Tue, Sep 29 and you won't be charged.”");
    // The card sits right above "Send it?".
    expect(result?.bubbles.slice(-2).map((b) => b.kind)).toEqual(["draft", "text"]);
    expect(result?.texts.at(-1)).toMatch(/^send it\?$/i);
    expect(result?.drafts[0]).toMatchObject({ to: "help@nytimes.com" });
    expect(w.awaiting()).toBe("confirm_send");
    expect(w.of("simulated_send")).toHaveLength(0);
  });

  it("a yes marks it sent, says plainly that sending is simulated, and records it", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toDraft(w);
    const sent = await w.say("yes send it", { reply_to_pending: "yes" });
    expect(w.of("simulated_send")).toEqual([
      { type: "simulated_send", taskId: 1, draft: NYT_DRAFT },
    ]);
    expect(w.state.outbox).toHaveLength(1);
    expect(w.state.tasks[0]?.status).toBe("done");
    expect(sent?.texts.join(" ")).toMatch(
      /marked as sent to help@nytimes\.com\. sending is simulated here, so nothing left your account\./i,
    );
  });

  it("an edit re-drafts from the old draft, and a no drops it without sending", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toDraft(w);
    const editing = await w.say("make it shorter", { draft_edit: "make it shorter" });
    expect(editing?.texts.join(" ")).toMatch(/updating the draft/i);
    expect(w.of("run_task").at(-1)?.job).toMatchObject({
      previous: NYT_DRAFT,
      notes: ["Change the draft: make it shorter"],
    });

    const shorter = { ...NYT_DRAFT, body: "Please cancel my trial. Thanks, Dan" };
    await w.event({
      type: "task_done",
      taskId: 1,
      result: draftResult(shorter),
      threadId: "nyt-trial",
      ms: 900,
    });
    await w.advance(1000);
    expect(w.last()?.drafts[0]?.body).toBe("Please cancel my trial. Thanks, Dan");
    expect(w.awaiting()).toBe("confirm_send");

    const dropped = await w.say("nah don't send it", { reply_to_pending: "no" });
    expect(dropped?.texts.join(" ")).toMatch(/okay, i won't send it/i);
    expect(w.of("simulated_send")).toHaveLength(0);
    expect(w.state.outbox).toHaveLength(0);
    expect(w.state.tasks[0]?.status).toBe("dropped");
  });

  it("'yes, but change X' is an edit, never a send", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toDraft(w);
    await w.say("yes but sign it Daniel", {
      reply_to_pending: "yes",
      draft_edit: "sign it Daniel",
    });
    expect(w.of("simulated_send")).toHaveLength(0);
    expect(w.state.tasks[0]?.status).toBe("working");
  });

  it("a yes to some other question never sends a waiting draft", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toDraft(w);
    await w.say("wait what's this for", { confused: true });
    await w.say("yes", { reply_to_pending: "yes" });
    expect(w.of("simulated_send")).toHaveLength(0);
  });
});

describe("offering findings", () => {
  it("after a task wraps up, offers the next finding once, with its fact", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toDraft(w);
    const sent = await w.say("yes send it", { reply_to_pending: "yes" });
    const text = sent?.texts.join(" ") ?? "";
    expect(text).toMatch(
      /your adobe creative cloud plan renews oct 4 for \$659\.88\. want me to start on canceling the adobe plan\?/i,
    );
    // The finished task is not the closing line's topic.
    expect(text).not.toMatch(/dig into/i);
    await w.say("yes", { reply_to_pending: "yes" });
    expect(w.of("run_task").at(-1)).toMatchObject({
      taskId: 2,
      job: { summary: "canceling the Adobe plan", threadId: "adobe-renewal" },
    });
  });

  it("a no ends the offers", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toFinding(w);
    await w.say("no thanks", { reply_to_pending: "no" });
    expect(w.state.inbox.offersStopped).toBe(true);
    const t = await w.say("ok cool");
    expect(t?.texts.join(" ") ?? "").not.toMatch(/want me to start/i);
  });
});

describe("a task stated by text", () => {
  it("waits for Gmail, then runs as the look, with no scan and no quick-look promise", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await w.say("hi");
    await w.say("cancel my gym membership", {
      task: { summary: "canceling the gym membership", needs_gmail: true },
    });
    expect(w.awaiting()).toBe("gmail_link");
    expect(w.of("run_task")).toHaveLength(0);

    await w.event({ type: "oauth_done", scopes: SCOPES, email: "sample", name: null, demo: true });
    await w.advance(1000);
    expect(w.of("scan_inbox")).toHaveLength(0);
    expect(w.of("run_task")).toHaveLength(1);
    const text = w.last()?.texts.join(" ") ?? "";
    expect(text).toMatch(/sample inbox is connected\./i);
    expect(text).not.toMatch(/quick look/i);
    expect(text).toMatch(/on it: canceling the gym membership/i);
  });

  it("runs without the inbox when the user says no to Gmail", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await w.say("hi");
    await w.say("cancel my gym membership", {
      task: { summary: "canceling the gym membership", needs_gmail: true },
    });
    await w.say("no, not connecting email", { refusals: [{ slot: "gmail", hard: true }] });
    expect(w.of("run_task").at(-1)?.job).toMatchObject({ inbox: null });
  });

  it("without the task service, says plainly it cannot do it yet", async () => {
    const w = new World({ caps: { gmail: true, tasks: false } });
    await w.say("hi");
    const t = await w.say("plan my meals", {
      task: { summary: "planning meals for the week", needs_gmail: false },
    });
    expect(t?.texts.join(" ")).toMatch(/can't take care of planning meals/i);
    expect(w.of("run_task")).toHaveLength(0);
  });
});

describe("other task results", () => {
  async function started(w: World) {
    await w.say("hi");
    await w.say("remind me before my con edison bill is due", {
      task: { summary: "a reminder before the Con Edison bill is due", needs_gmail: false },
    });
  }

  it("a reminder is set for real and arrives by text at its time", async () => {
    const w = new World({ caps: { tasks: true } });
    await started(w);
    const at = w.hub.now(w.sid) + 2 * DAY;
    await w.event({
      type: "task_done",
      taskId: 1,
      result: {
        kind: "remind",
        text: "Your Con Edison bill of $86.42 is due tomorrow.",
        at,
        receipt: null,
      },
      threadId: null,
      ms: 700,
    });
    await w.advance(1000);
    expect(w.last()?.texts.join(" ")).toMatch(/done\. i'll text you .+ at .+(AM|PM)\./i);
    expect(w.state.timers["reminder-1"]).toMatchObject({ kind: "reminder", fireAt: at });

    await w.advance(2 * DAY);
    expect(w.last()?.texts.join(" ")).toMatch(
      /reminder: your con edison bill of \$86\.42 is due tomorrow\./i,
    );
    expect(w.state.reminders[0]?.sent).toBe(true);
  });

  it("a question waits for the answer, then runs again with it", async () => {
    const w = new World({ caps: { tasks: true } });
    await started(w);
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "question", text: "What time should I remind you?", receipt: null },
      threadId: null,
      ms: 700,
    });
    await w.advance(1000);
    expect(w.last()?.texts.at(-1)).toMatch(/what time should i remind you\?/i);
    expect(w.awaiting()).toBe("task_info");
    await w.say("9am the day before", { task_detail: "9am the day before" });
    expect(w.of("run_task").at(-1)?.job.notes).toEqual([
      'You asked "What time should I remind you?" They said: 9am the day before',
    ]);
  });

  it("a failure says so plainly, and a lost token asks for Gmail again", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await started(w);
    await w.event({ type: "task_failed", taskId: 1, reason: "error" });
    await w.advance(1000);
    expect(w.last()?.texts.join(" ")).toMatch(/couldn't finish a reminder before the con edison/i);
    expect(w.state.tasks[0]?.status).toBe("failed");

    const w2 = new World({ caps: { gmail: true, tasks: true } });
    await toFinding(w2);
    await w2.say("yes", { reply_to_pending: "yes" });
    await w2.event({ type: "task_failed", taskId: 1, reason: "auth" });
    await w2.advance(1000);
    expect(w2.state.slots.gmail.status).toBe("unknown");
    expect(w2.state.tasks[0]?.status).toBe("waiting_gmail");
    expect(w2.last()?.texts.join(" ")).toMatch(/lost access to your inbox/i);
  });

  it("a result that arrives after the task moved on is ignored", async () => {
    const w = new World({ caps: { tasks: true } });
    await started(w);
    await w.event({ type: "task_failed", taskId: 1, reason: "error" });
    await w.advance(1000);
    const before = w.turns().length;
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "answer", text: "late", receipt: null },
      threadId: null,
      ms: 700,
    });
    await w.advance(1000);
    expect(w.turns()).toHaveLength(before);
  });
});

describe("tasks and calls", () => {
  it("a task asked for on a call runs after the call, by text", async () => {
    const w = new World({ caps: { voice: true, tasks: true } });
    await w.say("hi");
    await w.say("juno", { agent_name: name("juno") });
    await w.say("sure", { reply_to_pending: "yes" });
    await w.event({ type: "call_answered", callId: w.of("ring_phone").at(-1)?.callId ?? "" });
    await w.hear("can you plan my meals this week", {
      task: { summary: "planning meals for the week", needs_gmail: false },
    });
    expect(w.of("run_task")).toHaveLength(0);
    expect(w.pushes("thinking").join(" ")).toMatch(/right after the call/);
    await w.event({ type: "call_ended", callId: w.callId(), reason: "remote_hangup" });
    await w.advance(1000);
    expect(w.of("run_task")).toHaveLength(1);
    expect(w.last()?.texts.join(" ")).toMatch(/on it: planning meals for the week/i);
  });
});
