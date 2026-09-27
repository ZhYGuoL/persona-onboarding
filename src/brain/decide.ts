// The deterministic policy. Given the session state and a structured reading
// of what just happened, it updates the ledger and picks the plan for one
// agent turn: what to acknowledge, what to answer, and at most one question.
// No model runs here, so every invariant is testable and cannot be talked out of.

import type { BrainConfig } from "./config.ts";
import {
  agentDisplayName,
  applyRefusal,
  canAsk,
  newTask,
  recordAsk,
  setSlot,
  settleExhausted,
} from "./ledger.ts";
import {
  applyTaskNotice,
  applyTaskReply,
  cancelLatest,
  findingFor,
  isActive,
  offerKey,
  restatesOffer,
  startNextTask,
} from "./tasks.ts";
import { cancelTimer, scheduleTimer } from "./timers.ts";
import type {
  Ack,
  Action,
  Interpretation,
  Notice,
  OfferedFinding,
  PendingText,
  Plan,
  Question,
  SessionState,
  SlotName,
} from "./types.ts";
import { checkName, cleanHelpNeed } from "./validate.ts";

export { cancelTimer, scheduleTimer };

export interface DecideInput {
  texts: PendingText[];
  notices: Notice[];
  interp: Interpretation | null;
  now: number;
}

export interface DecideOutput {
  state: SessionState;
  plan: Plan;
  actions: Action[];
}

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|end|quit)\s*[.!]*\s*$/i;
const START_WORDS = /^\s*(start|unstop|resume)\s*[.!]*\s*$/i;

export function isStopKeyword(text: string): boolean {
  return STOP_WORDS.test(text);
}

export function isStartKeyword(text: string): boolean {
  return START_WORDS.test(text);
}

export function emptyPlan(s: SessionState, cfg: BrainConfig): Plan {
  return {
    intro: false,
    acks: [],
    answers: [],
    question: null,
    terminal: null,
    chat: false,
    mode: s.phase === "main" ? "main" : "onboarding",
    facts: planFacts(s, cfg),
  };
}

export function isEmptyPlan(plan: Plan): boolean {
  return (
    !plan.intro &&
    !plan.chat &&
    plan.terminal === null &&
    plan.question === null &&
    plan.acks.length === 0 &&
    plan.answers.length === 0
  );
}

