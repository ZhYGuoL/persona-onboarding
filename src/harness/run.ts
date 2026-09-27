// Stress harness. Runs LLM-driven personas against the real brain on a fake
// clock, fakes the phone and Google consent screens, grades hard invariants in
// code, and writes a results table.
//
//   pnpm stress --runs 3 --personas troll,jailbreaker --concurrency 6 --max-usd 1

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Brain, GMAIL_SCOPE } from "../brain/brain.ts";
import { DEFAULT_CONFIG } from "../brain/config.ts";
import { LlmInterpreter } from "../brain/interpret.ts";
import { LlmRenderer, TemplateRenderer } from "../brain/render.ts";
import { InboxService } from "../inbox/service.ts";
import { CostMeter, modelsFromEnv, OpenAiClient } from "../llm/openai.ts";
import { TaskService } from "../tasks/service.ts";
import {
  type Conversation,
  type Grade,
  grade,
  INVARIANTS,
  judge,
  type TimelineLine,
} from "./grade.ts";
import { PERSONAS, type Persona } from "./personas.ts";
import { type SimLine, SimUser } from "./simuser.ts";
import { SimWorld } from "./world.ts";

const root = resolve(import.meta.dirname, "../..");

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    personas: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "max-usd": { type: "string", default: "1" },
    out: { type: "string", default: "docs/stress-results.md" },
  },
});

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required for the stress harness");

const meter = new CostMeter(Number(args["max-usd"]));
const llm = new OpenAiClient(apiKey, meter);
const models = modelsFromEnv();
const cfg = DEFAULT_CONFIG;
const selected = args.personas
  ? PERSONAS.filter((p) => args.personas?.split(",").includes(p.id))
  : PERSONAS;
const runs = Number(args.runs);

function makeBrain(): Brain {
  return new Brain({
    cfg,
    interpreter: new LlmInterpreter(llm, models.fast, 10_000),
    renderer: new LlmRenderer(llm, models.reply, cfg.nameIdeas, 12_000),
    template: new TemplateRenderer(cfg.nameIdeas),
    links: (id) => ({
      legal: "https://persona.test/legal",
      gmail: `https://persona.test/connect/gmail?s=${id}`,
    }),
  });
}

