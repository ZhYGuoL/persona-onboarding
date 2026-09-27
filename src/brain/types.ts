// Core types for the onboarding brain. One brain per session owns the slot
// ledger, the call state, and the timers. Channels feed events in and receive
// actions out.

export const SLOT_NAMES = ["agent_name", "user_name", "gmail", "help_need"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export type SlotStatus = "unknown" | "tentative" | "confirmed" | "declined" | "deferred";
export type SlotSource = "text" | "voice" | "google_profile" | "inferred" | "sample_inbox";

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
  /** The call connected, but the agent never made a sound. */
  | "no_voice"
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
  /** When the brain told the agent to wrap up. The next agent utterance ends the call. */
  wrapUpAt: number | null;
  /** 0 = no silence yet, 1 = the agent already checked in once. */
  silenceStage: number;
  /** After the wrap-up, the agent got one "say goodbye now" reminder. */
  wrapNudged: boolean;
  /** The user said they have to go, so the recap does not chase. */
  userLeaving: boolean;
  /** The agent's current utterance has started and has no final yet. */
  agentSpeaking: boolean;
  /**
   * A wrap-up that waits for the agent to finish talking. The agent often says
   * goodbye on its own, and a push on top of that makes a second goodbye.
   */
  deferredWrapUp: WrapUpReason | null;
  /**
   * An inbox result went to the agent. The call wraps up after the agent line
   * that delivers it: one that starts after `since` and says one of the anchors.
   */
  pendingDelivery: { since: number; anchors: string[] } | null;
}

export type WrapUpReason = "done" | "leaving" | "silence" | "time" | "underage" | "gmail_later";

export type AskableSlot = "agent_name" | "user_name" | "help_need";

export type Question =
  | { kind: "ask_slot"; slot: AskableSlot; variant: "first" | "again" | "ideas" | "retry" }
  | { kind: "gmail_link"; variant: "first" | "again" | "retry" | "requested" }
  | { kind: "confirm_name"; slot: "user_name"; value: string }
  | { kind: "offer_call"; variant: "first" | "again" }
  | { kind: "offer_callback" }
  /** "Want me to start on X?". With a finding, a yes starts a task on that email. */
  | { kind: "whats_first"; finding?: OfferedFinding }
  /** A draft is ready. Nothing goes out without a yes. */
  | { kind: "confirm_send"; taskId: number }
  /** The task needs one detail from the user. The work step wrote the question. */
  /** `quiet`: the task asked this already, so the brain waits for the answer without asking again. */
  | { kind: "task_info"; taskId: number; text: string; quiet?: boolean };

/**
 * A task's life: `open` (ready to run) or `waiting_gmail` (needs the inbox
 * first), then `working` while the task service reads and drafts. A result
 * leaves it `needs_yes` (a draft to send), `needs_info` (one question), or
 * `done`. The user can drop it, and repeated failures end it as `failed`.
 */
export type TaskStatus =
  | "open"
  | "waiting_gmail"
  | "working"
  | "needs_yes"
  | "needs_info"
  | "done"
  | "dropped"
  | "failed";

export interface OfferedFinding {
  /** Null for a follow-up that is not about one email, like drafting a note to an insurer. */
  threadId: string | null;
  next: string;
  /** Said with the offer when the thread has not shown it yet. */
  fact: string | null;
}

export interface Task {
  id: number;
  summary: string;
  needsGmail: boolean;
  status: TaskStatus;
  createdAt: number;
  /** The email this task is about, when an inbox finding started it. */
  threadId: string | null;
  /** False for a follow-up that needs no email, like a note after an empty search. It skips the search. */
  search: boolean;
  /** Details and edits the user gave, oldest first. They are the user's words, never instructions. */
  notes: string[];
  result: TaskResult | null;
  /** Work runs so far. Caps retries and re-drafts. */
  runs: number;
  /** Questions this task asked the user, so it never asks the same thing twice. */
  asked: string[];
}

/** The email behind a result, so the user can check the work. */
export interface Receipt {
  threadId: string;
  /** The sender's display name. */
  from: string;
  subject: string;
  date: number;
  /** One sentence copied exactly from the email, or null when the model's quote was not in it. */
  quote: string | null;
}

