// Grades the scripted voice runs from the event log and writes
// docs/voice-results.md: what each call did, and how long the caller waited.
//
//   pnpm voice:report [--since-min=180]

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHECK_IN_INSTRUCTION } from "../brain/call.ts";
import type { LogEntry } from "../runtime/store.ts";
import { Store } from "../runtime/store.ts";

const root = resolve(import.meta.dirname, "../..");
const sinceMin = Number(
  process.argv.find((a) => a.startsWith("--since-min="))?.split("=")[1] ?? 180,
);
const store = new Store(process.env.DATABASE_PATH ?? join(root, "data/persona.db"));

interface Run {
  scenario: string;
  sessionId: string;
  finished: boolean;
  detail: string | null;
  checks: Array<{ name: string; pass: boolean }>;
  metrics: Record<string, number[]>;
}

const SPANISH = /\b(hola|claro|puedo|ayudar|gracias|nombre|cómo|qué|está|usted|tú)\b|[¿¡ñ]/i;

function transcripts(log: LogEntry[], role: "agent" | "user"): Array<{ ts: number; text: string }> {
  return log
    .filter((e) => e.type === "transcript_final")
    .map((e) => ({ ts: e.ts, ...(e.payload as { role: string; text: string }) }))
    .filter((t) => t.role === role);
}

function grade(scenario: string, log: LogEntry[], sessionId: string): Run["checks"] {
  const state = store.load(sessionId)?.state;
  const agent = transcripts(log, "agent");
  const user = transcripts(log, "user");
  const ended = log.find((e) => e.type === "call_ended");
  const reason = (ended?.payload as { reason?: string } | undefined)?.reason;
  const textAfterEnd = ended
    ? log.some(
        (e) =>
          e.dir === "out" && e.type === "send_text" && e.ts >= ended.ts && e.ts - ended.ts <= 8000,
      )
    : false;
  const agentEnded = log.some((e) => e.dir === "out" && e.type === "end_call");
  const said = (re: RegExp, after = 0) => agent.some((t) => t.ts >= after && re.test(t.text));
  const userSaid = (re: RegExp) => user.find((t) => re.test(t.text))?.ts ?? null;
  const checks: Run["checks"] = [];
  const check = (name: string, pass: boolean) => checks.push({ name, pass });

  switch (scenario) {
    case "happy": {
      const slots = state?.slots;
      check("name and need captured", Boolean(slots?.user_name.value && slots.help_need.value));
      // After the need is known, the agent never asks for it again.
      const needAt = log.find(
        (e) => e.type === "call_turn" && JSON.stringify(e.payload).includes('"help_need":"'),
      )?.ts;
      check(
        "no re-ask of the need",
        !needAt || !said(/on your plate|help (you )?with|what can i help/i, needAt + 1),
      );
      check("the agent ended the call", agentEnded);
      check("recap text within 8 s", textAfterEnd);
      break;
    }
    case "spelled_name":
      check("spelled name kept exactly", state?.slots.user_name.value === "Xiomara");
      check("recap text within 8 s", textAfterEnd);
      break;
    case "interrupt": {
      const stop = (log.filter((e) => e.type === "voice_metric") as LogEntry[])
        .map((e) => e.payload as { kind: string; ms: number })
        .find((m) => m.kind === "barge_in_stop");
      check("went quiet within 1.5 s of the interruption", stop !== undefined && stop.ms <= 1500);
      check("answered the question", said(/free|cost|charge|price|pay/i));
      break;
    }
    case "silence":
      check(
        "checked in after the silence",
        log.some(
          (e) =>
            e.type === "push_to_call" && JSON.stringify(e.payload).includes(CHECK_IN_INSTRUCTION),
        ),
      );
      check("the call ended", ended !== undefined);
      check("carried on by text", textAfterEnd);
      break;
    case "spanish": {
      const at = userSaid(SPANISH) ?? 0;
      check("replied in Spanish", at > 0 && said(SPANISH, at));
      break;
    }
    case "bot": {
      const at = userSaid(/bot|robot|real person|human|ai\b/i) ?? 0;
      check("said it is an AI", said(/\b(AI|artificial|assistant)\b/i, at));
      break;
    }
    case "gotta_go": {
      const at = userSaid(/gotta|go|bye|run/i);
      check("hung up within 15 s", at !== null && ended !== undefined && ended.ts - at <= 15_000);
      check("recap text within 8 s", textAfterEnd);
      break;
    }
    case "drop":
      check("classified as a drop", reason === "connection_lost");
      check("texted within 8 s of the drop", textAfterEnd);
      break;
  }
  return checks;
}

