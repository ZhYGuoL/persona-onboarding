// Checks the work step on the sample inbox with the real model: the right
// email, the right kind of result, and drafts that go where they should.
//
//   pnpm eval:tasks [--repeat=N] [--only=label] [--show]

import type { TaskResult } from "../brain/types.ts";
import { DemoInbox } from "../inbox/demo.ts";
import { modelsFromEnv, OpenAiClient } from "../llm/openai.ts";
import { runWork, type WorkInput } from "../tasks/work.ts";

interface Case {
  label: string;
  input: Partial<WorkInput> & { summary: string };
  /** False means run without an inbox. */
  inbox?: boolean;
  expect: (r: TaskResult, threadId: string | null) => boolean;
}

const NOW = Date.UTC(2026, 8, 27, 13, 30);

const CASES: Case[] = [
  {
    label: "cancel from a finding drafts to the reply address",
    input: { summary: "canceling the New York Times trial", threadId: "nyt-trial" },
    expect: (r) => r.kind === "draft" && r.draft.to === "help@nytimes.com" && !!r.receipt?.quote,
  },
  {
    label: "cancel without a finding picks the gym email",
    input: { summary: "canceling the gym membership" },
    expect: (r, t) =>
      t === "pf-renewal" && r.kind === "draft" && r.draft.to === "members@planetfitness.com",
  },
  {
    label: "a reply that needs a decision asks first",
    input: { summary: "replying to Mark about the lease" },
    expect: (r, t) => t === "landlord" && r.kind === "question",
  },
  {
    label: "the decision given, it drafts the reply",
    input: {
      summary: "replying to Mark about the lease",
      notes: ['You asked "Are you staying?" They said: yes, staying'],
    },
    expect: (r) => r.kind === "draft" && r.draft.to === "mark.delgado@gmail.com",
  },
  {
    label: "a bill reminder is set before the due date",
    input: { summary: "setting a reminder before the Con Edison bill is due" },
    expect: (r, t) => t === "conedison" && r.kind === "remind" && r.at < NOW + 9 * 86_400_000,
  },
  {
    label: "a question about a flight is answered with its receipt",
    input: { summary: "finding when the Denver flight leaves" },
    expect: (r, t) => t === "delta-flight" && r.kind === "answer" && /7:05/.test(r.text),
  },
  {
    label: "a list task names several subscriptions",
    input: { summary: "finding forgotten subscriptions" },
    expect: (r) =>
      r.kind === "answer" &&
      ["netflix", "spotify", "adobe", "new york times", "nyt", "planet fitness"].filter((n) =>
        r.text.toLowerCase().includes(n),
      ).length >= 2,
  },
  {
    label: "other ones skip what was already shown",
    input: {
      summary: "finding other subscriptions",
      shown: ["nyt-trial", "adobe-renewal", "pf-renewal"],
    },
    expect: (r) =>
      r.kind === "answer" &&
      !/new york times|adobe|planet fitness/i.test(r.text) &&
      /netflix|spotify/i.test(r.text),
  },
  {
    label: "nothing found is said plainly",
    input: { summary: "finding the car insurance renewal date" },
    expect: (r) =>
      (r.kind === "answer" || r.kind === "cannot" || r.kind === "question") &&
      !/can.?t (search|access|read|check)/i.test(r.text),
  },
  {
    label: "a meal plan needs no inbox",
    input: { summary: "planning vegetarian dinners for the week", threadId: null },
    inbox: false,
    expect: (r) => r.kind === "answer" && r.text.length > 40,
  },
  {
    label: "buying something never claims a purchase",
    input: { summary: "buying new running shoes", threadId: null },
    inbox: false,
    // "Cannot", a shortlist, or a question about size are all honest.
    expect: (r) =>
      (r.kind === "cannot" || r.kind === "answer" || r.kind === "question") &&
      !/\b(bought|ordered|purchased|placed (the|an|your) order)\b/i.test(r.text),
  },
  {
    label: "the scam email is left alone",
    input: { summary: "dealing with the account security alert", threadId: "phish" },
    expect: (r) => r.kind === "cannot" && /scam/i.test(r.text),
  },
];

const repeat = Number(process.argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 1);
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const show = process.argv.includes("--show");

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");
const llm = new OpenAiClient(apiKey);
const models = modelsFromEnv();
const provider = new DemoInbox(NOW);

const selected = CASES.filter((c) => !only || c.label.includes(only));
const runs = selected.flatMap((c) => Array.from({ length: repeat }, () => c));
const results = await Promise.all(
  runs.map(async (c) => {
    const input: WorkInput = {
      threadId: null,
      notes: [],
      previous: null,
      shown: [],
      userName: "Dan",
      userEmail: "dan@gmail.com",
      language: "en",
      now: NOW,
      timeZone: "America/New_York",
      ...c.input,
    };
    try {
      const out = await runWork(input, {
        provider: c.inbox === false ? null : provider,
        llm,
        model: models.reply,
        fastModel: models.fast,
      });
      return { c, ok: c.expect(out.result, out.threadId), out };
    } catch (err) {
      return { c, ok: false, out: null, err: String(err) };
    }
  }),
);
let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  if (!r.ok || show) {
    console.log(
      `${r.ok ? "ok  " : "FAIL"} ${r.c.label}\n${JSON.stringify(r.out ?? r.err, null, 2)}\n`,
    );
  }
}
console.log(`${pass}/${runs.length} passed. Spent $${llm.meter.usd.toFixed(4)}.`);
