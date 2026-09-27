// Tunable constants. All times are milliseconds of session time, so the fake
// clock and the reviewer panel can fast-forward them.

export interface BrainConfig {
  /** Wait this long after the last user text before replying, so a burst of texts gets one reply. */
  replyDebounceMs: number;
  /** Delay before a reply to a non-text event (call ended, OAuth done). */
  noticeDelayMs: number;
  ringTimeoutMs: number;
  /** On a call: check in after this much silence following the agent's last words. */
  callSilenceNudgeMs: number;
  /** On a call: after the check-in, wrap up and move to text after this much more silence. */
  callSilenceGiveUpMs: number;
  /** Hard cap on call length, to keep voice cost bounded. */
  callMaxMs: number;
  /** Answered calls per session. After this, the agent keeps it to text. */
  maxCallsPerSession: number;
  /** Failed inbox scans in a row before the agent stops retrying. */
  maxScanFailures: number;
  /** After asking the agent to wrap up, end the call anyway after this long. */
  callEndFallbackMs: number;
  /** After the wrap-up, hang up this long after the agent stops talking without a clear goodbye. */
  callEndQuietMs: number;
  /** After the Gmail link goes out on a call, wait this long for the connect before wrapping up. */
  callGmailWaitMs: number;
  /** After an inbox result goes to the agent, wrap up anyway if it is not said within this long. */
  callFindingWaitMs: number;
  /** One gentle follow-up when the user goes quiet on an open question. */
  idleNudgeMs: number;
  maxNudges: number;
  /** A user text after a gap this long opens with a one-line summary. */
  resumeGapMs: number;
  /** Direct asks per slot before it is deferred. A deferred slot gets one more try later. */
  maxAsks: number;
  /** Calls the brain offers on its own. The user can always ask for a call. */
  maxAutoCallOffers: number;
  /** After this many declines the brain never offers a call on its own again. */
  maxCallDeclines: number;
  /** Committed turns in the main experience before the casual retry for a deferred agent name. */
  agentNameRetryAfterTurns: number;
  historyLimit: number;
  agentNameMaxLength: number;
  userNameMaxLength: number;
  helpNeedMaxLength: number;
  /** Name the agent goes by until the user names it. */
  defaultAgentName: string;
  nameIdeas: string[];
  /** The task engine (milestone 4). Off means the agent never promises to do work. */
  tasksEnabled: boolean;
}

export const DEFAULT_CONFIG: BrainConfig = {
  replyDebounceMs: 700,
  noticeDelayMs: 300,
  ringTimeoutMs: 25_000,
  callSilenceNudgeMs: 9_000,
  callSilenceGiveUpMs: 12_000,
  callMaxMs: 4 * 60_000,
  maxCallsPerSession: 3,
  maxScanFailures: 3,
  callEndFallbackMs: 15_000,
  callEndQuietMs: 3_000,
  callGmailWaitMs: 75_000,
  callFindingWaitMs: 20_000,
  idleNudgeMs: 10 * 60_000,
  maxNudges: 2,
  resumeGapMs: 60 * 60_000,
  maxAsks: 2,
  maxAutoCallOffers: 2,
  maxCallDeclines: 2,
  agentNameRetryAfterTurns: 2,
  historyLimit: 40,
  agentNameMaxLength: 32,
  userNameMaxLength: 40,
  helpNeedMaxLength: 200,
  defaultAgentName: "Persona",
  nameIdeas: ["Nova", "Juno", "Milo"],
  tasksEnabled: false,
};