export function decide(s0: SessionState, input: DecideInput, cfg: BrainConfig): DecideOutput {
  const s = structuredClone(s0);
  const actions: Action[] = [];
  const { texts, notices, now } = input;
  let i = input.interp;
  const acks: Ack[] = [];
  const plan = emptyPlan(s, cfg);

  // Consume what this turn covers. Anything that arrived later stays pending.
  s.pending.texts.splice(0, texts.length);
  s.pending.notices.splice(0, notices.length);

  const hasTexts = texts.length > 0;
  const previousUserAt = s.lastUserAt;
  for (const t of texts) {
    s.history.push({ from: "user", channel: "text", text: t.text, ts: t.ts });
  }
  if (hasTexts) {
    s.lastUserAt = texts[texts.length - 1]?.ts ?? now;
    updateCasing(s, texts);
    if (
      i?.language &&
      texts
        .map((t) => t.text)
        .join(" ")
        .trim().length >= 6
    ) {
      s.language = i.language;
    }
  }
  trimHistory(s, cfg);

  const awaiting = s.awaiting?.question ?? null;
  if (hasTexts) s.awaiting = null;

  // 1. Hard stops come first and end the turn.
  const optOut = texts.some((t) => isStopKeyword(t.text)) || i?.opt_out === true;
  if (optOut && s.phase !== "opted_out") {
    s.phaseBeforeOptOut = s.phase;
    s.phase = "opted_out";
    s.awaiting = null;
    stopCall(s, actions);
    cancelTimer(s, actions, "idle_nudge");
    return finish(s, { ...plan, terminal: "opt_out" }, actions, cfg);
  }
  if (s.phase === "opted_out") {
    const optIn = texts.some((t) => isStartKeyword(t.text)) || i?.opt_in === true;
    if (!optIn) return finish(s, plan, actions, cfg);
    s.phase = s.phaseBeforeOptOut ?? "onboarding";
    s.phaseBeforeOptOut = null;
    acks.push({ kind: "opted_in" });
  }
  if (i?.under_18 && s.phase !== "underage") {
    s.phase = "underage";
    s.awaiting = null;
    stopCall(s, actions);
    cancelTimer(s, actions, "idle_nudge");
    return finish(s, { ...plan, terminal: "underage" }, actions, cfg);
  }
  if (s.phase === "underage") return finish(s, plan, actions, cfg);

  // 2. First contact shows value before the first ask.
  if (hasTexts && !s.introduced) {
    plan.intro = true;
    s.introduced = true;
  }

  // 3. Coming back after a long gap opens with a one-line summary.
  // The summary uses what was known before this message, so it never repeats it back.
  const firstTs = texts[0]?.ts;
  if (
    firstTs !== undefined &&
    previousUserAt !== null &&
    firstTs - previousUserAt >= cfg.resumeGapMs &&
    s.lastAgentAt !== null
  ) {
    const before = planFacts(s0, cfg);
    acks.push({
      kind: "resume",
      agentName: before.agentName,
      userName: before.userName,
      topic: before.openTask ?? before.helpNeed,
    });
  }

  // 4. Things that happened outside the text thread.
  let taskQuestion: Question | null = null;
  let wantCallback = false;
  let noChase = false;
  let nudge = false;
  for (const n of notices) {
    switch (n.kind) {
      case "call_declined":
        acks.push({ kind: "call_declined", final: s.call.declines >= cfg.maxCallDeclines });
        break;
      case "call_missed":
        acks.push({ kind: "call_missed" });
        wantCallback = true;
        break;
      case "call_ended": {
        // Read what the call captured now, not when it ended, so the last utterance counts.
        const captured = [...s.call.captured];
        switch (n.reason) {
          case "remote_hangup":
            acks.push({ kind: "call_recap", captured });
            noChase = true;
            break;
          case "close_requested":
            if (captured.length === 0 && s.call.declines >= cfg.maxCallDeclines) {
              // They asked us to stop calling. Say so, then carry on by text.
              acks.push({ kind: "call_declined", final: true });
            } else {
              acks.push({ kind: "call_recap", captured });
            }
            if (s.call.userLeaving) noChase = true;
            break;
          case "connection_lost":
          case "expired":
          case "error":
            acks.push({ kind: "call_dropped", captured });
            wantCallback = true;
            break;
          case "content":
            acks.push({ kind: "call_cut", captured });
            break;
          case "no_voice":
            acks.push({ kind: "call_no_voice" });
            wantCallback = true;
            break;
          case "mic_denied":
            acks.push({ kind: "mic_denied" });
            break;
        }
        if (captured.some((slot) => s.slots[slot].status === "tentative")) {
          s.call.recapPending = true;
        }
        // The finding said on the call comes back in writing: receipts, not just talk.
        if (captured.includes("gmail") && s.inbox.findings[0] && n.reason !== "mic_denied") {
          acks.push({ kind: "inbox_findings", facts: s.inbox.findings.map((f) => f.fact) });
        }
        break;
      }
      case "gmail_connected":
        acks.push({
          kind: "gmail_connected",
          email: n.email,
          demo: n.demo,
          looking: s.inbox.scanning,
        });
        break;
      case "inbox_findings":
        acks.push({ kind: "inbox_findings", facts: s.inbox.findings.map((f) => f.fact) });
        break;
      case "scan_failed":
        acks.push({
          kind: "scan_failed",
          reason: n.reason,
          retry: n.reason === "error" && s.inbox.failures < cfg.maxScanFailures,
        });
        break;
      case "gmail_scope_denied":
        acks.push({ kind: "gmail_scope_denied" });
        break;
      case "gmail_failed":
        // Google sends access_denied only when the user clicks Cancel or Deny. That is
        // their no, so Gmail waits for a natural moment instead of a re-ask right away.
        if (n.reason === "access_denied" && s.slots.gmail.status !== "confirmed") {
          applyRefusal(s.slots.gmail, false);
        }
        acks.push({ kind: "gmail_failed", reason: n.reason });
        break;
      case "nudge":
        // A nudge is moot once the user has texted.
        if (!hasTexts) nudge = true;
        break;
      case "task_result":
      case "task_failed":
      case "reminder_due":
        taskQuestion = applyTaskNotice(s, n, acks, actions) ?? taskQuestion;
        break;
    }
  }

  // 5. A reply to a draft ("send it?") or to a task's question. It is about
  // that task, so it never starts a new one.
  const taskReply = hasTexts && applyTaskReply(s, awaiting, i, acks, actions, now, cfg);
  if (taskReply && i) {
    i = { ...i, task: null, extra_tasks: [], help_need: null, cancels_task: false };
  }

  // A yes or no to the question we asked last.
  let wantCall = false;
  let callDeclinedNow = false;
  if (hasTexts && i) {
    const refusesCall = i.refusals.some((r) => r.slot === "call");
    if (awaiting?.kind === "offer_call" || awaiting?.kind === "offer_callback") {
      if (i.reply_to_pending === "yes" || i.wants_call) wantCall = true;
      else if (i.reply_to_pending === "no" || refusesCall) callDeclinedNow = true;
    } else if (i.wants_call) {
      wantCall = true;
    }
    if (awaiting?.kind === "confirm_name") {
      const slot = s.slots[awaiting.slot];
      if (i.reply_to_pending === "yes" && slot.status === "tentative" && slot.value) {
        slot.status = "confirmed";
        slot.updatedAt = now;
        acks.push({ kind: "user_name_confirmed", value: slot.value });
      } else if (i.reply_to_pending === "no" && !i.user_name) {
        slot.status = "unknown";
        slot.value = null;
        slot.source = null;
      }
    }
    if (refusesCall && s.call.status === "ringing") callDeclinedNow = true;
    // "Yes" to "want me to start on X?" turns the finding (or the need) into a task.
    if (awaiting?.kind === "whats_first" && i.reply_to_pending === "yes") {
      const offered = awaiting.finding;
      const need = s.slots.help_need.value;
      if (offered && s.caps.tasks) {
        // An offer with no email follows a search that found nothing, so it does not search again.
        const aboutEmail = offered.threadId !== null;
        // A yes often restates the offer ("sí, ponme un recordatorio antes del plazo").
        // That is the same task, still tied to the offered email, with the user's words
        // as a note. Stress runs showed the restated task searching on its own and
        // quoting the wrong email. A different request ("draft the Adobe one too")
        // stays its own task.
        const restated = i.task && restatesOffer(i.task.summary, offered) ? i.task : null;
        const said = [restated?.summary, i.task_detail].filter((w): w is string => Boolean(w));
        const notes = said.map((w) => `When they said yes, they added: ${w}`);
        addTask(s, offered.next, aboutEmail, now, cfg, acks, offered.threadId, aboutEmail, notes);
        i = { ...i, task: restated ? null : i.task, task_detail: null };
      } else if (need && !i.task) {
        i = { ...i, task: { summary: need, needs_gmail: s.slots.gmail.status === "confirmed" } };
      }
    }
    // A no to an offered finding ends the offers. The findings stay in the thread.
    if (awaiting?.kind === "whats_first" && awaiting.finding && i.reply_to_pending === "no") {
      s.inbox.offersStopped = true;
    }
  }

  // 6. New values and corrections. Typed values are exact, so they are confirmed.
  // A message flagged as an injection attempt never writes names to the ledger.
  const corrected = new Set<SlotName>();
  if (hasTexts && i && !i.injection) {
    if (i.agent_name) {
      const blocked = i.offensive_names.includes("agent_name");
      applyNameClaim(
        s,
        "agent_name",
        i.agent_name.value,
        i.agent_name.correction,
        blocked,
        cfg,
        now,
        acks,
      );
      corrected.add("agent_name");
    } else if (i.let_agent_pick_name && s.slots.agent_name.status !== "confirmed") {
      const pick = cfg.nameIdeas[0] ?? cfg.defaultAgentName;
      setSlot(s.slots.agent_name, pick, "confirmed", "inferred", now);
      acks.push({ kind: "agent_name_picked", value: pick });
    }
    if (i.user_name) {
      const blocked = i.offensive_names.includes("user_name");
      applyNameClaim(
        s,
        "user_name",
        i.user_name.value,
        i.user_name.correction,
        blocked,
        cfg,
        now,
        acks,
      );
      corrected.add("user_name");
    }
    if (i.help_need) {
      const value = cleanHelpNeed(i.help_need, cfg.helpNeedMaxLength);
      const slot = s.slots.help_need;
      if (value && value.toLowerCase() !== slot.value?.toLowerCase()) {
        setSlot(slot, value, "confirmed", "text", now);
        acks.push({ kind: "help_need_set", value });
      }
    }
  }

  // A reply to a recap without a correction confirms the names we heard on the call.
  if (hasTexts && s.call.recapPending) {
    for (const name of ["agent_name", "user_name"] as const) {
      const slot = s.slots[name];
      if (slot.status === "tentative" && !corrected.has(name)) {
        slot.status = "confirmed";
        slot.updatedAt = now;
      }
    }
    s.call.recapPending = false;
  }

  // 7. Refusals. Soft refusals defer, hard ones and repeats decline.
  if (hasTexts && i) {
    for (const r of i.refusals) {
      if (r.slot === "call") {
        if (r.hard) s.call.declines = Math.max(s.call.declines, cfg.maxCallDeclines - 1);
        callDeclinedNow = true;
        continue;
      }
      if (s.slots[r.slot].status === "confirmed") continue;
      applyRefusal(s.slots[r.slot], r.hard);
      acks.push({ kind: "refusal", slot: r.slot, hard: r.hard });
    }
  }
  // No Gmail for now: a task that waited for it runs with what it has.
  if (s.slots.gmail.status === "declined" || s.slots.gmail.status === "deferred") {
    for (const t of s.tasks) if (t.status === "waiting_gmail") t.status = "open";
  }
  if (callDeclinedNow) {
    s.call.declines += 1;
    stopCall(s, actions);
    acks.push({ kind: "call_declined", final: s.call.declines >= cfg.maxCallDeclines });
    wantCall = false;
  }

  // "Never mind." A request and its take-back in one message never becomes a task.
  // On its own, it calls off the latest open task or pending reminder.
  if (hasTexts && i?.cancels_task) {
    if (i.task || i.extra_tasks.length > 0) {
      i = { ...i, task: null, extra_tasks: [] };
      acks.push({ kind: "task_canceled", reminder: false });
    } else {
      const ack = cancelLatest(s, actions);
      if (ack) acks.push(ack);
    }
  }

  // 8. Graduation: the user wants to skip ahead, or names a concrete task.
  if (hasTexts && i?.skip_setup && !s.graduated) {
    graduate(s);
    for (const name of ["agent_name", "user_name", "help_need", "gmail"] as const) {
      if (s.slots[name].status === "unknown") s.slots[name].status = "deferred";
    }
    acks.push({ kind: "skip_setup" });
  }
  if (hasTexts && i?.task) addTask(s, i.task.summary, i.task.needs_gmail, now, cfg, acks);
  for (const t of hasTexts ? (i?.extra_tasks ?? []) : []) {
    addTask(s, t.summary, t.needs_gmail, now, cfg, acks);
  }

  // 9. Direct questions get honest answers.
  if (hasTexts && i) {
    if (i.asks_if_ai) plan.answers.push({ kind: "is_ai" });
    if (i.asks_about_recording) plan.answers.push({ kind: "recording" });
    // The intro already says what Persona is and does.
    if (i.asks_capabilities && !plan.intro) plan.answers.push({ kind: "capabilities" });
    if (i.injection) plan.answers.push({ kind: "injection" });
    if (i.confused && !plan.intro) plan.answers.push({ kind: "confused" });
    // A question already covered above (or by the intro) is not answered twice.
    const covered = i.asks_if_ai || i.asks_about_recording || i.asks_capabilities || i.confused;
    if (i.other_question && !covered)
      plan.answers.push({ kind: "question", text: i.other_question });
    if (i.leaving) {
      acks.push({ kind: "leaving" });
      noChase = true;
    }
  }

  // 10. Slots whose ask budget ran out move down the ladder.
  const newlyDeferred = settleExhausted(s, cfg);
  if (newlyDeferred.includes("agent_name")) acks.push({ kind: "agent_name_deferred" });

  // A scan that failed gets another try when the user texts again.
  if (
    hasTexts &&
    s.slots.gmail.status === "confirmed" &&
    !s.inbox.scanning &&
    s.inbox.failures > 0 &&
    s.inbox.failures < cfg.maxScanFailures
  ) {
    s.inbox.scanning = true;
    actions.push({
      type: "scan_inbox",
      need: s.slots.help_need.value,
      source: s.inbox.source ?? "gmail",
    });
    acks.push({ kind: "rescanning" });
  }

  // 11. Place a call when the user said yes.
  let ringing = false;
  if (wantCall) {
    if (!s.caps.voice) {
      acks.push({ kind: "voice_unavailable" });
    } else if (s.call.answered >= cfg.maxCallsPerSession) {
      acks.push({ kind: "call_limit" });
    } else if (s.call.status === "idle") {
      startRinging(s, actions, now, cfg);
      acks.push({ kind: "calling_now" });
      ringing = true;
    }
  }

  // 12. Onboarding ends when every slot is settled.
  if (s.phase === "onboarding" && onboardingComplete(s)) {
    s.phase = "main";
    if (!s.graduated) acks.push({ kind: "finishing" });
  }

  // 13. At most one question per turn. A link the user asked for always goes out,
  // even past the ask budget or after an earlier no.
  const wantGmailLink =
    hasTexts && i?.wants_gmail_link === true && s.slots.gmail.status !== "confirmed";
  // A task starts when nothing else is running. Its result comes by text. A turn
  // that asks about a result ("Send it?") waits for the answer before the next one.
  if (!ringing && !taskQuestion) startNextTask(s, acks, actions);
  const working = s.tasks.some((t) => t.status === "working");
  if (taskQuestion?.kind === "task_info" && taskQuestion.quiet) {
    // The task asked this already. Wait for the answer, and ask nothing else meanwhile.
    s.awaiting = { question: { ...taskQuestion, quiet: false }, at: now };
  } else if (taskQuestion) {
    plan.question = taskQuestion;
    recordQuestion(s, taskQuestion, now);
  } else if (
    !ringing &&
    !(working && !wantGmailLink) &&
    (!noChase || wantGmailLink) &&
    s.call.status === "idle"
  ) {
    const question = pickQuestion(s, cfg, {
      wantCallback,
      wantGmailLink,
      nudge,
      typingFatigue: i?.typing_fatigue === true,
      tookBack: i?.cancels_task === true,
      // The link just went out during the call. Do not send it again in the recap.
      gmailJustSent: s.call.linkSentOnCall && notices.some((n) => n.kind === "call_ended"),
    });
    if (question) {
      plan.question = question;
      recordQuestion(s, question, now);
    }
  }
  if (nudge && plan.question) acks.push({ kind: "nudge" });

  // 14. In the main experience, anything unstructured gets a normal reply.
  if (s.phase === "main" && hasTexts && acks.length === 0 && plan.answers.length === 0) {
    plan.chat = true;
  }

  // 15. One gentle follow-up if the user goes quiet on an open ask.
  const nudgeable =
    plan.question !== null &&
    (plan.question.kind === "ask_slot" || plan.question.kind === "gmail_link") &&
    s.nudges < cfg.maxNudges;
  if (nudgeable) scheduleTimer(s, actions, "idle_nudge", now + cfg.idleNudgeMs);
  else cancelTimer(s, actions, "idle_nudge");

  // "Calling you now" is always the last thing said before the phone rings.
  plan.acks = [
    ...acks.filter((a) => a.kind !== "calling_now"),
    ...acks.filter((a) => a.kind === "calling_now"),
  ];
  return finish(s, plan, actions, cfg);
}

