// Timers live in the session state, so they survive a restart. The hub turns
// these actions into real (or fake-clock) timers.

import type { Action, SessionState, TimerKind } from "./types.ts";

/** Set a timer. Most kinds have one timer each, so the kind is the id. */
export function scheduleTimer(
  s: SessionState,
  actions: Action[],
  kind: TimerKind,
  fireAt: number,
  timerId: string = kind,
): void {
  s.timers[timerId] = { kind, fireAt };
  actions.push({ type: "schedule_timer", timerId, kind, fireAt });
}

export function cancelTimer(s: SessionState, actions: Action[], timerId: string): void {
  if (!s.timers[timerId]) return;
  delete s.timers[timerId];
  actions.push({ type: "cancel_timer", timerId });
}
