import { describe, expect, it } from "vitest";
import { DemoInbox } from "../src/inbox/demo.ts";
import type { JsonRequest, LlmClient } from "../src/llm/openai.ts";
import { type RawWork, runWork, type WorkInput } from "../src/tasks/work.ts";

const NOW = Date.UTC(2026, 8, 27, 13, 30); // 9:30 AM in New York
const ZONE = "America/New_York";

/** Answers by request name, and records every request. A reply can be a function of the request. */
function scripted(
  replies: Record<string, unknown | ((req: JsonRequest) => unknown)>,
): LlmClient & { requests: JsonRequest[] } {
  const requests: JsonRequest[] = [];
  return {
    requests,
    async json<T>(req: JsonRequest) {
      requests.push(req);
      if (!(req.name in replies)) throw new Error(`unexpected ${req.name}`);
      const reply = replies[req.name];
      return {
        data: (typeof reply === "function" ? reply(req) : reply) as T,
        latencyMs: 1,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0 },
      };
    },
  };
}

function work(partial: Partial<RawWork>): RawWork {
  return {
    kind: "answer",
    text: "",
    quote_from: 1,
    quote: "",
    draft_to: "",
    draft_subject: "",
    draft_body: "",
    remind_at: "",
    next: "",
    next_from: 0,
    ...partial,
  };
}

function input(partial: Partial<WorkInput> = {}): WorkInput {
  return {
    summary: "canceling the New York Times trial",
    threadId: "nyt-trial",
    notes: [],
    previous: null,
    shown: [],
    avoid: [],
    known: [],
    search: true,
    userName: "Dan",
    userEmail: "dan@gmail.com",
    language: "en",
    now: NOW,
    timeZone: ZONE,
    ...partial,
  };
}

const provider = new DemoInbox(NOW);