function finish(s: SessionState, plan: Plan, actions: Action[], cfg: BrainConfig): DecideOutput {
  plan.mode = s.phase === "main" ? "main" : "onboarding";
  plan.facts = planFacts(s, cfg);
  return { state: s, plan, actions };
}

function applyNameClaim(
  s: SessionState,
  name: "agent_name" | "user_name",
  raw: string,
  correction: boolean,
  blocked: boolean,
  cfg: BrainConfig,
  now: number,
  acks: Ack[],
): void {
  if (blocked) {
    acks.push({ kind: "name_blocked", slot: name });
    return;
  }
  const max = name === "agent_name" ? cfg.agentNameMaxLength : cfg.userNameMaxLength;
  const check = checkName(raw, max);
  if (!check.ok) {
    if (check.reason === "too_long") acks.push({ kind: "name_too_long", slot: name });
    return;
  }
  const slot = s.slots[name];
  if (slot.value === check.value && slot.status === "confirmed") return;
  // The same name heard on a call, now typed: confirm it quietly. It is not a correction.
  if (slot.value?.toLowerCase() === check.value.toLowerCase()) {
    setSlot(slot, check.value, "confirmed", "text", now);
    return;
  }
  const isCorrection = correction || (slot.value !== null && slot.value !== check.value);
  setSlot(slot, check.value, "confirmed", "text", now);
  acks.push(
    name === "agent_name"
      ? { kind: "agent_name_set", value: check.value, correction: isCorrection }
      : { kind: "user_name_set", value: check.value, correction: isCorrection },
  );
}

