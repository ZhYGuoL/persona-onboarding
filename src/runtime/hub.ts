// The session hub. It owns one serial queue per session, persists state and
// the event log, arms timers on the injectable clock, and runs turn jobs.
// Channel adapters (WebSocket, the stress harness) subscribe to its output.

import type { Brain, TurnJob } from "../brain/brain.ts";
import { newSession } from "../brain/ledger.ts";
import type { Action, BrainEvent, Capabilities, SessionState, TimerKind } from "../brain/types.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import type { LogDir, LogEntry, SessionRow, Store } from "./store.ts";

export type HubMessage =
  | { type: "action"; sessionId: string; action: Action; entry: LogEntry }
  | { type: "log"; sessionId: string; entry: LogEntry }
  | { type: "state"; sessionId: string; state: SessionState; now: number };

export type HubListener = (msg: HubMessage) => void;

export interface HubOptions {
  store: Store;
  clock: Clock;
  brain: Brain;
  defaultCaps: Capabilities;
  onError?: (err: unknown, sessionId: string) => void;
}

export class Hub {
  private readonly opts: HubOptions;
  private readonly rows = new Map<string, SessionRow>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly listeners = new Map<string, Set<HubListener>>();
  private readonly globalListeners = new Set<HubListener>();
  /** Extra delay before a turn's result lands, per session. The reviewer panel uses it to simulate lag. */
  private readonly lag = new Map<string, number>();
  private inflight = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(opts: HubOptions) {
    this.opts = opts;
  }

  /** Session time: the real clock plus the session's fast-forward offset. */
  now(sessionId: string): number {
    return this.opts.clock.now() + this.row(sessionId).clockOffsetMs;
  }

  state(sessionId: string): SessionState {
    return this.row(sessionId).state;
  }

  log(sessionId: string): LogEntry[] {
    return this.opts.store.events(sessionId);
  }

  subscribe(sessionId: string, fn: HubListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Listen to every session. The voice adapter uses this for call actions. */
  subscribeAll(fn: HubListener): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  setLag(sessionId: string, ms: number): void {
    if (ms > 0) this.lag.set(sessionId, ms);
    else this.lag.delete(sessionId);
  }

  getLag(sessionId: string): number {
    return this.lag.get(sessionId) ?? 0;
  }

  /** Queue an event. Events for one session run one at a time, in order. */
  dispatch(sessionId: string, ev: BrainEvent, logExtra?: Record<string, unknown>): Promise<void> {
    return this.enqueue(sessionId, () => this.process(sessionId, ev, logExtra));
  }

  /** Move this session's clock forward. Due timers fire in order. */
  fastForward(sessionId: string, ms: number): Promise<void> {
    return this.enqueue(sessionId, () => {
      const row = this.row(sessionId);
      row.clockOffsetMs += ms;
      const now = this.now(sessionId);
      this.opts.store.save(row.state, row.clockOffsetMs, now);
      this.record(sessionId, now, "note", "fast_forward", { ms });
      this.armAll(sessionId);
      this.emit(sessionId, { type: "state", sessionId, state: row.state, now });
    });
  }

  /** Re-arm timers for persisted sessions after a restart. */
  restore(): number {
    const ids = this.opts.store.sessionsWithTimers();
    for (const id of ids) this.armAll(id);
    return ids.length;
  }

  /** Resolves when no events or turn jobs are pending. */
  async settle(): Promise<void> {
    while (this.inflight > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private enqueue(sessionId: string, task: () => void): Promise<void> {
    this.inflight += 1;
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => this.opts.onError?.(err, sessionId))
      .finally(() => this.release());
    this.queues.set(sessionId, next);
    return next;
  }

  private release(): void {
    this.inflight -= 1;
    if (this.inflight === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private row(sessionId: string): SessionRow {
    let row = this.rows.get(sessionId);
    if (!row) {
      row = this.opts.store.load(sessionId) ?? {
        state: newSession(sessionId, this.opts.clock.now(), this.opts.defaultCaps),
        clockOffsetMs: 0,
      };
      this.rows.set(sessionId, row);
    }
    return row;
  }

  private process(sessionId: string, ev: BrainEvent, logExtra?: Record<string, unknown>): void {
    const row = this.row(sessionId);
    const now = this.now(sessionId);
    if (ev.type === "turn_ready") {
      this.record(sessionId, now, "note", "turn_ready", { turnId: ev.turnId });
    } else {
      this.record(sessionId, now, "in", ev.type, { ...eventPayload(ev), ...logExtra });
    }
    const step = this.opts.brain.handle(row.state, ev, now);
    row.state = step.state;
    this.opts.store.save(row.state, row.clockOffsetMs, now);
    for (const note of step.notes) this.record(sessionId, now, "note", note.type, note.data);
    for (const action of step.actions) this.perform(sessionId, action, now);
    for (const job of step.jobs) this.runJob(sessionId, job);
    this.emit(sessionId, { type: "state", sessionId, state: row.state, now });
  }

  private perform(sessionId: string, action: Action, now: number): void {
    if (action.type === "schedule_timer") {
      this.arm(sessionId, action.timerId, action.kind, action.fireAt);
    } else if (action.type === "cancel_timer") {
      this.disarm(sessionId, action.timerId);
    }
    const { type, ...payload } = action;
    const entry = this.record(sessionId, now, "out", type, payload);
    this.emit(sessionId, { type: "action", sessionId, action, entry });
  }

  private runJob(sessionId: string, job: TurnJob): void {
    this.inflight += 1;
    const lag = this.lag.get(sessionId) ?? 0;
    job
      .run()
      .then(async (ev) => {
        if (lag > 0) await new Promise((resolve) => setTimeout(resolve, lag));
        return this.dispatch(sessionId, ev);
      })
      .catch((err) => this.opts.onError?.(err, sessionId))
      .finally(() => this.release());
  }

  private arm(sessionId: string, timerId: string, kind: TimerKind, fireAt: number): void {
    this.disarm(sessionId, timerId);
    const key = `${sessionId}:${timerId}`;
    const handle = this.opts.clock.setTimeout(() => {
      this.timers.delete(key);
      void this.dispatch(sessionId, { type: "timer_fired", timerId, kind });
    }, fireAt - this.now(sessionId));
    this.timers.set(key, handle);
  }

  private disarm(sessionId: string, timerId: string): void {
    const key = `${sessionId}:${timerId}`;
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }

  private armAll(sessionId: string): void {
    const entries = Object.entries(this.row(sessionId).state.timers).sort(
      (a, b) => a[1].fireAt - b[1].fireAt,
    );
    for (const [timerId, t] of entries) this.arm(sessionId, timerId, t.kind, t.fireAt);
  }

  private record(
    sessionId: string,
    ts: number,
    dir: LogDir,
    type: string,
    payload: unknown,
  ): LogEntry {
    const entry = this.opts.store.append(sessionId, { ts, dir, type, payload });
    if (dir !== "out") this.emit(sessionId, { type: "log", sessionId, entry });
    return entry;
  }

  private emit(sessionId: string, msg: HubMessage): void {
    const set = this.listeners.get(sessionId);
    for (const fn of [...this.globalListeners, ...(set ?? [])]) {
      try {
        fn(msg);
      } catch (err) {
        this.opts.onError?.(err, sessionId);
      }
    }
  }
}

function eventPayload(ev: BrainEvent): Record<string, unknown> {
  const { type: _type, ...rest } = ev;
  return rest;
}