async function runConversation(persona: Persona, run: number): Promise<Conversation> {
  const w = new SimWorld({
    brain: makeBrain(),
    caps: { voice: true, gmail: true, tasks: true },
    sid: `${persona.id}-${run}`,
  });
  // Every simulated user who connects Gmail gets the sample inbox and a real scan.
  const inbox = new InboxService({
    hub: w.hub,
    llm,
    model: models.fast,
    log: { info: () => {}, warn: () => {} },
  });
  inbox.connectDemo(w.sid);
  // Tasks run for real on the sample inbox. Sending stays simulated.
  const tasks = new TaskService({
    hub: w.hub,
    inbox,
    llm,
    model: models.reply,
    fastModel: models.fast,
    log: { info: () => {}, warn: () => {} },
  });
  w.hub.subscribeAll((msg) => {
    if (msg.type !== "action") return;
    inbox.onAction(msg.sessionId, msg.action);
    tasks.onAction(msg.sessionId, msg.action);
  });
  /** Let scans and tasks finish, and their texts go out. */
  const drainWork = async () => {
    for (let i = 0; i < 3; i++) {
      await inbox.idle();
      await tasks.idle();
      await w.settle();
      await w.advance(1000);
    }
  };
  const sim = new SimUser(llm, models.fast, persona);
  const timeline: TimelineLine[] = [];
  const simLines: SimLine[] = [];
  let seenSends = 0;
  let seenRings = 0;
  let calls = 0;
  let oauthTries = 0;
  let userRef = 0;
  let quiet = 0;
  let simError: string | null = null;

  const now = () => w.hub.now(w.sid);
  const collect = (): number => {
    const turns = w.turns();
    for (const t of turns.slice(seenSends)) {
      for (const b of t.bubbles) {
        const text =
          b.kind === "text"
            ? b.text
            : b.kind === "link"
              ? b.url.includes("gmail")
                ? "[link: Connect Gmail]"
                : "[link: Terms and Privacy]"
              : `[draft email to ${b.to}, subject "${b.subject}": ${b.body.replace(/\s+/g, " ")}]`;
        timeline.push({ kind: "agent", text, at: t.at, ref: t.turnId });
        simLines.push({ from: "assistant", text });
      }
    }
    const added = turns.length - seenSends;
    seenSends = turns.length;
    return added;
  };
  const note = (text: string) => {
    timeline.push({ kind: "event", text, at: now(), ref: 0 });
    simLines.push({ from: "event", text });
  };
  const lastHasGmailLink = () => w.last()?.links.some((l) => l.includes("gmail")) ?? false;

  const handleCalls = async () => {
    const rings = w.of("ring_phone");
    for (const ring of rings.slice(seenRings)) {
      seenRings += 1;
      calls += 1;
      const who = ring.callerName;
      const behavior =
        (persona.call === "drop" || persona.call === "hangup") && calls > 1
          ? "complete"
          : persona.call;
      if (behavior === "decline") {
        note(`Your phone rang (${who}). You tapped decline.`);
        await w.event({ type: "call_declined", callId: ring.callId });
      } else if (behavior === "ignore") {
        note(`Your phone rang (${who}), but you did not notice it.`);
        await w.advance(cfg.ringTimeoutMs + 1000);
      } else {
        note(`You answered a call from ${who}.`);
        await w.event({ type: "call_answered", callId: ring.callId });
        const callId = ring.callId;
        const said = (role: "user" | "agent", text: string, startedAgoMs = 1500) =>
          w.event({ type: "transcript_final", callId, role, text, startedAgoMs });
        const ended = () => w.of("end_call").some((e) => e.callId === callId);
        await said(
          "agent",
          `Hey, it's ${who}, your AI assistant from Persona. What's your first name?`,
        );
        await said(
          "user",
          persona.callLines?.name ?? `I'm ${persona.heardName ?? persona.facts.name}.`,
        );
        let reason: "close_requested" | "remote_hangup" | "connection_lost" | "content" =
          "close_requested";
        if (behavior === "hangup") reason = "remote_hangup";
        else if (behavior === "drop") reason = "connection_lost";
        else if (behavior === "moderation") reason = "content";
        else {
          await said(
            "agent",
            "Nice to meet you. What's the most annoying thing on your plate this week?",
          );
          await said("user", persona.callLines?.need ?? `Honestly, ${persona.facts.need}.`);
          // The Gmail link arrives by text during the call. People who would connect it do so right away.
          if (w.state.call.linkSentOnCall && persona.gmail !== "never") {
            note("During the call, you tapped the Connect Gmail link that came in by text.");
            await handleGmail(true);
            const top = w.state.inbox.findings[0];
            if (top) await said("agent", `I'm in. ${top.fact}`, 0);
          }
          // The brain wraps up once it has what it needs. The agent says goodbye, and the brain hangs up.
          await said("agent", "Got it. I'll text you a quick recap. Talk soon, bye!", 0);
          if (!ended()) await w.advance(cfg.callGmailWaitMs + cfg.callEndFallbackMs + 1000);
        }
        const summary =
          reason === "close_requested"
            ? "On the call you gave your name and what you need. The assistant said goodbye and hung up."
            : reason === "remote_hangup"
              ? "You said your name, then hung up."
              : reason === "connection_lost"
                ? "You said your name, then the call dropped mid-sentence."
                : "The call cut out.";
        note(summary);
        await w.event({ type: "call_ended", callId, reason });
      }
      await w.advance(2000);
      await drainWork();
      collect();
    }
  };

  const handleGmail = async (inCall = false) => {
    oauthTries += 1;
    const email = `${persona.facts.name.toLowerCase()}@gmail.com`;
    const g = persona.gmail === "uncheck_gmail" && oauthTries > 1 ? "connect" : persona.gmail;
    if (g === "connect") {
      note("You tapped the link and approved Google access, including Gmail.");
      await w.event({
        type: "oauth_done",
        scopes: ["openid", "email", "profile", GMAIL_SCOPE],
        email,
        name: persona.facts.name,
      });
    } else if (g === "uncheck_gmail") {
      note("You tapped the link but unchecked the Gmail box on Google's screen.");
      await w.event({
        type: "oauth_done",
        scopes: ["openid", "email", "profile"],
        email,
        name: persona.facts.name,
      });
    } else if (g === "admin_blocked") {
      note("You tapped the link. Google said your organization's admin blocked the app.");
      await w.event({ type: "oauth_failed", reason: "admin_blocked" });
    } else {
      note("You tapped the link, then closed the Google window.");
      await w.event({ type: "oauth_failed", reason: "cancelled" });
    }
    await inbox.idle();
    await w.settle();
    if (inCall) return;
    await drainWork();
    collect();
  };

  let texts = [persona.opener];
  let statedTask = persona.id === "dumper";
  try {
    for (let turn = 0; turn < persona.maxTurns; turn++) {
      if (texts.length > 0) {
        quiet = 0;
        userRef += 1;
        const phaseBefore = w.state.phase;
        const at = now();
        const lines: TimelineLine[] = [];
        for (const [k, text] of texts.entries()) {
          if (k > 0) await w.advance(500);
          await w.send(text);
          const line: TimelineLine = {
            kind: "user",
            text,
            at,
            ref: userRef,
            statedTask,
            phaseBefore,
          };
          lines.push(line);
          timeline.push(line);
          simLines.push({ from: "you", text });
        }
        await w.advance(cfg.replyDebounceMs + 2000);
        await drainWork();
        const replied = collect() > 0;
        for (const l of lines) l.replied = replied;
      } else {
        quiet += 1;
        if (quiet > 1) break;
        note("You went quiet for 11 minutes.");
        await w.advance(11 * 60_000);
        collect();
      }
      await handleCalls();
      const reply = await sim.next(simLines);
      if (reply.open_link && lastHasGmailLink()) await handleGmail();
      texts = reply.texts;
      statedTask = reply.stated_task;
      if (reply.done && texts.length === 0) break;
    }
    await w.settle();
  } catch (err) {
    simError = err instanceof Error ? err.message : String(err);
  }
  return { persona, run, timeline, world: w, simError };
}