function graduate(s: SessionState): void {
  s.graduated = true;
  if (s.phase === "onboarding") s.phase = "main";
}

/**
 * A concrete task graduates the user. With the task service, it runs when
 * nothing else is running. Without it, the agent says plainly it cannot.
 */
function addTask(
  s: SessionState,
  rawSummary: string,
  needsGmail: boolean,
  now: number,
  cfg: BrainConfig,
  acks: Ack[],
  threadId: string | null = null,
  search = true,
  notes: string[] = [],
): void {
  const summary = cleanHelpNeed(rawSummary, cfg.helpNeedMaxLength);
  if (!summary) return;
  const same = (t: { summary: string }) => t.summary.toLowerCase() === summary.toLowerCase();
  if (s.tasks.some((t) => same(t) && isActive(t))) return;
  // Stress run: "yes please start canceling the NYT trial", a few texts after the
  // offer, searched on its own, missed the NYT email, and never got a draft.
  const finding = threadId === null && search ? findingFor(s, summary) : null;
  const task = newTask(s, summary, needsGmail, now, finding?.threadId ?? threadId, search);
  task.notes.push(...notes);
  s.tasks.push(task);
  if (s.slots.help_need.status !== "confirmed") {
    setSlot(s.slots.help_need, summary, "confirmed", "text", now);
  }
  graduate(s);
  // The task says the same thing as a help need set from it, so say it once.
  const dup = acks.findIndex((a) => a.kind === "help_need_set" && same({ summary: a.value }));
  if (dup >= 0) acks.splice(dup, 1);
  // With the task service, "On it" comes when the task starts running.
  if (!s.caps.tasks) acks.push({ kind: "task_started", summary, needsGmail });
}

