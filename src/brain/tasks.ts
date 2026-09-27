// The task loop, as pure functions over a draft of the session state. The task
// service does the work and the result comes back as a notice. A draft waits
// for the user's yes, a question waits for their answer, and a reminder waits
// for its timer. Nothing outward happens without a yes, and sending is
// simulated.

import type { BrainConfig } from "./config.ts";
import { newTask } from "./ledger.ts";
import { cancelTimer, scheduleTimer } from "./timers.ts";
import type {
  Ack,
  Action,
  Draft,
  Interpretation,
  Notice,
  OfferedFinding,
  Question,
  SessionState,
  Task,
  TaskJob,
  TaskStatus,
} from "./types.ts";

/** Tasks the user is still waiting on. A finished, dropped, or failed task can start again. */
const ACTIVE: ReadonlySet<TaskStatus> = new Set([
  "open",
  "waiting_gmail",
  "working",
  "needs_yes",
  "needs_info",
]);

export function isActive(task: Task): boolean {
  return ACTIVE.has(task.status);
}

/** How an offer is remembered: by its email, or by its words when it has none. */
export function offerKey(o: { threadId: string | null; next: string }): string {
  return o.threadId ?? `next:${o.next.toLowerCase()}`;
}

export function reminderTimerId(taskId: number): string {
  return `reminder-${taskId}`;
}

export function taskIdOfReminder(timerId: string): number | null {
  const m = timerId.match(/^reminder-(\d+)$/);
  return m ? Number(m[1]) : null;
}

function find(s: SessionState, taskId: number): Task | undefined {
  return s.tasks.find((t) => t.id === taskId);
}

function run(s: SessionState, task: Task, actions: Action[], previous: Draft | null): void {
  task.status = "working";
  task.runs += 1;
  const gmail = s.slots.gmail;
  const name = s.slots.user_name;
  const job: TaskJob = {
    summary: task.summary,
    threadId: task.threadId,
    notes: [...task.notes],
    previous,
    search: task.search,
    avoid: [...task.avoid],
    shown: [
      ...new Set([
        ...s.inbox.findings.map((f) => f.threadId),
        ...s.tasks.flatMap((t) => (t.result?.receipt ? [t.result.receipt.threadId] : [])),
      ]),
    ].filter(Boolean),
    inbox: gmail.status !== "confirmed" ? null : gmail.source === "sample_inbox" ? "demo" : "gmail",
    userName: name.status === "confirmed" || name.status === "tentative" ? name.value : null,
    userEmail: gmail.status === "confirmed" && gmail.source !== "sample_inbox" ? gmail.value : null,
    language: s.language,
    timeZone: s.timeZone,
  };
  actions.push({ type: "run_task", taskId: task.id, job });
}

/** Start the next open task, one at a time. Never during a call: the result comes by text. */
export function startNextTask(s: SessionState, acks: Ack[], actions: Action[]): void {
  if (!s.caps.tasks || s.call.status !== "idle") return;
  if (s.tasks.some((t) => t.status === "working")) return;
  const task = s.tasks.find((t) => t.status === "open");
  if (!task) return;
  run(s, task, actions, null);
  const next = acks.some((a) => a.kind === "task_result" || a.kind === "draft_sent");
  acks.push({ kind: "task_started", summary: task.summary, needsGmail: task.needsGmail, next });
}

/**
 * A task result, failure, or due reminder. Returns the question the result
 * asks ("Send it?", or the task's own question), which beats any other ask.
 */