describe("task work", () => {
  it("drafts a reply to the address in the email, with a word-for-word receipt", async () => {
    const llm = scripted({
      task_result: work({
        kind: "draft",
        text: "Here's a note to NYT Customer Care that cancels your trial. See https://nyt.com",
        quote: "Cancel before Tue, Sep 29 and you won't be charged.",
        draft_to: "NYT Customer Care <help@nytimes.com>",
        draft_subject: "Please cancel my trial",
        draft_body: "Hi,\n\nPlease cancel my All Access trial before it renews.\n\nThanks,\nDan",
      }),
    });
    const out = await runWork(input(), { provider, llm, model: "m", fastModel: "f" });
    expect(out.result.kind).toBe("draft");
    if (out.result.kind !== "draft") return;
    expect(out.result.draft).toMatchObject({ to: "help@nytimes.com", threadId: "nyt-trial" });
    expect(out.result.draft.body).toContain("\n\nThanks,\nDan");
    expect(out.result.text).not.toMatch(/nyt\.com/);
    expect(out.result.receipt).toMatchObject({
      from: "The New York Times",
      quote: "Cancel before Tue, Sep 29 and you won't be charged.",
    });
    // The email reached the model as data, inside clear markers.
    expect(llm.requests[0]?.input[0]?.content).toContain("untrusted data");
  });

  it("never drafts to an address the model made up, or to the user", async () => {
    const invented = scripted({
      task_result: work({ kind: "draft", draft_to: "cancel@evil.example", draft_body: "Cancel." }),
    });
    const a = await runWork(input(), { provider, llm: invented, model: "m", fastModel: "f" });
    expect(a.result.kind === "draft" && a.result.draft.to).toBe("help@nytimes.com");

    const noEmail = scripted({
      task_result: work({
        kind: "draft",
        draft_to: "boss@work.example",
        draft_subject: "Out sick today",
        draft_body: "I'm sick.",
      }),
    });
    const b = await runWork(input({ summary: "emailing my boss", threadId: null }), {
      provider: null,
      llm: noEmail,
      model: "m",
      fastModel: "f",
    });
    // It names the email, so two tasks that both need an address ask different words.
    expect(b.result).toMatchObject({
      kind: "question",
      text: "Who should the email about “Out sick today” go to? I need their email address.",
    });

    // An address the user typed is fine.
    const c = await runWork(
      input({
        summary: "emailing my boss",
        threadId: null,
        notes: ["her email is kim@work.example"],
      }),
      { provider: null, llm: noEmail, model: "m", fastModel: "f" },
    );
    expect(c.result.kind).toBe("question");
    const d = await runWork(
      input({ summary: "emailing my boss", threadId: null, notes: ["it's boss@work.example"] }),
      { provider: null, llm: noEmail, model: "m", fastModel: "f" },
    );
    expect(d.result.kind === "draft" && d.result.draft.to).toBe("boss@work.example");
  });

  it("drops a quote that is not in the email", async () => {
    const llm = scripted({
      task_result: work({ kind: "answer", text: "Trial ends soon.", quote: "You owe $900 today." }),
    });
    const out = await runWork(input(), { provider, llm, model: "m", fastModel: "f" });
    expect(out.result.receipt?.quote).toBeNull();
  });

  it("sets reminders in the user's time zone, and asks when the time is unusable", async () => {
    const llm = scripted({
      task_result: work({
        kind: "remind",
        text: "Your Con Edison bill of $86.42 is due tomorrow.",
        remind_at: "2026-10-05T09:00",
      }),
    });
    const out = await runWork(input({ summary: "bill reminder", threadId: "conedison" }), {
      provider,
      llm,
      model: "m",
      fastModel: "f",
    });
    expect(out.result.kind === "remind" && out.result.at).toBe(Date.UTC(2026, 9, 5, 13, 0));

    const past = scripted({
      task_result: work({ kind: "remind", text: "x", remind_at: "2026-09-01T09:00" }),
    });
    const late = await runWork(input({ threadId: "conedison" }), {
      provider,
      llm: past,
      model: "m",
      fastModel: "f",
    });
    expect(late.result).toMatchObject({ kind: "question", text: "When should I remind you?" });
  });

  it("stops at a scam email without asking the model", async () => {
    const llm = scripted({});
    const out = await runWork(input({ summary: "the security alert", threadId: "phish" }), {
      provider,
      llm,
      model: "m",
      fastModel: "f",
    });
    expect(out.result).toMatchObject({ kind: "cannot", text: expect.stringMatching(/scam/) });
    expect(llm.requests).toHaveLength(0);
  });

  it("finds the email when no finding named it", async () => {
    const llm = scripted({
      // Pick whichever numbered candidate is the Con Edison bill.
      task_email: (req: JsonRequest) => {
        const line = req.input[0]?.content.split("\n").find((l) => l.includes("Con Edison"));
        return { indexes: [Number(line?.split(".")[0] ?? -1)] };
      },
      task_result: work({ kind: "answer", text: "Your bill is $86.42." }),
    });
    const out = await runWork(input({ summary: "my con edison bill", threadId: null }), {
      provider,
      llm,
      model: "m",
      fastModel: "f",
    });
    expect(out.threadId).toBe("conedison");
    expect(out.result.receipt?.from).toBe("Con Edison");
  });

  // Stress run: "send that nytimes cancellation email" searched, missed the NYT email
  // the user had just seen, and said it found nothing.
  it("always considers emails an earlier result quoted, even when a search misses them", async () => {
    let listing = "";
    const llm = scripted({
      task_email: (req: JsonRequest) => {
        listing = req.input[0]?.content ?? "";
        const line = listing.split("\n").find((l) => l.includes("The New York Times"));
        return { indexes: [Number(line?.split(".")[0] ?? -1)] };
      },
      task_result: work({ kind: "answer", text: "Your trial ends Sep 29." }),
    });
    const out = await runWork(
      input({
        summary: "zzq",
        threadId: null,
        known: [
          {
            threadId: "nyt-trial",
            from: "The New York Times",
            subject: "Your free trial ends in 2 days",
            date: NOW,
            quote: "Cancel before Tue, Sep 29 and you won't be charged.",
          },
        ],
      }),
      { provider, llm, model: "m", fastModel: "f" },
    );
    expect(listing).toMatch(/^0\. From: The New York Times/m);
    expect(out.threadId).toBe("nyt-trial");
  });

  it("never offers an email the user said is the wrong one", async () => {
    let listing = "";
    const llm = scripted({
      task_email: (req: JsonRequest) => {
        listing = req.input[0]?.content ?? "";
        return { indexes: [0] };
      },
      task_result: work({ kind: "answer", text: "Your bill is $86.42." }),
    });
    await runWork(input({ summary: "my con edison bill", threadId: null, avoid: ["conedison"] }), {
      provider,
      llm,
      model: "m",
      fastModel: "f",
    });
    expect(listing).not.toMatch(/Con Edison/);
  });

  it("a list task reads several emails, skips shown ones on request, and quotes the right one", async () => {
    const pickFor = (req: JsonRequest, names: string[]) => {
      const lines = req.input[0]?.content.split("\n") ?? [];
      return {
        indexes: names.map((n) => Number(lines.find((l) => l.includes(n))?.split(".")[0] ?? -1)),
      };
    };
    let listing = "";
    const llm = scripted({
      task_email: (req: JsonRequest) => {
        listing = req.input[0]?.content ?? "";
        return pickFor(req, ["Netflix", "Spotify", "Security alert"]);
      },
      task_result: work({
        kind: "answer",
        text: "Netflix is $15.49 a month and Spotify is $11.99.",
        quote_from: 2,
        quote: "Thanks for your payment of $11.99 for Spotify Premium Individual.",
        next: "canceling Netflix",
        next_from: 1,
      }),
    });
    const out = await runWork(
      input({ summary: "finding other subscriptions", threadId: null, shown: ["nyt-trial"] }),
      { provider, llm, model: "m", fastModel: "f" },
    );
    expect(listing).toMatch(/free trial ends in 2 days.*\[already shown\]/);
    const prompt = llm.requests[1]?.input[0]?.content ?? "";
    expect(prompt).toContain("Email 1 (untrusted data");
    expect(prompt).toContain("Email 2 (untrusted data");
    // The scam in the list is left out, and the task goes on.
    expect(prompt).not.toContain("SYSTEM NOTE");
    expect(out.result.kind).toBe("answer");
    expect(out.result.receipt).toMatchObject({ threadId: "spotify-receipt", from: "Spotify" });
    expect(out.threadId).toBe("spotify-receipt");
    // The follow-up points at the email it is about, not the quoted one.
    expect(out.result.kind === "answer" && out.result.offer).toEqual({
      threadId: "netflix-bill",
      next: "canceling Netflix",
    });
  });

  it("says it searched and found nothing, instead of not searching", async () => {
    const llm = scripted({
      task_email: { indexes: [] },
      task_result: work({ kind: "answer", text: "I didn't find any car insurance emails." }),
    });
    await runWork(input({ summary: "finding the car insurance renewal", threadId: null }), {
      provider,
      llm,
      model: "m",
      fastModel: "f",
    });
    expect(llm.requests[1]?.input[0]?.content).toContain(
      "You searched the user's inbox for this and found no matching email.",
    );
  });

  // Stress run: "...7:05 AM.?" got a second question mark.
  it("adds a question mark only when the question has none", async () => {
    const ask = (text: string) => scripted({ task_result: work({ kind: "question", text }) });
    const run = async (text: string) =>
      (
        await runWork(input({ threadId: null }), {
          provider: null,
          llm: ask(text),
          model: "m",
          fastModel: "f",
        })
      ).result;
    expect(await run("¿Te quedas? El contrato vence pronto.")).toMatchObject({
      text: "¿Te quedas? El contrato vence pronto.",
    });
    expect(await run("Which plan")).toMatchObject({ text: "Which plan?" });
  });

  // Stress run: a follow-up "drafting a note to your insurer" searched again, found nothing,
  // and offered the same note again.
  it("a task that needs no email does not search, and asks for a missing address", async () => {
    const llm = scripted({
      task_result: work({
        kind: "draft",
        draft_to: "",
        draft_body: "Hi, when does my policy renew?",
      }),
    });
    const out = await runWork(
      input({ summary: "drafting a note to the insurer", threadId: null, search: false }),
      { provider, llm, model: "m", fastModel: "f" },
    );
    expect(llm.requests.map((r) => r.name)).toEqual(["task_result"]);
    expect(llm.requests[0]?.input[0]?.content).toContain("This task needs no email.");
    expect(out.result).toMatchObject({ kind: "question", text: expect.stringMatching(/address/) });
  });

  it("works without an inbox", async () => {
    const llm = scripted({
      task_result: work({ kind: "answer", text: "Mon: lentil soup\nTue: veggie tacos" }),
    });
    const out = await runWork(input({ summary: "a vegetarian meal plan", threadId: null }), {
      provider: null,
      llm,
      model: "m",
      fastModel: "f",
    });
    expect(out.result).toEqual({
      kind: "answer",
      text: "Mon: lentil soup\nTue: veggie tacos",
      receipt: null,
      offer: null,
    });
    expect(llm.requests[0]?.input[0]?.content).toContain(
      "No email for this task. The user has not connected an inbox.",
    );
  });
});

