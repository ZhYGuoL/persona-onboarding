// The task loop, as pure functions over a draft of the session state. The task
// service does the work and the result comes back as a notice. A draft waits
// for the user's yes, a question waits for their answer, and a reminder waits
// for its timer. Nothing outward happens without a yes, and sending is
// simulated.

import type { BrainConfig } from "./config.ts";
import { scheduleTimer } from "./timers.ts";
import type {
  Ack,
  Action,
  Draft,
  Interpretation,
  Notice,
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
  acks.push({ kind: "task_started", summary: task.summary, needsGmail: task.needsGmail });
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
      const reminder = s.reminders.find((r) => r.taskId === n.taskId && !r.sent);
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
    run(s, task, actions, null);
    acks.push({
      kind: "task_started",
      summary: task.summary,
      needsGmail: task.needsGmail,
      again: true,
    });
    return true;
  }
  return false;
}
