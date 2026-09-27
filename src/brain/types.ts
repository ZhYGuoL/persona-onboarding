// Core types for the onboarding brain. One brain per session owns the slot
// ledger, the call state, and the timers. Channels feed events in and receive
// actions out.

export const SLOT_NAMES = ["agent_name", "user_name", "gmail", "help_need"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export type SlotStatus = "unknown" | "tentative" | "confirmed" | "declined" | "deferred";
export type SlotSource = "text" | "voice" | "google_profile" | "inferred";

export interface Slot {
  status: SlotStatus;
  value: string | null;
  /** Direct asks made so far, including the one retry a deferred slot gets. */
  attempts: number;
  source: SlotSource | null;
  /** A deferred slot gets exactly one more try at a natural moment. */
  retryUsed: boolean;
  updatedAt: number | null;
}

export type Phase = "onboarding" | "main" | "opted_out" | "underage";

export type CallEndReason =
  | "close_requested"
  | "expired"
  | "content"
  | "remote_hangup"
  | "connection_lost"
  | "mic_denied"
  | "error";

export interface CallState {
  status: "idle" | "ringing" | "active";
  callId: string | null;
  /** Calls the brain offered on its own. User-requested calls do not count. */
  autoOffers: number;
  declines: number;
  missed: number;
  answered: number;
  startedAt: number | null;
  lastEnd: { reason: CallEndReason; at: number } | null;
  /** Slots captured on the current or last call, for the recap text. */
  captured: SlotName[];
  /** Set when a recap went out. The next user text without a correction confirms tentative names. */
  recapPending: boolean;
  /** The Gmail link went out by text during the current or last call. */
  linkSentOnCall: boolean;
}

export type AskableSlot = "agent_name" | "user_name" | "help_need";

export type Question =
  | { kind: "ask_slot"; slot: AskableSlot; variant: "first" | "again" | "ideas" | "retry" }
  | { kind: "gmail_link"; variant: "first" | "again" | "retry" }
  | { kind: "confirm_name"; slot: "user_name"; value: string }
  | { kind: "offer_call"; variant: "first" | "again" }
  | { kind: "offer_callback" }
  | { kind: "whats_first" };

export interface Task {
  id: number;
  summary: string;
  needsGmail: boolean;
  status: "open" | "waiting_gmail" | "in_progress" | "done";
  createdAt: number;
}

export interface HistoryItem {
  from: "user" | "agent";
  channel: "text" | "call";
  text: string;
  ts: number;
}

export interface Capabilities {
  voice: boolean;
  gmail: boolean;
}

export type TimerKind = "reply" | "ring_timeout" | "idle_nudge";

export interface TimerEntry {
  kind: TimerKind;
  fireAt: number;
}

/** Things that happened outside a user text and need a reply turn. */
export type Notice =
  | { kind: "call_declined" }
  | { kind: "call_missed" }
  | { kind: "call_ended"; reason: CallEndReason; captured: SlotName[] }
  | { kind: "gmail_connected"; email: string }
  | { kind: "gmail_scope_denied" }
  | { kind: "gmail_failed"; reason: OAuthFailure }
  | { kind: "nudge" };

export type OAuthFailure =
  | "cancelled"
  | "access_denied"
  | "admin_blocked"
  | "wrong_account"
  | "error";

export interface PendingText {
  text: string;
  ts: number;
}

export interface SessionState {
  id: string;
  createdAt: number;
  phase: Phase;
  /** Phase to return to after an opt-out is reversed with START. */
  phaseBeforeOptOut: Phase | null;
  graduated: boolean;
  introduced: boolean;
  slots: Record<SlotName, Slot>;
  call: CallState;
  caps: Capabilities;
  /** The question the last agent turn asked, if any. */
  awaiting: { question: Question; at: number } | null;
  pending: { texts: PendingText[]; notices: Notice[] };
  /** Turn bookkeeping. `inFlight` is the latest started turn. */
  turn: { seq: number; inFlight: number | null; committed: number };
  timers: Record<string, TimerEntry>;
  language: string;
  casing: "lower" | "normal";
  tasks: Task[];
  history: HistoryItem[];
  lastUserAt: number | null;
  lastAgentAt: number | null;
  nudges: number;
  askedWhatsFirst: boolean;
  /** Turns committed since graduation. Used to time the casual retry for a deferred agent name. */
  turnsInMain: number;
}

export type BrainEvent =
  | { type: "text_in"; text: string }
  | { type: "client_connected" }
  | { type: "capabilities"; caps: Partial<Capabilities> }
  | { type: "user_called" }
  | { type: "call_answered"; callId: string }
  | { type: "call_declined"; callId: string }
  | { type: "call_ended"; callId: string; reason: CallEndReason }
  | { type: "voice_tool"; callId: string; toolCallId: string; name: string; args: unknown }
  | { type: "transcript_final"; callId: string; role: "user" | "agent"; text: string }
  | { type: "oauth_done"; scopes: string[]; email: string; name: string | null }
  | { type: "oauth_failed"; reason: OAuthFailure }
  | { type: "timer_fired"; timerId: string; kind: TimerKind }
  | { type: "turn_ready"; turnId: number; result: TurnResult };

export type Bubble = { kind: "text"; text: string } | { kind: "link"; url: string; title: string };

export type PushKind = "thinking" | "commentary" | "instructions";

export type Action =
  | { type: "send_text"; turnId: number; bubbles: Bubble[] }
  | { type: "typing"; on: boolean }
  | { type: "ring_phone"; callId: string; callerName: string }
  | { type: "push_to_call"; callId: string; kind: PushKind; text: string }
  | { type: "tool_result"; callId: string; toolCallId: string; output: unknown }
  | { type: "end_call"; callId: string }
  | { type: "schedule_timer"; timerId: string; kind: TimerKind; fireAt: number }
  | { type: "cancel_timer"; timerId: string };

/** A structured reading of the user's new texts. Produced by the interpreter. */
export interface Interpretation {
  language: string;
  agent_name: NameClaim | null;
  user_name: NameClaim | null;
  help_need: string | null;
  task: { summary: string; needs_gmail: boolean } | null;
  reply_to_pending: "yes" | "no" | "none";
  refusals: Array<{ slot: SlotName | "call"; hard: boolean }>;
  wants_call: boolean;
  skip_setup: boolean;
  let_agent_pick_name: boolean;
  opt_out: boolean;
  opt_in: boolean;
  under_18: boolean;
  asks_if_ai: boolean;
  asks_about_recording: boolean;
  asks_capabilities: boolean;
  other_question: string | null;
  injection: boolean;
  /** Proposed names in this message that are clear slurs. Everything else is accepted. */
  offensive_names: Array<"agent_name" | "user_name">;
  typing_fatigue: boolean;
  confused: boolean;
  leaving: boolean;
}

export interface NameClaim {
  value: string;
  correction: boolean;
}

export type Ack =
  | { kind: "agent_name_set"; value: string; correction: boolean }
  | { kind: "agent_name_picked"; value: string }
  | { kind: "agent_name_deferred" }
  | { kind: "user_name_set"; value: string; correction: boolean }
  | { kind: "user_name_confirmed"; value: string }
  | { kind: "help_need_set"; value: string }
  | { kind: "name_blocked"; slot: "agent_name" | "user_name" }
  | { kind: "name_too_long"; slot: "agent_name" | "user_name" }
  | { kind: "refusal"; slot: SlotName | "call"; hard: boolean }
  | { kind: "skip_setup" }
  | { kind: "task_started"; summary: string; needsGmail: boolean }
  | { kind: "call_declined"; final: boolean }
  | { kind: "calling_now" }
  | { kind: "voice_unavailable" }
  | { kind: "call_missed" }
  | { kind: "call_dropped"; captured: SlotName[] }
  | { kind: "call_recap"; captured: SlotName[] }
  | { kind: "call_cut"; captured: SlotName[] }
  | { kind: "mic_denied" }
  | { kind: "gmail_connected"; email: string }
  | { kind: "gmail_scope_denied" }
  | { kind: "gmail_failed"; reason: OAuthFailure }
  | { kind: "resume"; agentName: string | null; userName: string | null; topic: string | null }
  | { kind: "opted_in" }
  | { kind: "leaving" }
  | { kind: "nudge" }
  | { kind: "finishing" };

export type Answer =
  | { kind: "is_ai" }
  | { kind: "recording" }
  | { kind: "capabilities" }
  | { kind: "question"; text: string }
  | { kind: "injection" }
  | { kind: "confused" };

export interface Plan {
  intro: boolean;
  acks: Ack[];
  answers: Answer[];
  question: Question | null;
  terminal: "opt_out" | "underage" | null;
  /** Free chat in the main experience, when there is nothing structured to say. */
  chat: boolean;
  mode: "onboarding" | "main";
  facts: PlanFacts;
}

export interface PlanFacts {
  agentName: string | null;
  userName: string | null;
  helpNeed: string | null;
  gmail: string | null;
  openTask: string | null;
  /** False until the task engine lands. The agent must not promise work it cannot do. */
  canRunTasks: boolean;
  /** Channels that work in this session right now. */
  voice: boolean;
  gmailAvailable: boolean;
  language: string;
  casing: "lower" | "normal";
}

export interface TurnResult {
  interp: Interpretation | null;
  bubbles: Bubble[];
  plan: Plan;
  meta: TurnMeta;
}

export interface TurnMeta {
  interpretMs: number | null;
  renderMs: number;
  renderer: "llm" | "template";
  interpreter: "llm" | "keyword" | null;
  guardFailures: string[];
  /** Pending counts captured when the turn started, used for staleness checks. */
  textsSeen: number;
  noticesSeen: number;
}