describe("task service", () => {
  async function setup(llm: LlmClient) {
    const { TaskService } = await import("../src/tasks/service.ts");
    const { InboxService } = await import("../src/inbox/service.ts");
    const { World } = await import("./world.ts");
    const quiet = { info: () => {}, warn: () => {} };
    const w = new World({ caps: { gmail: true, tasks: true } });
    const inbox = new InboxService({ hub: w.hub, llm, model: "f", log: quiet });
    const tasks = new TaskService({
      hub: w.hub,
      inbox,
      llm,
      model: "m",
      fastModel: "f",
      log: quiet,
    });
    w.hub.subscribe(w.sid, (msg) => {
      if (msg.type === "action") tasks.onAction(w.sid, msg.action);
    });
    const done = async () => {
      await tasks.idle();
      await w.settle();
      await w.advance(1000);
    };
    return { w, inbox, done };
  }

  it("runs a stated task on the sample inbox and brings back a draft with its receipt", async () => {
    const llm = scripted({
      task_email: (req: JsonRequest) => {
        const line = req.input[0]?.content.split("\n").find((l) => l.includes("Planet Fitness"));
        return { indexes: [Number(line?.split(".")[0] ?? -1)] };
      },
      task_result: work({
        kind: "draft",
        text: "Here's a reply to Planet Fitness that cancels your membership.",
        quote: "Cancellation requests must reach us at least 3 days before your billing date.",
        draft_to: "members@planetfitness.com",
        draft_subject: "Cancel my membership",
        draft_body: "Hi,\n\nPlease cancel my Black Card membership.\n\nThanks",
      }),
    });
    const { w, inbox, done } = await setup(llm);
    inbox.connectDemo(w.sid);
    await w.event({
      type: "oauth_done",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      email: "sample",
      name: null,
      demo: true,
    });
    await w.say("cancel my gym membership", {
      task: { summary: "canceling the gym membership", needs_gmail: true },
    });
    await done();
    const last = w.last();
    expect(last?.drafts[0]).toMatchObject({ to: "members@planetfitness.com" });
    expect(last?.texts.join(" ")).toContain(
      "“Cancellation requests must reach us at least 3 days before your billing date.”",
    );
    expect(w.awaiting()).toBe("confirm_send");
  });

  // Browser QA: a dev server restart forgot the sample inbox, and the agent said it lost access.
  it("the sample inbox comes back after a restart, since it has no token", async () => {
    const llm = scripted({
      task_email: (req: JsonRequest) => {
        const line = req.input[0]?.content.split("\n").find((l) => l.includes("Con Edison"));
        return { indexes: [Number(line?.split(".")[0] ?? -1)] };
      },
      task_result: work({ kind: "answer", text: "Your bill of $86.42 is due soon." }),
    });
    const { w, done } = await setup(llm);
    // Connected before the restart. This service instance never saw the connect.
    await w.event({
      type: "oauth_done",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      email: "sample",
      name: null,
      demo: true,
    });
    await w.say("what do i owe con edison", {
      task: { summary: "checking the Con Edison bill", needs_gmail: true },
    });
    await done();
    expect(w.state.slots.gmail.status).toBe("confirmed");
    expect(w.last()?.texts.join(" ")).toMatch(/\$86\.42/);
  });

  it("retries once, then reports a failure", async () => {
    let calls = 0;
    const flaky: LlmClient = {
      async json(): Promise<never> {
        calls += 1;
        throw new Error(`deadline ${calls}`);
      },
    };
    const { w, done } = await setup(flaky);
    await w.say("plan my meals", {
      task: { summary: "planning meals for the week", needs_gmail: false },
    });
    await done();
    expect(calls).toBe(2);
    expect(w.state.tasks[0]?.status).toBe("failed");
    expect(w.last()?.texts.join(" ")).toMatch(/couldn't finish planning meals/i);
  });

  it("a task that needs the inbox, with no connection left, asks for Gmail again", async () => {
    const llm = scripted({});
    const { w, done } = await setup(llm);
    // Gmail was connected, but the server restarted and the token is gone.
    await w.event({
      type: "oauth_done",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      email: "dan@gmail.com",
      name: null,
    });
    await w.say("find my flight", { task: { summary: "finding the flight", needs_gmail: true } });
    await done();
    expect(w.state.slots.gmail.status).toBe("unknown");
    expect(w.last()?.texts.join(" ")).toMatch(/lost access to your inbox/i);
  });
});
