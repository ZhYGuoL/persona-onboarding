// Read-only Gmail over the REST API. `threads.list` finds matches (10 quota
// units), and `threads.get` with metadata fetches subject, sender, and date
// (40 units each). A scan stays far under the 6,000 units per minute limit.
// A task reads one thread in full (40 units).

import {
  addressesIn,
  addressOf,
  InboxAuthError,
  type InboxProvider,
  MAX_BODY_CHARS,
  type ThreadDetail,
  type ThreadSummary,
} from "./types.ts";

interface Header {
  name: string;
  value: string;
}

interface Part {
  mimeType?: string;
  headers?: Header[];
  body?: { data?: string };
  parts?: Part[];
}

interface Message {
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: Part;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailProvider implements InboxProvider {
  readonly source = "gmail" as const;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(accessToken: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.token = accessToken;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async search(query: string, max: number): Promise<ThreadSummary[]> {
    const list = await this.get<{ threads?: Array<{ id: string; snippet?: string }> }>(
      `/threads?${new URLSearchParams({ q: query, maxResults: String(max) })}`,
    );
    const threads = list.threads ?? [];
    const detailed = await Promise.all(threads.map((t) => this.metadata(t.id, t.snippet ?? "")));
    return detailed.filter((t): t is ThreadSummary => t !== null).sort((a, b) => b.date - a.date);
  }

  private async metadata(id: string, snippet: string): Promise<ThreadSummary | null> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const h of ["Subject", "From", "Date"]) params.append("metadataHeaders", h);
    try {
      const thread = await this.get<{
        messages?: Array<{
          internalDate?: string;
          labelIds?: string[];
          snippet?: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
        }>;
      }>(`/threads/${encodeURIComponent(id)}?${params}`);
      const last = thread.messages?.at(-1);
      if (!last) return null;
      const header = (name: string) =>
        last.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
        "";
      return {
        id,
        subject: header("Subject"),
        from: header("From"),
        date: Number(last.internalDate ?? 0),
        snippet: decodeEntities(last.snippet ?? snippet),
        unread: thread.messages?.some((m) => m.labelIds?.includes("UNREAD")) ?? false,
      };
    } catch (err) {
      if (err instanceof InboxAuthError) throw err;
      return null;
    }
  }

  async read(threadId: string): Promise<ThreadDetail | null> {
    const thread = await this.get<{ messages?: Message[] }>(
      `/threads/${encodeURIComponent(threadId)}?format=full`,
      true,
    );
    const messages = thread?.messages ?? [];
    const last = messages.at(-1);
    if (!last) return null;
    const header = (m: Message, name: string) =>
      m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const addresses = new Set<string>();
    for (const m of messages) {
      for (const name of ["From", "Reply-To", "To", "Cc"]) {
        for (const a of addressesIn(header(m, name))) addresses.add(a);
      }
    }
    const from = header(last, "From");
    return {
      id: threadId,
      subject: header(last, "Subject"),
      from,
      date: Number(last.internalDate ?? 0),
      body: cleanBody(textOf(last.payload) ?? decodeEntities(last.snippet ?? "")),
      replyTo: addressOf(header(last, "Reply-To")) ?? addressOf(from) ?? "",
      addresses: [...addresses],
    };
  }

  private async get<T>(path: string, missingOk: true): Promise<T | null>;
  private async get<T>(path: string, missingOk?: false): Promise<T>;
  private async get<T>(path: string, missingOk = false): Promise<T | null> {
    const res = await this.fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new InboxAuthError(`gmail ${res.status}`);
    if (res.status === 404 && missingOk) return null;
    if (!res.ok) throw new Error(`gmail ${res.status}`);
    return (await res.json()) as T;
  }
}

function decodePart(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** The plain text of a message: its text/plain part, else its HTML with tags removed. */
export function textOf(part: Part | undefined): string | null {
  if (!part) return null;
  const find = (p: Part, type: string): string | null => {
    if (p.mimeType === type && p.body?.data) return decodePart(p.body.data);
    for (const child of p.parts ?? []) {
      const hit = find(child, type);
      if (hit !== null) return hit;
    }
    return null;
  };
  const plain = find(part, "text/plain");
  if (plain !== null) return plain;
  const html = find(part, "text/html");
  return html === null ? null : htmlToText(html);
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " "),
  );
}

/** Drop quoted history, tidy spacing, and clip. */
export function cleanBody(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break;
    if (line.trimStart().startsWith(">")) continue;
    kept.push(line.replace(/[ \t]+/g, " ").trimEnd());
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