export function applyTaskNotice(
  s: SessionState,
  n: Notice,
  acks: Ack[],
  actions: Action[],
): Question | null {
  switch (n.kind) {
    case "task_result": {
      const task = find(s, n.taskId);
      const r = task?.result;
      if (!task || !r || task.status !== "working") return null;
      // A task never asks the same thing twice. In a stress run, a user who did not
      // know the restaurant yet got the same question four times. The first ask
      // stands, so the brain waits for its answer and sends nothing.
      if (r.kind === "question" && task.asked.some((q) => sameQuestion(q, r.text))) {
        task.status = "needs_info";
        return { kind: "task_info", taskId: task.id, text: r.text, quiet: true };
      }
      if (r.kind === "question") task.asked.push(r.text);
      acks.push({ kind: "task_result", taskId: task.id, result: r });
      switch (r.kind) {
        case "draft":
          task.status = "needs_yes";
          return { kind: "confirm_send", taskId: task.id };
        case "question":
          task.status = "needs_info";
          return { kind: "task_info", taskId: task.id, text: r.text };
        case "remind":
          task.status = "done";
          s.reminders.push({ taskId: task.id, at: r.at, text: r.text, sent: false });
          scheduleTimer(s, actions, "reminder", r.at, reminderTimerId(task.id));
          return null;
        case "answer":
          task.status = "done";
          // One follow-up on an email in the answer, offered like an inbox finding.
          if (r.offer && !s.inbox.offersStopped && !s.inbox.offered.includes(offerKey(r.offer))) {
            return {
              kind: "whats_first",
              finding: { threadId: r.offer.threadId, next: r.offer.next, fact: null },
            };
          }
          return null;
        case "cannot":
          task.status = "done";
          return null;
      }
      return null;
    }
    case "task_failed": {
      const task = find(s, n.taskId);
      if (task?.status !== "working") return null;
      // A lost token sends the task back to wait for a fresh Gmail connect.
      task.status = n.reason === "auth" ? "waiting_gmail" : "failed";
      acks.push({ kind: "task_failed", summary: task.summary, reason: n.reason });
      return null;
    }
    case "reminder_due": {
      const reminder = s.reminders.find((r) => r.taskId === n.taskId && !r.sent && !r.canceled);
      if (!reminder) return null;
      reminder.sent = true;
      acks.push({ kind: "reminder", text: reminder.text });
      return null;
    }
    default:
      return null;
  }
}

/**
 * The user's reply to a draft or to a task question. Returns true when the
 * reply was about the task, so nothing else reads it as a new request.
 */
export function applyTaskReply(
  s: SessionState,
  awaiting: Question | null,
  i: Interpretation | null,
  acks: Ack[],
  actions: Action[],
  now: number,
  cfg: BrainConfig,
): boolean {
  if (!i || !awaiting) return false;
  if (awaiting.kind === "confirm_send") {
    const task = find(s, awaiting.taskId);
    if (task?.status !== "needs_yes" || task.result?.kind !== "draft") return false;
    const draft = task.result.draft;
    // "That's for my dentist, I meant Planet Fitness." A redraft of the same email
    // cannot fix that. Stress run: four redrafts in a row went back to the dentist.
    if (i.wrong_target) {
      task.status = "dropped";
      const from = task.result.receipt?.from ?? draft.to;
      const again = newTask(s, task.summary, task.needsGmail, now, null, true);
      again.notes.push(
        ...task.notes,
        `The last draft used the wrong email (from ${from}). They mean: ${i.wrong_target}`,
        ...(i.draft_edit ? [`Change the draft: ${i.draft_edit}`] : []),
      );
      again.avoid.push(...task.avoid, ...(draft.threadId ? [draft.threadId] : []));
      s.tasks.push(again);
      acks.push({ kind: "task_retarget" });
      return true;
    }
    // "Yes, but make it shorter" is an edit, not a yes.
    if (i.draft_edit) {
      if (task.runs >= cfg.maxTaskRuns) {
        task.status = "dropped";
        acks.push({ kind: "task_limit" });
        return true;
      }
      task.notes.push(`Change the draft: ${i.draft_edit}`);
      run(s, task, actions, draft);
      acks.push({ kind: "task_redraft" });
      return true;
    }
    if (i.reply_to_pending === "yes") {
      task.status = "done";
      s.outbox.push({ taskId: task.id, draft, at: now });
      actions.push({ type: "simulated_send", taskId: task.id, draft });
      acks.push({ kind: "draft_sent", to: draft.to });
      return true;
    }
    if (i.reply_to_pending === "no") {
      task.status = "dropped";
      acks.push({ kind: "draft_dropped" });
      return true;
    }
    return false;
  }
  if (awaiting.kind === "task_info") {
    const task = find(s, awaiting.taskId);
    if (task?.status !== "needs_info") return false;
    const answer =
      i.task_detail ??
      (i.reply_to_pending === "yes" ? "yes" : i.reply_to_pending === "no" ? "no" : null);
    if (!answer) return false;
    if (task.runs >= cfg.maxTaskRuns) {
      task.status = "dropped";
      acks.push({ kind: "task_limit" });
      return true;
    }
    task.notes.push(`You asked "${awaiting.text}" They said: ${answer}`);
    // They just answered, and the result is seconds away: "Got it." and nothing else.
    // Stress run: a free reply here said "i can't set a reminder for tomorrow", and the
    // reminder came through right after.
    run(s, task, actions, null);
    acks.push({ kind: "task_resumed" });
    return true;
  }
  return false;
}

