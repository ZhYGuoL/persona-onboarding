// Holds each session's inbox connection and runs scans when the brain asks.
// Gmail access tokens live in memory only, for the session. They are never
// written to disk, logged, or put in the session state.

import type { Action } from "../brain/types.ts";
import type { LlmClient } from "../llm/openai.ts";
import type { Hub } from "../runtime/hub.ts";
import { DemoInbox } from "./demo.ts";
import { GmailProvider } from "./gmail.ts";
import { scanInbox } from "./scan.ts";
import { InboxAuthError, type InboxProvider } from "./types.ts";

const RETRY_DELAY_MS = 1000;

type Connection = { kind: "gmail"; accessToken: string; expiresAt: number } | { kind: "demo" };

export interface InboxServiceOptions {
  hub: Hub;
  llm: LlmClient;
  model: string;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export class InboxService {
  private readonly opts: InboxServiceOptions;
  private readonly connections = new Map<string, Connection>();
  private readonly running = new Set<Promise<void>>();

  constructor(opts: InboxServiceOptions) {
    this.opts = opts;
  }

  connectGmail(sessionId: string, accessToken: string, expiresInSec: number): void {
    this.connections.set(sessionId, {
      kind: "gmail",
      accessToken,
      expiresAt: Date.now() + Math.max(60, expiresInSec - 60) * 1000,
    });
  }

  connectDemo(sessionId: string): void {
    this.connections.set(sessionId, { kind: "demo" });
  }

  forget(sessionId: string): void {
    this.connections.delete(sessionId);
  }

  onAction(sessionId: string, action: Action): void {
    if (action.type !== "scan_inbox") return;
    const job = this.scan(sessionId, action.need).finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Resolves when no scan is running. Tests and the stress harness wait on it. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private provider(sessionId: string): InboxProvider | null {
    const c = this.connections.get(sessionId);
    if (!c) return null;
    if (c.kind === "demo") return new DemoInbox(this.opts.hub.now(sessionId));
    if (Date.now() >= c.expiresAt) return null;
    return new GmailProvider(c.accessToken);
  }

  private async scan(sessionId: string, need: string | null): Promise<void> {
    const { hub } = this.opts;
    const provider = this.provider(sessionId);
    if (!provider) {
      this.forget(sessionId);
      await hub.dispatch(sessionId, { type: "scan_failed", reason: "auth" });
      return;
    }
    try {
      const run = () =>
        scanInbox({
          provider,
          need,
          llm: this.opts.llm,
          model: this.opts.model,
          now: hub.now(sessionId),
        });
      // One quiet retry covers a slow model or a Gmail hiccup. A lost token does not get better.
      const result = await run().catch(async (err: unknown) => {
        if (err instanceof InboxAuthError) throw err;
        this.opts.log.warn(
          { sessionId, err: err instanceof Error ? err.message : String(err) },
          "inbox scan failed, retrying once",
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        return run();
      });
      this.opts.log.info(
        {
          sessionId,
          source: result.source,
          candidates: result.candidates,
          findings: result.findings.length,
          ms: Math.round(result.ms),
        },
        "inbox scanned",
      );
      await hub.dispatch(sessionId, {
        type: "scan_done",
        findings: result.findings.map((f) => ({ fact: f.fact, related: f.related })),
        source: result.source,
        ms: Math.round(result.ms),
      });
    } catch (err) {
      const auth = err instanceof InboxAuthError;
      if (auth) this.forget(sessionId);
      this.opts.log.warn(
        { sessionId, auth, err: err instanceof Error ? err.message : String(err) },
        "inbox scan failed",
      );
      await hub.dispatch(sessionId, { type: "scan_failed", reason: auth ? "auth" : "error" });
    }
  }
}
