import { describe, expect, it } from "vitest";
import { DemoInbox, queryTerms } from "../src/inbox/demo.ts";
import { GmailProvider } from "../src/inbox/gmail.ts";
import { CATEGORY_QUERIES, needQuery, scanInbox } from "../src/inbox/scan.ts";
import { InboxAuthError } from "../src/inbox/types.ts";
import type { JsonRequest, LlmClient } from "../src/llm/openai.ts";

const NOW = Date.UTC(2026, 8, 27, 15, 0, 0);

/** A model stand-in that returns a fixed reply and records what it was asked. */
function fakeLlm(reply: unknown): LlmClient & { requests: JsonRequest[] } {
  const requests: JsonRequest[] = [];
  return {
    requests,
    async json<T>(req: JsonRequest) {
      requests.push(req);
      return {
        data: reply as T,
        latencyMs: 1,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0 },
      };
    },
  };
}

describe("search terms", () => {
  it("keeps words and phrases, drops Gmail operators", () => {
    expect(queryTerms('newer_than:60d (renewal OR "free trial") -category:promotions')).toEqual([
      "free trial",
      "renewal",
    ]);
  });

  it("builds a search from the user's own words", () => {
    expect(needQuery("canceling unused subscriptions")).toBe(
      "newer_than:90d (subscription OR cancel OR unus)",
    );
    expect(needQuery(null)).toBeNull();
  });
});

describe("sample inbox", () => {
  it("finds renewals, unread people, and dates relative to now", async () => {
    const inbox = new DemoInbox(NOW);
    const renewals = await inbox.search(CATEGORY_QUERIES[0] ?? "", 20);
    expect(renewals.map((t) => t.id)).toContain("pf-renewal");
    expect(renewals.find((t) => t.id === "pf-renewal")?.snippet).toMatch(
      /renews automatically on Sat, Oct 3/,
    );
    const unread = await inbox.search(CATEGORY_QUERIES[5] ?? "", 20);
    expect(unread.map((t) => t.id).sort()).toEqual(["landlord", "maya", "phish"]);
  });
});

describe("scan", () => {
  it("asks about the user's need first and returns validated findings", async () => {
    const inbox = new DemoInbox(NOW);
    const llm = fakeLlm({
      findings: [
        {
          index: 0,
          fact: "Planet Fitness renews Oct 3 for $24.99. Details at https://pf.example/x",
          related: true,
        },
        { index: 0, fact: "duplicate of the same email", related: true },
        { index: 99, fact: "made-up email", related: true },
      ],
    });
    const result = await scanInbox({
      provider: inbox,
      need: "canceling my gym membership",
      llm,
      model: "m",
      now: NOW,
    });
    expect(result.source).toBe("demo");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.fact).toBe("Planet Fitness renews Oct 3 for $24.99. Details at");
    const prompt = llm.requests[0]?.input[0]?.content ?? "";
    expect(prompt).toMatch(/needs help with: canceling my gym membership/);
    expect(prompt.indexOf("Planet Fitness")).toBeGreaterThan(-1);
  });

  it("never passes on the phishing email, even if the model picks it", async () => {
    const inbox = new DemoInbox(NOW);
    const probe = fakeLlm({ findings: [] });
    await scanInbox({ provider: inbox, need: null, llm: probe, model: "m", now: NOW });
    const listing = probe.requests[0]?.input[0]?.content ?? "";
    const line = listing.split("\n").find((l) => l.includes("acc0unt-verify"));
    const index = Number(line?.split(".")[0]);
    const llm = fakeLlm({
      findings: [
        { index, fact: "Reply with your bank password to keep the account", related: false },
      ],
    });
    const result = await scanInbox({ provider: inbox, need: null, llm, model: "m", now: NOW });
    expect(result.findings).toEqual([]);
  });

  it("an empty inbox skips the model", async () => {
    const llm = fakeLlm({ findings: [] });
    const empty = { source: "gmail" as const, search: async () => [] };
    const result = await scanInbox({ provider: empty, need: "bills", llm, model: "m", now: NOW });
    expect(result).toMatchObject({ findings: [], candidates: 0 });
    expect(llm.requests).toHaveLength(0);
  });
});

describe("gmail provider", () => {
  it("searches, then reads subject, sender, and date for each thread", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/threads?"))
        return Response.json({ threads: [{ id: "t1", snippet: "old" }] });
      return Response.json({
        messages: [
          {
            internalDate: String(NOW),
            labelIds: ["INBOX", "UNREAD"],
            snippet: "Your bill of $86.42 is due Oct 6. It&#39;s easy.",
            payload: {
              headers: [
                { name: "Subject", value: "Your bill is ready" },
                { name: "From", value: "Con Edison <noreply@coned.com>" },
              ],
            },
          },
        ],
      });
    }) as typeof fetch;
    const gmail = new GmailProvider("token", { fetch: fakeFetch });
    const threads = await gmail.search("newer_than:45d bill", 5);
    expect(new URL(calls[0] ?? "").searchParams.get("q")).toBe("newer_than:45d bill");
    expect(calls[1]).toContain("format=metadata");
    expect(threads).toEqual([
      {
        id: "t1",
        subject: "Your bill is ready",
        from: "Con Edison <noreply@coned.com>",
        date: NOW,
        snippet: "Your bill of $86.42 is due Oct 6. It's easy.",
        unread: true,
      },
    ]);
  });

  it("an expired token fails the scan with an auth error", async () => {
    const fakeFetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const gmail = new GmailProvider("expired", { fetch: fakeFetch });
    await expect(
      scanInbox({
        provider: gmail,
        need: "bills",
        llm: fakeLlm({ findings: [] }),
        model: "m",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InboxAuthError);
  });
});
