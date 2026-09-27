// Runs tasks when the brain asks. The work happens outside the session queue,
// and the result goes back to the brain as an event. One quiet retry covers a
// slow model or a Gmail hiccup. A lost token is not retried.

import type { Action, TaskJob } from "../brain/types.ts";
import type { InboxService } from "../inbox/service.ts";
import { InboxAuthError } from "../inbox/types.ts";
import type { LlmClient } from "../llm/openai.ts";
import type { Hub } from "../runtime/hub.ts";
import { runWork } from "./work.ts";

const RETRY_DELAY_MS = 1000;

export interface TaskServiceOptions {
  hub: Hub;
  inbox: InboxService;
  llm: LlmClient;
  /** Writes results and drafts. */
  model: string;
  /** Picks the email. */
  fastModel: string;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export class TaskService {
  private readonly opts: TaskServiceOptions;
  private readonly running = new Set<Promise<void>>();

  constructor(opts: TaskServiceOptions) {
    this.opts = opts;
  }

  onAction(sessionId: string, action: Action): void {
    if (action.type === "simulated_send") {
      // Nothing is sent. The log shows what would have gone out.
      this.opts.log.info(
        { sessionId, taskId: action.taskId, to: action.draft.to, subject: action.draft.subject },
        "simulated send",
      );
      return;
    }
    if (action.type !== "run_task") return;
    const job = this.run(sessionId, action.taskId, action.job).finally(() =>
      this.running.delete(job),
    );
    this.running.add(job);
  }

  /** Resolves when no task is running. Tests and the stress harness wait on it. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private async run(sessionId: string, taskId: number, job: TaskJob): Promise<void> {
    const { hub, inbox, log } = this.opts;
    const provider = job.inbox ? inbox.providerFor(sessionId, job.inbox) : null;
    if (job.inbox && !provider) {
      inbox.forget(sessionId);
      await hub.dispatch(sessionId, { type: "task_failed", taskId, reason: "auth" });
      return;
    }
    const attempt = () =>
      runWork(
        { ...job, now: hub.now(sessionId) },
        { provider, llm: this.opts.llm, model: this.opts.model, fastModel: this.opts.fastModel },
      );
    try {
      const out = await attempt().catch(async (err: unknown) => {
        if (err instanceof InboxAuthError) throw err;
        log.warn(
          { sessionId, taskId, err: err instanceof Error ? err.message : String(err) },
          "task failed, retrying once",
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        return attempt();
      });
      log.info(
        { sessionId, taskId, kind: out.result.kind, thread: out.threadId, ms: Math.round(out.ms) },
        "task done",
      );
      await hub.dispatch(sessionId, {
        type: "task_done",
        taskId,
        result: out.result,
        threadId: out.threadId,
        ms: Math.round(out.ms),
      });
    } catch (err) {
      const auth = err instanceof InboxAuthError;
      if (auth) inbox.forget(sessionId);
      log.warn(
        { sessionId, taskId, auth, err: err instanceof Error ? err.message : String(err) },
        "task failed",
      );
      await hub.dispatch(sessionId, {
        type: "task_failed",
        taskId,
        reason: auth ? "auth" : "error",
      });
    }
  }
}
