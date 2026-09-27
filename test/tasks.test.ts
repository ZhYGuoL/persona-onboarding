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
    expect(started?.texts.join(" ")).toMatch(/looking into it\./i);
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

  // Stress run: "that's for my dentist, I meant Planet Fitness" was read as an edit,
  // and four redrafts in a row went back to the dentist.
  it("'wrong email' starts over without that email, keeping the edit", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toDraft(w);
    const reply = await w.say("that's the wrong one, i meant adobe. keep it short", {
      wrong_target: "Adobe",
      draft_edit: "keep it short",
    });
    expect(reply?.texts.join(" ")).toMatch(/sorry, wrong email\. looking into it\./i);
    expect(w.state.tasks.map((t) => t.status)).toEqual(["dropped", "working"]);
    expect(w.of("run_task").at(-1)).toMatchObject({
      taskId: 2,
      job: {
        threadId: null,
        avoid: ["nyt-trial"],
        notes: [
          "The last draft used the wrong email (from The New York Times). They mean: Adobe",
          "Change the draft: keep it short",
        ],
      },
    });
    expect(w.of("simulated_send")).toHaveLength(0);
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
    expect(text).toMatch(/looking into it\./i);
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
    expect(w.last()?.texts.join(" ")).toMatch(/done\. i'll text you .+ at .+(AM|PM): “.+”/i);
    expect(w.state.timers["reminder-1"]).toMatchObject({ kind: "reminder", fireAt: at });

    await w.advance(2 * DAY);
    expect(w.last()?.texts.join(" ")).toMatch(
      /reminder: your con edison bill of \$86\.42 is due tomorrow\./i,
    );
    expect(w.state.reminders[0]?.sent).toBe(true);
  });

  it("a fast-forward past a reminder sends it stamped at its own time", async () => {
    const w = new World({ caps: { tasks: true } });
    await started(w);
    const at = w.hub.now(w.sid) + 2 * DAY;
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "remind", text: "Your bill is due tomorrow.", at, receipt: null },
      threadId: null,
      ms: 700,
    });
    await w.advance(1000);
    await w.hub.fastForward(w.sid, 3 * DAY);
    await w.settle();
    const reminder = w.turns().find((t) => /reminder:/i.test(t.texts.join(" ")));
    expect(reminder).toBeDefined();
    expect((reminder?.at ?? 0) - at).toBeLessThan(5000);
    expect(w.hub.now(w.sid)).toBeGreaterThanOrEqual(at + DAY);
  });

  // Stress run: "text me anytime." was glued onto the end of a receipt's quote.
  it("nothing is glued after a receipt's quote", async () => {
    const { mergeShort } = await import("../src/brain/render.ts");
    const receipt = "From Con Edison, Sep 23: “Due date: Tue, Oct 6”";
    expect(mergeShort([receipt, "Text me anytime."])).toEqual([receipt, "Text me anytime."]);
    // Short lines still merge elsewhere.
    expect(mergeShort(["Juno it is.", "Nice to meet you."])).toEqual([
      "Juno it is. Nice to meet you.",
    ]);
  });

  // Stress run: the same receipt line came back in two turns in a row.
  it("does not repeat a receipt the thread already shows", async () => {
    const w = new World({ caps: { tasks: true } });
    await started(w);
    const receipt = {
      threadId: "adobe-renewal",
      from: "Adobe",
      subject: "Your Creative Cloud plan renews in 7 days",
      date: Date.UTC(2026, 8, 25, 15),
      quote: null,
    };
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "question", text: "Which plan should I ask about?", receipt },
      threadId: "adobe-renewal",
      ms: 700,
    });
    await w.advance(1000);
    const line = /from adobe, sep 25/i;
    expect(w.last()?.texts.some((t) => line.test(t))).toBe(true);
    await w.say("all apps", { task_detail: "all apps" });
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "answer", text: "All Apps renews Oct 4 for $659.88.", receipt },
      threadId: "adobe-renewal",
      ms: 700,
    });
    await w.advance(1000);
    expect(w.last()?.texts.some((t) => line.test(t))).toBe(false);
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
    const answered = await w.say("9am the day before", { task_detail: "9am the day before" });
    expect(w.of("run_task").at(-1)?.job.notes).toEqual([
      'You asked "What time should I remind you?" They said: 9am the day before',
    ]);
    // They just answered. The result is seconds away, so no "looking into it" first.
    expect(answered?.texts.join(" ") ?? "").not.toMatch(/looking into it/i);
  });

  // Stress run: a user who did not know the restaurant yet got the same question four times.
  it("never asks the same question twice, and keeps waiting for the answer", async () => {
    const w = new World({ caps: { tasks: true } });
    await started(w);
    const ask = async (text: string) => {
      await w.event({
        type: "task_done",
        taskId: 1,
        result: { kind: "question", text, receipt: null },
        threadId: null,
        ms: 700,
      });
      await w.advance(1000);
    };
    await ask(
      "What restaurant or venue, date and time, and party size should I include in the reservation request?",
    );
    const sent = w.turns().length;
    await w.say("not sure of the name yet, i'll get back to you", {
      task_detail: "not sure of the name yet",
    });
    const afterReply = w.turns().length;
    await ask("Which restaurant or venue should I address the reservation request to?");
    expect(w.turns()).toHaveLength(afterReply);
    expect(afterReply).toBeGreaterThan(sent);
    expect(w.awaiting()).toBe("task_info");
    await w.say("it's Thai Villa on 5th", { task_detail: "Thai Villa on 5th" });
    expect(w.of("run_task").at(-1)?.job.notes.at(-1)).toMatch(/They said: Thai Villa on 5th$/);
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

describe("an answer's follow-up", () => {
  it("offers one action on an email in the answer, and a yes starts it on that email", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("juno", { agent_name: name("juno") });
    await w.say("find my subscriptions", {
      task: { summary: "finding forgotten subscriptions", needs_gmail: false },
    });
    await w.event({
      type: "task_done",
      taskId: 1,
      result: {
        kind: "answer",
        text: "NYT trial ends Sep 29.\nAdobe renews Oct 4.",
        receipt: null,
        offer: { threadId: "nyt-trial", next: "canceling the New York Times trial" },
      },
      threadId: "nyt-trial",
      ms: 700,
    });
    await w.advance(1000);
    expect(w.last()?.texts.at(-1)).toMatch(
      /want me to start on canceling the new york times trial\?/i,
    );
    await w.say("yes", { reply_to_pending: "yes" });
    expect(w.of("run_task").at(-1)).toMatchObject({
      taskId: 2,
      job: { summary: "canceling the New York Times trial", threadId: "nyt-trial" },
    });
  });

  // Stress run: "sí, ponme un recordatorio antes de que termine el plazo" to a Marriott
  // offer became a new task that searched on its own and quoted the NYT email.
  it("a yes that restates the offer stays on the offered email, with the user's words as a note", async () => {
    const w = new World({ caps: { gmail: true, tasks: true } });
    await toFinding(w);
    await w.say("yes, draft the cancellation and keep it short", {
      reply_to_pending: "yes",
      task: { summary: "drafting a short cancellation", needs_gmail: true },
      extra_tasks: [{ summary: "finding the Adobe renewal price", needs_gmail: true }],
    });
    expect(w.of("run_task").at(-1)).toMatchObject({
      taskId: 1,
      job: {
        summary: "canceling the New York Times trial",
        threadId: "nyt-trial",
        notes: ["When they said yes, they added: drafting a short cancellation"],
      },
    });
    // A second request in the same message is still its own task.
    expect(w.state.tasks.map((t) => t.summary)).toEqual([
      "canceling the New York Times trial",
      "finding the Adobe renewal price",
    ]);
  });
});

describe("an offer that is not about one email", () => {
  it("offers the note it could draft after an empty search, once", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("juno", { agent_name: name("juno") });
    await w.say("when does my car insurance renew", {
      task: { summary: "finding the car insurance renewal", needs_gmail: false },
    });
    await w.event({
      type: "task_done",
      taskId: 1,
      result: {
        kind: "answer",
        text: "I didn't find any car insurance emails.",
        receipt: null,
        offer: { threadId: null, next: "drafting a note to your insurer" },
      },
      threadId: null,
      ms: 700,
    });
    await w.advance(1000);
    expect(w.last()?.texts.at(-1)).toMatch(
      /want me to start on drafting a note to your insurer\?/i,
    );
    await w.say("yes", { reply_to_pending: "yes" });
    expect(w.of("run_task").at(-1)).toMatchObject({
      taskId: 2,
      job: { summary: "drafting a note to your insurer", threadId: null, search: false },
    });
  });

  it("a reminder ends on what happens next, after its receipt", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("remind me about registration", {
      task: { summary: "a reminder about registration", needs_gmail: false },
    });
    await w.event({
      type: "task_done",
      taskId: 1,
      result: {
        kind: "remind",
        text: "Registration opens in an hour.",
        at: w.hub.now(w.sid) + 86_400_000,
        receipt: {
          threadId: "registrar",
          from: "Office of the Registrar",
          subject: "Spring registration opens soon",
          date: Date.UTC(2026, 8, 21, 15),
          quote: null,
        },
      },
      threadId: "registrar",
      ms: 700,
    });
    await w.advance(1000);
    expect(w.last()?.texts.at(-1)).toMatch(/^done\. i'll text you/i);
  });
});