function pct(xs: number[], p: number): string {
  if (xs.length === 0) return "n/a";
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return `${sorted[Math.max(0, i)]}`;
}

const runs: Run[] = [];
for (const sessionId of store.sessionsWithEvent("voice_run", Date.now() - sinceMin * 60_000)) {
  const log = store.events(sessionId);
  const start = log.find(
    (e) => e.type === "voice_run" && (e.payload as { status: string }).status === "start",
  );
  if (!start) continue;
  const scenario = (start.payload as { scenario: string }).scenario;
  const end = log.find(
    (e) => e.type === "voice_run" && (e.payload as { status: string }).status === "end",
  );
  const detail = (end?.payload as { detail?: string | null } | undefined)?.detail ?? null;
  const metrics: Record<string, number[]> = {};
  for (const e of log.filter((x) => x.type === "voice_metric")) {
    const m = e.payload as { kind: string; ms: number };
    metrics[m.kind] = [...(metrics[m.kind] ?? []), m.ms];
  }
  runs.push({
    scenario,
    sessionId,
    finished: end !== undefined && !detail,
    detail,
    checks: grade(scenario, log, sessionId),
    metrics,
  });
}

const all = (kind: string) => runs.flatMap((r) => r.metrics[kind] ?? []);
const passed = runs.reduce((a, r) => a + r.checks.filter((c) => c.pass).length, 0);
const total = runs.reduce((a, r) => a + r.checks.length, 0);
const lines = [
  "# Voice run results",
  "",
  `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`pnpm voice:report\`, from ${runs.length} scripted calls in the last ${sinceMin} minutes.`,
  "Each call is a real GPT-Live session. The caller is prerecorded clips played through the test voice, so the end of each clip is exact.",
  "Timings are measured in the browser on the agent's audio.",
  "",
  "## Latency",
  "",
  "| Measure | p50 | p95 | Samples |",
  "| --- | --- | --- | --- |",
  `| Tap to live session | ${pct(all("connect"), 50)} ms | ${pct(all("connect"), 95)} ms | ${all("connect").length} |`,
  `| Tap to first agent audio | ${pct(all("first_audio"), 50)} ms | ${pct(all("first_audio"), 95)} ms | ${all("first_audio").length} |`,
  `| End of caller's speech to agent reply | ${pct(all("turn_latency"), 50)} ms | ${pct(all("turn_latency"), 95)} ms | ${all("turn_latency").length} |`,
  `| Caller talks over agent to agent quiet | ${pct(all("barge_in_stop"), 50)} ms | ${pct(all("barge_in_stop"), 95)} ms | ${all("barge_in_stop").length} |`,
  "",
  "## Runs",
  "",
  `${passed} of ${total} checks passed.`,
  "",
  "| Scenario | Ran to the end | Checks | First audio | Reply gaps |",
  "| --- | --- | --- | --- | --- |",
  ...runs.map((r) => {
    const checks = r.checks.map((c) => `${c.pass ? "pass" : "FAIL"}: ${c.name}`).join("<br>");
    const gaps = (r.metrics.turn_latency ?? []).map((ms) => `${ms}`).join(", ") || "-";
    return `| ${r.scenario} | ${r.finished ? "yes" : `no (${r.detail ?? "no end mark"})`} | ${checks || "-"} | ${r.metrics.first_audio?.[0] ?? "-"} ms | ${gaps} |`;
  }),
  "",
];
const out = join(root, "docs/voice-results.md");
writeFileSync(out, lines.join("\n"));
console.log(`Wrote ${out}: ${runs.length} runs, ${passed}/${total} checks.`);
store.close();