/**
 * "Never mind": call off the latest task that is still open, or whose reminder
 * has not gone out yet. A pending reminder's timer is canceled, so "I won't
 * remind you" stays true. A result that arrives later is ignored.
 */
export function cancelLatest(s: SessionState, actions: Action[]): Ack | null {
  const unsent = (taskId: number) =>
    s.reminders.find((r) => r.taskId === taskId && !r.sent && !r.canceled);
  const target = [...s.tasks].reverse().find((t) => isActive(t) || unsent(t.id));
  if (!target) return null;
  const reminder = unsent(target.id);
  if (reminder) {
    reminder.canceled = true;
    cancelTimer(s, actions, reminderTimerId(target.id));
  }
  target.status = "dropped";
  return { kind: "task_canceled", reminder: reminder !== undefined };
}

/** Words that carry no meaning of their own in a question. */
const FILLER = new Set(
  "what which whom when where should would could does your their them they with want like that this have need please about there".split(
    " ",
  ),
);

/** Words that say what to do, not what it is about. Tasks share them freely. */
const ACTIONS = new Set(
  "cancel canceling cancelling cancellation setting reminder remind reminding drafting draft reply replying finding find sending send confirming confirm checking check asking email note message before after free ends deadline date time today tomorrow week soon hour hours days plazo".split(
    " ",
  ),
);

function keyWords(text: string, skip: Set<string> = FILLER): Set<string> {
  const plain = text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  return new Set(
    (plain.match(/\p{L}+/gu) ?? []).filter((w) => w.length > 3 && !FILLER.has(w) && !skip.has(w)),
  );
}

/** The share of the shorter text's key words that the other text also has, 0 to 1. */
function overlap(a: string, b: string, skip: Set<string> = FILLER): number {
  const x = keyWords(a, skip);
  const y = keyWords(b, skip);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
}

/**
 * Two questions ask for the same thing when most key words of the shorter one
 * are in the other. "Which restaurant should I address it to?" repeats "What
 * restaurant, date, and party size should I include?", but "What date are you
 * moving out?" does not repeat "Are you staying or moving out?".
 */
export function sameQuestion(a: string, b: string): boolean {
  if (keyWords(a).size === 0 || keyWords(b).size === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return overlap(a, b) >= 0.6;
}

/**
 * The inbox finding a stated task is about, when one clearly matches: "canceling
 * the NYT trial" is "canceling the New York Times free trial". Only the words about
 * the thing count, not the action ("setting a reminder" matches many findings).
 * Two equally good matches mean the task is not clear, so neither is picked.
 */
export function findingFor(
  s: SessionState,
  summary: string,
): SessionState["inbox"]["findings"][number] | null {
  const scored = s.inbox.findings
    .filter((f) => f.threadId)
    .map((f) => ({ f, score: overlap(summary, `${f.next} ${f.fact}`, ACTIONS) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || (second && second.score === best.score)) return null;
  return best.f;
}

/**
 * A task stated with a yes to an offer restates the offer, or asks for something
 * else. "Remind me before the deadline" restates a Marriott offer. "Draft the
 * Adobe cancellation too" is its own task. A task that names no thing at all
 * can only be about the offer.
 */
export function restatesOffer(summary: string, offer: OfferedFinding): boolean {
  if (keyWords(summary, ACTIONS).size === 0) return true;
  return overlap(summary, `${offer.next} ${offer.fact ?? ""}`, ACTIONS) >= 0.5;
}