export function onboardingComplete(s: SessionState): boolean {
  const { agent_name, user_name, help_need, gmail } = s.slots;
  const settled = (st: string) => st !== "unknown";
  return (
    settled(agent_name.status) &&
    settled(user_name.status) &&
    settled(help_need.status) &&
    (settled(gmail.status) || !s.caps.gmail)
  );
}

interface PickContext {
  wantCallback: boolean;
  wantGmailLink: boolean;
  nudge: boolean;
  typingFatigue: boolean;
  gmailJustSent: boolean;
  /** The user just took a request back. */
  tookBack: boolean;
}

function pickQuestion(s: SessionState, cfg: BrainConfig, ctx: PickContext): Question | null {
  const { agent_name, user_name, help_need, gmail } = s.slots;

  if (ctx.wantCallback && s.caps.voice && s.call.declines < cfg.maxCallDeclines) {
    return { kind: "offer_callback" };
  }

  if (ctx.wantGmailLink && s.caps.gmail) return { kind: "gmail_link", variant: "requested" };

  if (s.inbox.scanning) return null;

  if (s.phase === "main") {
    // "Never mind" asks for less. Stress run: "okay, i won't send that reminder"
    // came with "want me to start on setting a reminder for hotel check-in?".
    if (ctx.tookBack) return null;
    // Collect a missing slot only when a task needs it.
    const needsGmail = s.tasks.some((t) => t.status === "waiting_gmail");
    if (
      needsGmail &&
      !ctx.gmailJustSent &&
      s.caps.gmail &&
      gmail.status !== "confirmed" &&
      canAsk(gmail, cfg, true)
    ) {
      return { kind: "gmail_link", variant: gmailVariant(gmail) };
    }
    if (ctx.nudge) return null;
    // An unnamed agent asks once more, casually, after a few turns of real use.
    const unnamed = agent_name.status === "unknown" || agent_name.status === "deferred";
    if (unnamed && !agent_name.retryUsed && s.turnsInMain >= cfg.agentNameRetryAfterTurns) {
      return { kind: "ask_slot", slot: "agent_name", variant: "retry" };
    }
    const offer = nextFindingOffer(s);
    if (offer) return { kind: "whats_first", finding: offer };
    if (!s.askedWhatsFirst && s.tasks.length === 0) return { kind: "whats_first" };
    return null;
  }

  if (agent_name.status === "unknown" && canAsk(agent_name, cfg, false)) {
    return {
      kind: "ask_slot",
      slot: "agent_name",
      variant: agent_name.attempts === 0 ? "first" : "ideas",
    };
  }
  if (
    user_name.status === "tentative" &&
    user_name.source === "google_profile" &&
    user_name.value
  ) {
    if (user_name.attempts < cfg.maxAsks) {
      return { kind: "confirm_name", slot: "user_name", value: user_name.value };
    }
  }
  if (
    !ctx.nudge &&
    callOfferAllowed(s, cfg, ctx.typingFatigue) &&
    (user_name.status === "unknown" || help_need.status === "unknown")
  ) {
    return { kind: "offer_call", variant: s.call.autoOffers === 0 ? "first" : "again" };
  }
  if (user_name.status === "unknown" && canAsk(user_name, cfg, false)) {
    return {
      kind: "ask_slot",
      slot: "user_name",
      variant: user_name.attempts === 0 ? "first" : "again",
    };
  }
  if (help_need.status === "unknown" && canAsk(help_need, cfg, false)) {
    return {
      kind: "ask_slot",
      slot: "help_need",
      variant: help_need.attempts === 0 ? "first" : "again",
    };
  }
  if (
    s.caps.gmail &&
    gmail.status === "unknown" &&
    !ctx.gmailJustSent &&
    canAsk(gmail, cfg, false)
  ) {
    return { kind: "gmail_link", variant: gmailVariant(gmail) };
  }
  return null;
}

