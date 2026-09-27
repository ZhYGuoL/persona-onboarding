// The slot ledger: slot status transitions and the ask budget. Pure functions
// over a mutable draft of the session state.

import type { BrainConfig } from "./config.ts";
import type {
  Capabilities,
  SessionState,
  Slot,
  SlotName,
  SlotSource,
  SlotStatus,
} from "./types.ts";
import { SLOT_NAMES } from "./types.ts";

export function emptySlot(): Slot {
  return {
    status: "unknown",
    value: null,
    attempts: 0,
    source: null,
    retryUsed: false,
    updatedAt: null,
  };
}

export function newSession(id: string, now: number, caps: Capabilities): SessionState {
  return {
    id,
    createdAt: now,
    phase: "onboarding",
    phaseBeforeOptOut: null,
    graduated: false,
    introduced: false,
    slots: {
      agent_name: emptySlot(),
      user_name: emptySlot(),
      gmail: emptySlot(),
      help_need: emptySlot(),
    },
    call: {
      status: "idle",
      callId: null,
      autoOffers: 0,
      declines: 0,
      missed: 0,
      answered: 0,
      startedAt: null,
      lastEnd: null,
      captured: [],
      recapPending: false,
      linkSentOnCall: false,
    },
    caps: { ...caps },
    awaiting: null,
    pending: { texts: [], notices: [] },
    turn: { seq: 0, inFlight: null, committed: 0 },
    timers: {},
    language: "en",
    casing: "normal",
    tasks: [],
    history: [],
    lastUserAt: null,
    lastAgentAt: null,
    nudges: 0,
    askedWhatsFirst: false,
    turnsInMain: 0,
  };
}

export function setSlot(
  slot: Slot,
  value: string,
  status: SlotStatus,
  source: SlotSource,
  now: number,
): void {
  slot.value = value;
  slot.status = status;
  slot.source = source;
  slot.updatedAt = now;
}

/** A slot is done when it has a confirmed value or the user said no for good. */
export function isDone(slot: Slot): boolean {
  return slot.status === "confirmed" || slot.status === "declined";
}

/** Settled slots do not block onboarding. Tentative values wait for the recap to confirm them. */
export function isSettled(slot: Slot): boolean {
  return slot.status !== "unknown";
}

/**
 * Can the brain ask for this slot now? A slot with a value or a firm no is
 * never asked. An unknown slot gets `maxAsks` direct asks. A deferred slot gets
 * one more try, only at a natural moment (usually when a task needs it).
 */
export function canAsk(slot: Slot, cfg: BrainConfig, naturalMoment: boolean): boolean {
  switch (slot.status) {
    case "unknown":
      return slot.attempts < cfg.maxAsks;
    case "deferred":
      return naturalMoment && !slot.retryUsed;
    default:
      return false;
  }
}

export function recordAsk(slot: Slot): void {
  slot.attempts += 1;
  if (slot.status === "deferred") slot.retryUsed = true;
}

/**
 * Move exhausted slots along the ladder: unknown with a spent budget becomes
 * deferred, and a slot whose one retry went unanswered becomes declined.
 * Returns the slots that became deferred in this call.
 */
export function settleExhausted(s: SessionState, cfg: BrainConfig): SlotName[] {
  const deferred: SlotName[] = [];
  for (const name of SLOT_NAMES) {
    const slot = s.slots[name];
    if (slot.status === "unknown" && slot.attempts >= cfg.maxAsks) {
      slot.status = "deferred";
      deferred.push(name);
    } else if ((slot.status === "deferred" || slot.status === "unknown") && slot.retryUsed) {
      slot.status = "declined";
    }
  }
  return deferred;
}

export function applyRefusal(slot: Slot, hard: boolean): void {
  if (slot.status === "confirmed") return;
  if (hard || slot.status === "deferred") slot.status = "declined";
  else slot.status = "deferred";
}

export function agentDisplayName(s: SessionState, cfg: BrainConfig): string {
  const slot = s.slots.agent_name;
  return slot.value && slot.status !== "declined" ? slot.value : cfg.defaultAgentName;
}
