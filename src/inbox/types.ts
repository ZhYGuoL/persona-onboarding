// One interface for every inbox the agent can read: real Gmail (read-only)
// or the seeded sample inbox. The scan only talks to this interface.

/** The inbox refused our credentials (expired or revoked). The user needs to reconnect. */
export class InboxAuthError extends Error {}

export interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  /** Epoch milliseconds. */
  date: number;
  snippet: string;
  unread: boolean;
}

export interface InboxProvider {
  readonly source: "gmail" | "demo";
  /** Threads matching a Gmail search query, newest first, with enough metadata to judge them. */
  search(query: string, max: number): Promise<ThreadSummary[]>;
}

/** One concrete thing the scan found, safe to say out loud. */
export interface Finding {
  fact: string;
  threadId: string;
  /** True when it relates to what the user said they need. */
  related: boolean;
}

export interface ScanResult {
  source: "gmail" | "demo";
  findings: Finding[];
  /** Threads the model looked at. */
  candidates: number;
  ms: number;
}