/**
 * The next inbox finding to offer as a task: one the user has not started
 * or been offered, while nothing else is going on. The first offer follows
 * the text that showed the finding. Later ones say their fact.
 */
function nextFindingOffer(s: SessionState): OfferedFinding | null {
  if (!s.caps.tasks || s.inbox.offersStopped || s.tasks.some(isActive)) return null;
  const used = new Set(s.tasks.map((t) => t.threadId));
  const f = s.inbox.findings.find(
    (x) => x.threadId && x.next && !used.has(x.threadId) && !s.inbox.offered.includes(x.threadId),
  );
  if (!f) return null;
  const shown = f === s.inbox.findings[0] && s.inbox.offered.length === 0;
  return { threadId: f.threadId, next: f.next, fact: shown ? null : f.fact };
}

function gmailVariant(slot: SessionState["slots"]["gmail"]): "first" | "again" | "retry" {
  if (slot.status === "deferred") return "retry";
  return slot.attempts === 0 ? "first" : "again";
}

/**
 * The brain offers a call once on its own. It offers a second time only when
 * the user shows typing fatigue, and never after two declines or after a call
 * already happened. The user can always ask for a call.
 */
function callOfferAllowed(s: SessionState, cfg: BrainConfig, typingFatigue: boolean): boolean {
  const c = s.call;
  if (!s.caps.voice || c.status !== "idle" || c.answered > 0 || c.missed > 0) return false;
  if (c.declines >= cfg.maxCallDeclines || c.autoOffers >= cfg.maxAutoCallOffers) return false;
  if (c.autoOffers === 0 && c.declines === 0) return true;
  return typingFatigue;
}

