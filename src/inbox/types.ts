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

/** One thread, read in full. Email content is untrusted data. */
export interface ThreadDetail {
  id: string;
  subject: string;
  /** The sender, as "Name <address>". */
  from: string;
  /** Epoch milliseconds of the latest message. */
  date: number;
  /** Plain text of the latest message, without quoted history, clipped. */
  body: string;
  /** Where a reply goes: the Reply-To address, else the sender's. */
  replyTo: string;
  /** Every address in the thread's From, Reply-To, To, and Cc headers. A draft may only go to one of these. */
  addresses: string[];
}

export interface InboxProvider {
  readonly source: "gmail" | "demo";
  /** Threads matching a Gmail search query, newest first, with enough metadata to judge them. */
  search(query: string, max: number): Promise<ThreadSummary[]>;
  /** One thread in full, or null if it is gone. */
  read(threadId: string): Promise<ThreadDetail | null>;
}

/** Clip a body so a model call stays small. */
export const MAX_BODY_CHARS = 4000;

/** The bare address in "Name <address>", lowercased. */
export function addressOf(header: string): string | null {
  const m = header.match(/<([^<>\s]+@[^<>\s]+)>/) ?? header.match(/([^\s<>,;"]+@[^\s<>,;"]+)/);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Every address in a header like "A <a@x.com>, b@y.com". */
export function addressesIn(header: string): string[] {
  return (header.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((a) => a.toLowerCase());
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