export interface Draft {
  to: string;
  subject: string;
  body: string;
  /** The thread this replies to, if any. */
  threadId: string | null;
}

export type TaskResult =
  /** `offer` is one follow-up the agent can do about an email in the answer. */
  | {
      kind: "answer";
      text: string;
      receipt: Receipt | null;
      offer?: { threadId: string | null; next: string } | null;
    }
  | { kind: "draft"; text: string; draft: Draft; receipt: Receipt | null }
  | { kind: "remind"; text: string; at: number; receipt: Receipt | null }
  | { kind: "question"; text: string; receipt: Receipt | null }
  | { kind: "cannot"; text: string; receipt: Receipt | null };

/** A draft the user said yes to. Sending is simulated: nothing leaves their account. */
export interface SentItem {
  taskId: number;
  draft: Draft;
  at: number;
}

export interface Reminder {
  taskId: number;
  at: number;
  text: string;
  sent: boolean;
  /** The user took it back before it went out. */
  canceled?: boolean;
}

export interface HistoryItem {
  from: "user" | "agent";
  channel: "text" | "call";
  text: string;
  /** When the message arrived. For call speech, when the utterance ended. */
  ts: number;
  /** Call speech only: when the utterance started. */
  startedAt?: number;
}

export interface Capabilities {
  voice: boolean;
  /** The task service is running (it needs the model key). */
  tasks: boolean;
  gmail: boolean;
}

export type TimerKind =
  | "reply"
  | "ring_timeout"
  | "idle_nudge"
  | "call_silence"
  | "call_max"
  | "call_end_fallback"
  | "call_gmail_wait"
  | "call_no_voice"
  | "call_finding_wait"
  /** A reminder the user asked for. Its timer id is `reminder-<taskId>`. */
  | "reminder";

export interface TimerEntry {
  kind: TimerKind;
  fireAt: number;
}

/** Things that happened outside a user text and need a reply turn. */
export type Notice =
  | { kind: "call_declined" }
  | { kind: "call_missed" }
  | { kind: "call_ended"; reason: CallEndReason; captured: SlotName[] }
  | { kind: "gmail_connected"; email: string; demo: boolean }
  | { kind: "gmail_scope_denied" }
  | { kind: "gmail_failed"; reason: OAuthFailure }
  | { kind: "inbox_findings" }
  | { kind: "scan_failed"; reason: "auth" | "error" }
  | { kind: "task_result"; taskId: number }
  | { kind: "task_failed"; taskId: number; reason: "auth" | "error" }
  | { kind: "reminder_due"; taskId: number }
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
  /** On a call, true when the user typed this instead of saying it. Typed values are exact. */
  typed?: boolean;
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
  /** Texts and notices wait for a text turn. Utterances (finished user speech on a call) wait for a call turn. */
  pending: { texts: PendingText[]; notices: Notice[]; utterances: PendingText[] };
  /**
   * Turn bookkeeping. `inFlight` is the latest started text turn. Call turns run
   * on their own track, in order, and are never dropped. `holdRecap` keeps the
   * post-call text waiting until the last call utterance is written.
   */
  turn: {
    seq: number;
    inFlight: number | null;
    committed: number;
    callInFlight: number | null;
    holdRecap: boolean;
  };
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
  /** What the last inbox scan found. Only facts, never credentials. */
  inbox: InboxState;
  /** Drafts the user said yes to. Sending is simulated, so nothing left their account. */
  outbox: SentItem[];
  /** English template lines sent lately, so variants rotate for users in any language. */
  sentTemplates: string[];
  reminders: Reminder[];
  /** The user's IANA time zone, from their browser. Reminders use it. */
  timeZone: string;
}

export interface InboxFinding {
  fact: string;
  /** What the assistant could do next, as a short noun phrase. */
  next: string;
  /** The email the finding came from, so a task can read it in full. */
  threadId: string;
  related: boolean;
}