function recordQuestion(s: SessionState, q: Question, now: number): void {
  switch (q.kind) {
    case "ask_slot":
      recordAsk(s.slots[q.slot]);
      if (q.variant === "retry") s.slots[q.slot].retryUsed = true;
      break;
    case "gmail_link":
      recordAsk(s.slots.gmail);
      break;
    case "confirm_name":
      recordAsk(s.slots[q.slot]);
      break;
    case "offer_call":
      s.call.autoOffers += 1;
      break;
    case "whats_first":
      s.askedWhatsFirst = true;
      if (q.finding) s.inbox.offered.push(offerKey(q.finding));
      break;
    case "offer_callback":
    case "confirm_send":
    case "task_info":
      break;
  }
  s.awaiting = { question: q, at: now };
}

function startRinging(s: SessionState, actions: Action[], now: number, cfg: BrainConfig): void {
  const callId = `${s.id}-call-${s.call.answered + s.call.missed + s.call.declines + 1}-${now}`;
  s.call.status = "ringing";
  s.call.callId = callId;
  actions.push({ type: "ring_phone", callId, callerName: agentDisplayName(s, cfg) });
  scheduleTimer(s, actions, "ring_timeout", now + cfg.ringTimeoutMs);
}

function stopCall(s: SessionState, actions: Action[]): void {
  if (s.call.status === "idle" || !s.call.callId) return;
  actions.push({ type: "end_call", callId: s.call.callId });
  cancelTimer(s, actions, "ring_timeout");
  s.call.status = "idle";
}

