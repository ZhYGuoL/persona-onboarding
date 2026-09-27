// Read-only Gmail over the REST API. `threads.list` finds matches (10 quota
// units), and `threads.get` with metadata fetches subject, sender, and date
// (40 units each). A scan stays far under the 6,000 units per minute limit.

import { InboxAuthError, type InboxProvider, type ThreadSummary } from "./types.ts";

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

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new InboxAuthError(`gmail ${res.status}`);
    if (!res.ok) throw new Error(`gmail ${res.status}`);
    return (await res.json()) as T;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