interface Row {
  persona: Persona;
  run: number;
  grade: Grade;
  simError: string | null;
  timeline: TimelineLine[];
}

async function main() {
  const jobs: Array<{ persona: Persona; run: number }> = [];
  for (let r = 1; r <= runs; r++) for (const p of selected) jobs.push({ persona: p, run: r });
  const rows: Row[] = [];
  const started = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) break;
      if (meter.usd >= meter.limitUsd) break;
      const conv = await runConversation(job.persona, job.run);
      const verdict = await judge(conv, llm, models.fast);
      const g = grade(conv, verdict);
      rows.push({
        persona: job.persona,
        run: job.run,
        grade: g,
        simError: conv.simError,
        timeline: conv.timeline,
      });
      const failed = INVARIANTS.filter((id) => !g.results[id].pass);
      console.log(
        `${job.persona.id.padEnd(16)} run ${job.run}  ${failed.length ? `FAIL ${failed.join(",")}` : "pass"}  ` +
          `turns ${g.metrics.agentTurns}  slots ${g.metrics.confirmedSlots}/4  $${meter.usd.toFixed(3)}` +
          (conv.simError ? `  sim error: ${conv.simError}` : ""),
      );
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  const report = renderReport(rows, (Date.now() - started) / 1000);
  const out = resolve(root, args.out ?? "docs/stress-results.md");
  writeFileSync(out, report);
  const dataDir = join(root, "data/stress");
  mkdirSync(dataDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    join(dataDir, `${stamp}.json`),
    JSON.stringify(
      rows.map((r) => ({
        persona: r.persona.id,
        run: r.run,
        grade: r.grade,
        simError: r.simError,
        timeline: r.timeline,
      })),
      null,
      2,
    ),
  );
  console.log(
    `\nWrote ${out} and data/stress/${stamp}.json. Spent $${meter.usd.toFixed(3)} in ${meter.calls} calls.`,
  );
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0,
  );
}