function updateCasing(s: SessionState, texts: PendingText[]): void {
  const letters = texts
    .map((t) => t.text)
    .join("")
    .replace(/[^\p{L}]/gu, "");
  if (letters.length < 4) return;
  s.casing = letters === letters.toLowerCase() ? "lower" : "normal";
}

function trimHistory(s: SessionState, cfg: BrainConfig): void {
  if (s.history.length > cfg.historyLimit) s.history.splice(0, s.history.length - cfg.historyLimit);
}

export function planFacts(s: SessionState, cfg: BrainConfig): Plan["facts"] {
  const slot = (name: SlotName) => {
    const v = s.slots[name];
    return v.status === "confirmed" || v.status === "tentative" ? v.value : null;
  };
  return {
    agentName: s.slots.agent_name.value ? agentDisplayName(s, cfg) : null,
    userName: slot("user_name"),
    helpNeed: slot("help_need"),
    gmail: slot("gmail"),
    openTask: s.tasks.find((t) => t.status !== "done")?.summary ?? null,
    canRunTasks: s.caps.tasks === true,
    anyTask: s.tasks.length > 0,
    inboxFindings: s.inbox.findings.map((f) => f.fact),
    sampleInbox: s.inbox.source === "demo",
    inboxStatus: s.inbox.scanning
      ? "scanning"
      : s.inbox.failures > 0
        ? "failed"
        : s.inbox.scannedAt !== null
          ? "scanned"
          : "none",
    voice: s.caps.voice,
    gmailAvailable: s.caps.gmail,
    language: s.language,
    casing: s.casing,
    timeZone: s.timeZone,
  };
}
