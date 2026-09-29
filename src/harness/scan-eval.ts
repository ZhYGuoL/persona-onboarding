// Checks the inbox scan on the real model: does it mark a find as related only
// when it helps with the need the user stated? Live QA found "organizing the work
// calendar" matched to a personal flight, a hotel stay, and a dentist visit.
//
//   pnpm eval:scan [--repeat=2]

import { DemoInbox } from "../inbox/demo.ts";
import { scanInbox } from "../inbox/scan.ts";
import type { Finding } from "../inbox/types.ts";
import { modelsFromEnv, OpenAiClient } from "../llm/openai.ts";

interface Case {
  need: string;
  expect: (findings: Finding[]) => boolean;
  label: string;
}

const related = (fs: Finding[]) => fs.filter((f) => f.related);
const topIs = (re: RegExp) => (fs: Finding[]) => fs[0]?.related === true && re.test(fs[0].fact);

const CASES: Case[] = [
  {
    label: "a need the inbox cannot help with marks nothing related",
    need: "organizing the work calendar",
    expect: (fs) => related(fs).length === 0,
  },
  {
    label: "car insurance is not in the inbox",
    need: "finding the car insurance renewal date and price",
    expect: (fs) => related(fs).length === 0,
  },
  {
    label: "a birthday party matches nothing",
    need: "planning a birthday party",
    expect: (fs) => related(fs).length === 0,
  },
  {
    label: "subscriptions find a renewal or trial",
    need: "cancel subscriptions",
    expect: topIs(/New York Times|Adobe|Creative Cloud|Planet Fitness|Spotify|Netflix/i),
  },
  {
    label: "bills find a bill",
    need: "keeping up with bills",
    expect: topIs(/Con Edison|Chase|Verizon|bill|statement/i),
  },
  {
    label: "classes find the registration",
    need: "scheduling classes and events",
    expect: topIs(/registration|class/i),
  },
  {
    label: "doctor appointments find the dentist",
    need: "remembering doctor appointments",
    expect: topIs(/dental|dentist|cleaning|Dr\./i),
  },
];

const repeat = Number(process.argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 1);
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");
const llm = new OpenAiClient(apiKey);
const model = modelsFromEnv().fast;
const now = Date.now();

let pass = 0;
let total = 0;
for (const c of CASES) {
  for (let i = 0; i < repeat; i++) {
    const r = await scanInbox({ provider: new DemoInbox(now), need: c.need, llm, model, now });
    const ok = c.expect(r.findings);
    total += 1;
    if (ok) pass += 1;
    else {
      const got = r.findings
        .map((f) => `${f.related ? "related" : "other"}: ${f.fact}`)
        .join(" | ");
      console.log(`FAIL ${c.label}: "${c.need}" -> ${got || "(no findings)"}`);
    }
  }
}
console.log(`${pass}/${total} passed. Spent $${llm.meter.usd.toFixed(4)}.`);