export interface InboxState {
  source: "gmail" | "demo" | null;
  scanning: boolean;
  scannedAt: number | null;
  findings: InboxFinding[];
  /** Scans that failed since the last success. The next text retries while this is under the limit. */
  failures: number;
  /** Findings already offered as a task, by thread id. Each is offered once. */
  offered: string[];
  /** The user said no to an offer, so no more findings are offered. */
  offersStopped: boolean;
}

export type BrainEvent =
  | { type: "text_in"; text: string }
  | { type: "client_connected" }
  | { type: "capabilities"; caps: Partial<Capabilities> }
  | { type: "user_called" }
  | { type: "call_answered"; callId: string }
  | { type: "call_declined"; callId: string }
  | { type: "call_ended"; callId: string; reason: CallEndReason }
  | { type: "voice_activity"; callId: string; role: "user" | "agent" }
  | {
      type: "transcript_final";
      callId: string;
      role: "user" | "agent";
      text: string;
      /** How long ago the utterance started, so the brain can tell a goodbye from speech already in progress. */
      startedAgoMs?: number;
    }
  | { type: "oauth_done"; scopes: string[]; email: string; name: string | null; demo?: boolean }
  | { type: "scan_done"; findings: InboxFinding[]; source: "gmail" | "demo"; ms: number }
  | { type: "scan_failed"; reason: "auth" | "error" }
  | { type: "task_done"; taskId: number; result: TaskResult; threadId: string | null; ms: number }
  | { type: "task_failed"; taskId: number; reason: "auth" | "error" }
  | { type: "client_info"; timeZone: string }
  /** Measured by the phone. Logged for the voice report, and changes nothing. */
  | { type: "voice_metric"; callId: string; kind: string; ms: number }
  | { type: "voice_run"; scenario: string; status: "start" | "end"; detail: string | null }
  | { type: "oauth_failed"; reason: OAuthFailure }
  | { type: "timer_fired"; timerId: string; kind: TimerKind }
  | { type: "turn_ready"; turnId: number; result: TurnResult };

export type Bubble =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; title: string }
  /** An email draft, shown as a card. It waits for the user's yes. */
  | { kind: "draft"; to: string; subject: string; body: string };

export type PushKind = "thinking" | "commentary" | "instructions";

export type Action =
  | { type: "send_text"; turnId: number; bubbles: Bubble[] }
  | { type: "typing"; on: boolean }
  | { type: "ring_phone"; callId: string; callerName: string }
  /** The user called the agent, and the agent picked up. The phone connects voice for this call. */
  | { type: "call_accepted"; callId: string }
  | { type: "push_to_call"; callId: string; kind: PushKind; text: string }
  /** With a reason, the call is cut at once and ends with that reason. */
  | { type: "end_call"; callId: string; reason?: CallEndReason }
  /** Look through the connected inbox for what matters to this user. */
  | { type: "scan_inbox"; need: string | null; source: InboxSource }
  /** Do the work behind a task. The result comes back as `task_done` or `task_failed`. */
  | { type: "run_task"; taskId: number; job: TaskJob }
  /** The user said yes to a draft. Sending is simulated: this only records it. */
  | { type: "simulated_send"; taskId: number; draft: Draft }
  | { type: "schedule_timer"; timerId: string; kind: TimerKind; fireAt: number }
  | { type: "cancel_timer"; timerId: string };