describe("closings and names after tasks", () => {
  // Stress run: "text me whenever you want to dig into adding the concert to your calendar".
  it("once there are tasks, the closing never names the need", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("juno", { agent_name: name("juno") });
    await w.say("add the concert to my calendar", {
      task: { summary: "adding the concert to the calendar", needs_gmail: false },
    });
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "cannot", text: "I can't add it to your calendar.", receipt: null },
      threadId: null,
      ms: 700,
    });
    await w.advance(1000);
    const text = w.last()?.texts.join(" ") ?? "";
    expect(text).toMatch(/can't add it to your calendar/i);
    expect(text).not.toMatch(/dig into/i);
    // A later plain turn keeps the closing general too.
    const later = await w.say("ok");
    expect(later?.texts.join(" ") ?? "").not.toMatch(/dig into/i);
  });

  it("a generic agent name does not read 'I'm assistant, your assistant'", async () => {
    const w = new World();
    await w.say("hi");
    await w.say("just call yourself assistant", {
      agent_name: { value: "assistant", correction: false },
    });
    const t = await w.say("i dont get it", { confused: true });
    expect(t?.texts.join(" ")).not.toMatch(/i'm assistant/i);
  });
});

describe("two requests in one message", () => {
  // Stress run: "draft a reply to adobe, and check my bank stuff too" lost the draft request.
  it("both run, one at a time, and the next waits for the answer to a draft", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("draft adobe a note about downgrades, and check my bank statement too", {
      task: { summary: "drafting a note to Adobe about downgrades", needs_gmail: false },
      extra_tasks: [{ summary: "checking the bank statement", needs_gmail: false }],
    });
    expect(w.state.tasks.map((t) => t.status)).toEqual(["working", "open"]);
    expect(w.of("run_task")).toHaveLength(1);

    await w.event({
      type: "task_done",
      taskId: 1,
      result: draftResult({ ...NYT_DRAFT, to: "support@adobe.com" }),
      threadId: "adobe-renewal",
      ms: 800,
    });
    await w.advance(1000);
    // "Send it?" is waiting, so the second task holds.
    expect(w.awaiting()).toBe("confirm_send");
    expect(w.of("run_task")).toHaveLength(1);

    const t = await w.say("yes", { reply_to_pending: "yes" });
    expect(w.of("simulated_send")).toHaveLength(1);
    expect(w.of("run_task")).toHaveLength(2);
    expect(w.of("run_task").at(-1)?.job.summary).toBe("checking the bank statement");
    expect(t?.texts.join(" ")).toMatch(/marked as sent.*looking into it\./i);
  });
});

