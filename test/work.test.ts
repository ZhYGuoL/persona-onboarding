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
    quote: "",
    draft_to: "",
    draft_subject: "",
    draft_body: "",
    remind_at: "",
    ...partial,
  };
}

function input(partial: Partial<WorkInput> = {}): WorkInput {
  return {
    summary: "canceling the New York Times trial",
    threadId: "nyt-trial",
    notes: [],
    previous: null,
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
      task_result: work({ kind: "draft", draft_to: "boss@work.example", draft_body: "I'm sick." }),
    });
    const b = await runWork(input({ summary: "emailing my boss", threadId: null }), {
      provider: null,
      llm: noEmail,
      model: "m",
      fastModel: "f",
    });
    expect(b.result).toMatchObject({ kind: "question", text: expect.stringMatching(/address/) });

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
        return { index: Number(line?.split(".")[0] ?? -1) };
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
    });
    expect(llm.requests[0]?.input[0]?.content).toContain("No email for this task.");
  });
});