/** A structured reading of the user's new texts. Produced by the interpreter. */
export interface Interpretation {
  language: string;
  agent_name: NameClaim | null;
  user_name: NameClaim | null;
  help_need: string | null;
  task: { summary: string; needs_gmail: boolean } | null;
  /** More tasks in the same message ("draft the reply, and check my bank stuff too"). */
  extra_tasks: Array<{ summary: string; needs_gmail: boolean }>;
  reply_to_pending: "yes" | "no" | "none";
  refusals: Array<{ slot: SlotName | "call"; hard: boolean }>;
  wants_call: boolean;
  wants_gmail_link: boolean;
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
  /** The user confirmed or spelled out their name (mostly on calls). */
  confirms_name: string | null;
  /** A change the user wants in the draft waiting for their yes. */
  draft_edit: string | null;
  /** A detail the user gave because the agent asked for it for a task. */
  task_detail: string | null;
  /** The user takes back something they asked the agent to do ("never mind", "don't remind me"). */
  cancels_task: boolean;
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
  /** `next` is a queued task that starts right after another one's result. */
  | { kind: "task_started"; summary: string; needsGmail: boolean; next?: boolean }
  | { kind: "task_result"; taskId: number; result: TaskResult }
  | { kind: "task_redraft" }
  | { kind: "task_limit" }
  /** `reminder` is true when a pending reminder was called off. */
  | { kind: "task_canceled"; reminder: boolean }
  | { kind: "task_failed"; summary: string; reason: "auth" | "error" }
  | { kind: "draft_sent"; to: string }
  | { kind: "draft_dropped" }
  | { kind: "reminder"; text: string }
  | { kind: "call_declined"; final: boolean }
  | { kind: "calling_now" }
  | { kind: "voice_unavailable" }
  | { kind: "call_limit" }
  | { kind: "call_missed" }
  | { kind: "call_dropped"; captured: SlotName[] }
  | { kind: "call_no_voice" }
  | { kind: "call_recap"; captured: SlotName[] }
  | { kind: "call_cut"; captured: SlotName[] }
  | { kind: "mic_denied" }
  /** `looking` is true while the quick scan runs. Otherwise a task is about to run. */
  | { kind: "gmail_connected"; email: string; demo: boolean; looking: boolean }
  | { kind: "inbox_findings"; facts: string[] }
  | { kind: "scan_failed"; reason: "auth" | "error"; retry: boolean }
  | { kind: "rescanning" }
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
  /** False without the task service. The agent must not promise work it cannot do. */
  canRunTasks: boolean;
  /** The user has asked for at least one task. */
  anyTask: boolean;
  /** Channels that work in this session right now. */
  voice: boolean;
  gmailAvailable: boolean;
  /** Findings from the last inbox scan, most useful first. */
  inboxFindings: string[];
  /** The connected inbox is the sample inbox, not the user's real email. */
  sampleInbox: boolean;
  /** Where the inbox scan stands, so the agent never guesses what a failed scan found. */
  inboxStatus: "none" | "scanning" | "failed" | "scanned";
  language: string;
  casing: "lower" | "normal";
  timeZone: string;
}

/** What one call turn does: context for the live call, and any texts sent meanwhile. */
export interface CallPlan {
  pushes: Array<{ kind: PushKind; text: string }>;
  /** Texts sent to the thread during the call, such as the Gmail link. */
  texts: Bubble[];
  /** Tell the agent to say goodbye. The next agent utterance ends the call. */
  wrapUp: boolean;
  /** End the call now, without a goodbye (opt-out, under 18). */
  end: boolean;
}

export type TurnResult =
  | {
      kind: "text";
      interp: Interpretation | null;
      bubbles: Bubble[];
      plan: Plan;
      meta: TurnMeta;
      /** English template lines behind the bubbles, if templates wrote them. */
      templateLines: string[];
    }
  | {
      kind: "call";
      interp: Interpretation;
      callPlan: CallPlan;
      meta: TurnMeta;
      /** Texts sent during the call, translated for a non-English caller: English line to translation. */
      translations?: Record<string, string>;
    };

export interface TurnMeta {
  interpretMs: number | null;
  renderMs: number;
  renderer: "llm" | "template";
  interpreter: "llm" | "keyword" | null;
  guardFailures: string[];
  /** Pending counts captured when the turn started, used for staleness checks. */
  textsSeen: number;
  noticesSeen: number;
  utterancesSeen: number;
}

/** Everything the task service needs to run one task, fixed when the brain starts it. */
export interface TaskJob {
  summary: string;
  threadId: string | null;
  notes: string[];
  /** The draft to revise, when the user asked for changes. */
  previous: Draft | null;
  /** Emails the user already saw: findings and earlier results. */
  shown: string[];
  /** False when the task needs no email, so the work step does not search. */
  search: boolean;
  /** The inbox the task reads, or null to work without email. */
  inbox: InboxSource | null;
  userName: string | null;
  userEmail: string | null;
  language: string;
  timeZone: string;
}

/** Real Gmail (a token held in memory) or the seeded sample inbox (no token at all). */
export type InboxSource = "gmail" | "demo";