describe("taking a request back", () => {
  // Stress run: "remind me at banana o'clock / actually nevermind" still set a reminder,
  // and "I won't remind you" left the timer running.
  it("a request and its take-back in one message never becomes a task", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    const t = await w.say("remind me to eat at 4 / actually nevermind", {
      task: { summary: "a reminder to eat", needs_gmail: false },
      cancels_task: true,
    });
    expect(w.state.tasks).toHaveLength(0);
    expect(w.of("run_task")).toHaveLength(0);
    expect(t?.texts.join(" ")).toMatch(/okay, never mind\./i);
  });

  it("calls off a pending reminder, and it never goes out", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("remind me to call mom tomorrow", {
      task: { summary: "a reminder to call mom", needs_gmail: false },
    });
    const at = w.hub.now(w.sid) + DAY;
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "remind", text: "Call mom.", at, receipt: null },
      threadId: null,
      ms: 500,
    });
    await w.advance(1000);
    // The confirmation quotes the reminder, so check only what comes after the take-back.
    expect(w.last()?.texts.join(" ")).toMatch(/: “Call mom\.”/);
    const t = await w.say("actually don't remind me", { cancels_task: true });
    const before = w.turns().length;
    expect(t?.texts.join(" ")).toMatch(/i won't send that reminder/i);
    expect(w.state.timers["reminder-1"]).toBeUndefined();
    await w.advance(2 * DAY);
    const later = w.turns().slice(before);
    expect(later.some((x) => /call mom/i.test(x.texts.join(" ")))).toBe(false);
  });

  it("drops a task that is still working, and ignores its late result", async () => {
    const w = new World({ caps: { tasks: true } });
    await w.say("hi");
    await w.say("find my flight", { task: { summary: "finding the flight", needs_gmail: false } });
    await w.say("never mind", { cancels_task: true });
    expect(w.state.tasks[0]?.status).toBe("dropped");
    const before = w.turns().length;
    await w.event({
      type: "task_done",
      taskId: 1,
      result: { kind: "answer", text: "Your flight is Oct 4.", receipt: null },
      threadId: null,
      ms: 500,
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
    expect(w.last()?.texts.join(" ")).toMatch(/looking into it\./i);
  });
});

describe("the same question", () => {
  it("matches a repeat, not a new question on the same topic", async () => {
    const { sameQuestion } = await import("../src/brain/tasks.ts");
    const cases: Array<[string, string, boolean]> = [
      [
        "What restaurant or venue, date and time, and party size should I include in the reservation request?",
        "Which restaurant or venue should I address the reservation request to?",
        true,
      ],
      [
        "¿A quién se lo envío? Necesito su correo electrónico.",
        "¿A quién se lo mando? Necesito su correo electrónico.",
        true,
      ],
      ["Are you staying or moving out?", "What date are you moving out?", false],
      ["Which account is the renewal for?", "Which email should I send it to?", false],
    ];
    for (const [a, b, same] of cases) expect(sameQuestion(a, b)).toBe(same);
  });
});
