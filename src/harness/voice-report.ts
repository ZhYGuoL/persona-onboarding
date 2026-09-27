// Grades the scripted voice runs from the event log and writes
// docs/voice-results.md: what each call did, and how long the caller waited.
//
//   pnpm voice:report [--since-min=180] [--since=<epoch ms>]

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHECK_IN_INSTRUCTION } from "../brain/call.ts";
import type { LogEntry } from "../runtime/store.ts";
import { Store } from "../runtime/store.ts";

const root = resolve(import.meta.dirname, "../..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const sinceMs = arg("since")
  ? Number(arg("since"))
  : Date.now() - Number(arg("since-min") ?? 180) * 60_000;
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

/** `ts` is when the utterance ended, `start` when it began. A final can arrive after the reply to it. */
function transcripts(
  log: LogEntry[],
  role: "agent" | "user",
): Array<{ ts: number; start: number; text: string }> {
  return log
    .filter((e) => e.type === "transcript_final")
    .map((e) => {
      const p = e.payload as { role: string; text: string; startedAgoMs?: number };
      return { ts: e.ts, start: e.ts - (p.startedAgoMs ?? 0), role: p.role, text: p.text };
    })
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
  const userSaid = (re: RegExp) => user.find((t) => re.test(t.text))?.start ?? null;
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
    case "interrupt":
    case "interrupt_greeting": {
      const stop = (log.filter((e) => e.type === "voice_metric") as LogEntry[])
        .map((e) => e.payload as { kind: string; ms: number })
        .find((m) => m.kind === "barge_in_stop");
      // GPT-Live finishes its current sentence, then yields. A sentence takes up to
      // about 2 s, so a longer overlap means the agent kept on talking.
      check("went quiet within 2 s of the interruption", stop !== undefined && stop.ms <= 2000);
      if (scenario === "interrupt_greeting") {
        check("still said it is an AI", said(/\bAI\b/));
      }
      // Price is not in the facts about Persona, so the honest answer is "not sure".
      const at = userSaid(/free/i) ?? 0;
      check(
        "did not guess the price",
        at > 0 &&
          said(/not sure|don't know|do not know|no idea/i, at) &&
          !said(/paid|\$|dollar/i, at),
      );
      break;
    }
    case "silence": {
      // The agent must say something between the check-in push and the wrap-up.
      const pushAt = log.find(
        (e) =>
          e.type === "push_to_call" && JSON.stringify(e.payload).includes(CHECK_IN_INSTRUCTION),
      )?.ts;
      const wrapAt =
        log.find(
          (e) => e.type === "push_to_call" && JSON.stringify(e.payload).includes("Wrap up now"),
        )?.ts ?? Number.POSITIVE_INFINITY;
      check(
        "checked in after the silence",
        pushAt !== undefined && agent.some((t) => t.start >= pushAt && t.start < wrapAt),
      );
      check("the call ended", ended !== undefined);
      check("carried on by text", textAfterEnd);
      break;
    }
    case "spanish": {
      const at = userSaid(SPANISH) ?? 0;
      check("replied in Spanish", at > 0 && said(SPANISH, at));
      break;
    }
    case "bot": {
      const at = userSaid(/bot|robot|real person|human|ai\b/i) ?? 0;
      // "I am." is a plain yes. "Yeah." alone is often a backchannel, so it does not count.
      check("said it is an AI", said(/\b(AI|artificial|bot)\b|^(yes|yep|i am)\b/i, at));
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
for (const sessionId of store.sessionsWithEvent("voice_run", sinceMs)) {
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
const scenarios = [...new Set(runs.map((r) => r.scenario))];
const since = new Date(sinceMs).toISOString().slice(0, 16).replace("T", " ");

function scenarioRow(scenario: string): string {
  const mine = runs.filter((r) => r.scenario === scenario);
  const names = [...new Set(mine.flatMap((r) => r.checks.map((c) => c.name)))];
  const checks = names
    .map((name) => {
      const results = mine.flatMap((r) => r.checks.filter((c) => c.name === name));
      const ok = results.filter((c) => c.pass).length;
      return `${ok === results.length ? "pass" : "FAIL"} ${ok}/${results.length}: ${name}`;
    })
    .join("<br>");
  const firstAudio = mine.flatMap((r) => r.metrics.first_audio ?? []);
  return `| ${scenario} | ${mine.length} | ${mine.filter((r) => r.finished).length} | ${checks || "-"} | ${firstAudio.length ? `${pct(firstAudio, 50)} ms` : "-"} |`;
}

const failed = runs.filter((r) => !r.finished || r.checks.some((c) => !c.pass));
const lines = [
  "# Voice run results",
  "",
  `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`pnpm voice:report\`, from ${runs.length} scripted calls since ${since} UTC.`,
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
  "## Scenarios",
  "",
  `${passed} of ${total} checks passed.`,
  "",
  "| Scenario | Runs | Ran to the end | Checks | First audio p50 |",
  "| --- | --- | --- | --- | --- |",
  ...scenarios.map(scenarioRow),
  "",
  "## Runs with a problem",
  "",
  ...(failed.length === 0
    ? ["None."]
    : failed.map((r) => {
        const why = [
          r.finished ? null : `stopped at: ${r.detail ?? "no end mark"}`,
          ...r.checks.filter((c) => !c.pass).map((c) => `failed: ${c.name}`),
        ].filter(Boolean);
        return `- ${r.scenario}, session \`${r.sessionId.slice(0, 8)}\`: ${why.join("; ")}.`;
      })),
  "",
];
const out = join(root, "docs/voice-results.md");
writeFileSync(out, lines.join("\n"));
console.log(`Wrote ${out}: ${runs.length} runs, ${passed}/${total} checks.`);
store.close();