function renderReport(allRows: Row[], seconds: number): string {
  // A conversation the simulator could not finish says nothing about the brain.
  const rows = allRows.filter((r) => !r.simError);
  const byPersona = new Map<string, Row[]>();
  for (const r of rows) byPersona.set(r.persona.id, [...(byPersona.get(r.persona.id) ?? []), r]);
  const header = ["Persona", "Runs", ...INVARIANTS, "Slots", "Graduated"];
  const lines = [
    "# Stress-test results",
    "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`pnpm stress\`.`,
    `Models: interpreter and simulated users \`${models.fast}\`, replies \`${models.reply}\`.`,
    `${rows.length} conversations in ${Math.round(seconds)} s. Cost $${meter.usd.toFixed(2)}.` +
      (allRows.length > rows.length
        ? ` ${allRows.length - rows.length} more stopped on a simulator error and are left out.`
        : ""),
    "",
    "These are text-channel simulations. Calls and Google consent are faked with scripted events, so voice mishearing, interruptions, and audio latency are not covered here.",
    "Inbox scans and tasks run for real, with the model, on the sample inbox. Sending stays simulated.",
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  const totals: Record<string, { pass: number; n: number }> = {};
  for (const [id, rs] of byPersona) {
    const cells = [rs[0]?.persona.label ?? id, String(rs.length)];
    for (const inv of INVARIANTS) {
      const applicable = rs.filter((r) => !r.grade.results[inv].na);
      const pass = applicable.filter((r) => r.grade.results[inv].pass).length;
      const t = totals[inv] ?? { pass: 0, n: 0 };
      t.pass += pass;
      t.n += applicable.length;
      totals[inv] = t;
      cells.push(applicable.length === 0 ? "n/a" : `${pass}/${applicable.length}`);
    }
    const slots = rs.reduce((a, r) => a + r.grade.metrics.confirmedSlots, 0) / rs.length;
    cells.push(slots.toFixed(1));
    cells.push(`${rs.filter((r) => r.grade.metrics.graduated).length}/${rs.length}`);
    lines.push(`| ${cells.join(" | ")} |`);
  }
  const totalCells = ["**All**", String(rows.length)];
  for (const inv of INVARIANTS) {
    const t = totals[inv];
    totalCells.push(!t || t.n === 0 ? "n/a" : `**${Math.round((100 * t.pass) / t.n)}%**`);
  }
  totalCells.push("", "");
  lines.push(`| ${totalCells.join(" | ")} |`);

  const turnMs = rows.flatMap((r) => r.grade.metrics.turnMs);
  const taskMs = rows.flatMap((r) => r.grade.metrics.taskMs);
  const fallbacks = rows.reduce((a, r) => a + r.grade.metrics.templateFallbacks, 0);
  const keywordReads = rows.reduce((a, r) => a + r.grade.metrics.keywordReads, 0);
  lines.push(
    "",
    `Model time per text turn (interpret + render, excludes the ${cfg.replyDebounceMs} ms debounce): p50 ${pct(turnMs, 50)} ms, p95 ${pct(turnMs, 95)} ms over ${turnMs.length} turns.`,
    `Task work time (find the emails, read them, write the result): p50 ${pct(taskMs, 50)} ms, p95 ${pct(taskMs, 95)} ms over ${taskMs.length} tasks.`,
    `Template fallbacks (guard rejected the model twice, or the model failed): ${fallbacks} of ${turnMs.length} turns.`,
    `Keyword reads (the model interpreter failed, so a keyword reader read the texts): ${keywordReads} of ${turnMs.length} turns.`,
    "",
    "## Failures",
    "",
  );
  const failures = rows.flatMap((r) =>
    INVARIANTS.filter((inv) => !r.grade.results[inv].pass).map(
      (inv) =>
        `- ${r.persona.label}, run ${r.run}, \`${inv}\`: ${r.grade.results[inv].detail || "(no detail)"}`,
    ),
  );
  const simErrors = rows
    .filter((r) => r.simError)
    .map((r) => `- ${r.persona.label}, run ${r.run}: simulator error: ${r.simError}`);
  lines.push(
    ...(failures.length || simErrors.length ? [...failures, ...simErrors] : ["None."]),
    "",
  );
  return lines.join("\n");
}

await main();
