// Gmail connect. The agent texts a signed, expiring link. It opens in a popup
// (never the simulator tab, which would kill a live call), offers Google or a
// sample inbox, and runs the OAuth code flow with PKCE. Granted scopes decide
// the outcome, because Google's granular consent lets people uncheck Gmail.
// Tokens stay in memory and never reach logs.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { GMAIL_SCOPE } from "../brain/brain.ts";
import type { OAuthFailure } from "../brain/types.ts";
import type { InboxService } from "../inbox/service.ts";
import type { Hub } from "../runtime/hub.ts";
import { connectGmailPage, oauthResultPage } from "./pages.ts";

const LINK_TTL_MS = 24 * 60 * 60_000;
const FLOW_TTL_MS = 15 * 60_000;
/** After the popup closes, wait this long for a callback already in flight before calling it cancelled. */
const CLOSE_GRACE_MS = 2000;
const SCOPES = ["openid", "email", "profile", GMAIL_SCOPE];

export interface OAuthDeps {
  hub: Hub;
  inbox: InboxService;
  secret: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string;
  baseUrl: string;
  log: { warn: (obj: object, msg: string) => void };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signLink(secret: string, sessionId: string, now: number): string {
  const exp = now + LINK_TTL_MS;
  const sig = b64url(createHmac("sha256", secret).update(`${sessionId}.${exp}`).digest()).slice(
    0,
    32,
  );
  return `${sessionId}.${exp}.${sig}`;
}

/** The session id for a valid, unexpired link token, or null. */
export function verifyLink(secret: string, token: string | undefined, now: number): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, expRaw, sig] = parts as [string, string, string];
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return null;
  const want = b64url(createHmac("sha256", secret).update(`${sessionId}.${exp}`).digest()).slice(
    0,
    32,
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b) ? sessionId : null;
}

/** Google's error codes, in the brain's words. */
export function mapGoogleError(error: string): OAuthFailure {
  if (error === "access_denied") return "access_denied";
  if (error === "admin_policy_enforced") return "admin_blocked";
  return "error";
}

interface Flow {
  sessionId: string;
  verifier: string;
  at: number;
}

export function registerOAuth(app: FastifyInstance, deps: OAuthDeps) {
  const flows = new Map<string, Flow>();
  /** The last connect page each session opened, so a closed popup can count as a cancel. */
  const opened = new Map<string, { at: number; done: boolean }>();
  const connectPath = "/connect/gmail";
  const now = () => Date.now();

  const finish = (sessionId: string) => {
    const o = opened.get(sessionId);
    if (o) o.done = true;
  };

  const sweep = () => {
    for (const [state, f] of flows) if (now() - f.at > FLOW_TTL_MS) flows.delete(state);
  };

  app.get<{ Querystring: { t?: string } }>(connectPath, async (req, reply) => {
    const sessionId = verifyLink(deps.secret, req.query.t, now());
    reply.type("text/html; charset=utf-8");
    if (!sessionId) {
      return oauthResultPage(false, "This link expired", "Text your assistant for a fresh link.");
    }
    opened.set(sessionId, { at: now(), done: false });
    const t = encodeURIComponent(req.query.t ?? "");
    return connectGmailPage(`/auth/google/start?t=${t}`, "/connect/sample", req.query.t ?? "");
  });

  app.get<{ Querystring: { t?: string } }>("/auth/google/start", async (req, reply) => {
    const sessionId = verifyLink(deps.secret, req.query.t, now());
    if (!sessionId) {
      return reply
        .type("text/html; charset=utf-8")
        .send(oauthResultPage(false, "This link expired", "Text your assistant for a fresh link."));
    }
    if (!deps.clientId || !deps.clientSecret) {
      return reply
        .type("text/html; charset=utf-8")
        .send(
          oauthResultPage(false, "Google sign-in is not set up", "Use the sample inbox instead."),
        );
    }
    sweep();
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    flows.set(state, { sessionId, verifier, at: now() });
    const params = new URLSearchParams({
      client_id: deps.clientId,
      redirect_uri: deps.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      access_type: "online",
      // Always show the account picker and the scope checkboxes.
      prompt: "select_account consent",
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    "/auth/google/callback",
    async (req, reply) => {
      reply.type("text/html; charset=utf-8");
      const flow = req.query.state ? flows.get(req.query.state) : undefined;
      if (!flow || now() - flow.at > FLOW_TTL_MS) {
        return oauthResultPage(
          false,
          "This sign-in expired",
          "Text your assistant for a fresh link.",
        );
      }
      flows.delete(req.query.state ?? "");
      const { sessionId } = flow;
      finish(sessionId);

      if (req.query.error || !req.query.code) {
        const reason = mapGoogleError(req.query.error ?? "error");
        await deps.hub.dispatch(sessionId, { type: "oauth_failed", reason });
        return oauthResultPage(
          false,
          reason === "admin_blocked"
            ? "Your organization blocks this app"
            : "Nothing was connected",
          reason === "admin_blocked"
            ? "Your Google Workspace admin does not allow this app. A personal Gmail account works."
            : "No access was granted. You can try again from the link in your messages.",
        );
      }

      const token = await exchangeCode(deps, req.query.code, flow.verifier).catch(
        (err: unknown) => {
          deps.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "oauth code exchange failed",
          );
          return null;
        },
      );
      if (!token) {
        await deps.hub.dispatch(sessionId, { type: "oauth_failed", reason: "error" });
        return oauthResultPage(
          false,
          "Google hit an error",
          "Nothing was connected. You can try again from your messages.",
        );
      }
      const scopes = token.scope.split(/\s+/);
      const hasGmail = scopes.includes(GMAIL_SCOPE);
      if (hasGmail) deps.inbox.connectGmail(sessionId, token.accessToken, token.expiresIn);
      await deps.hub.dispatch(sessionId, {
        type: "oauth_done",
        scopes,
        email: token.email,
        name: token.name,
      });
      return hasGmail
        ? oauthResultPage(
            true,
            "Gmail connected",
            `Connected ${escapeHtml(token.email)}, read-only.`,
          )
        : oauthResultPage(
            false,
            "Gmail was not checked",
            "You signed in, but the Gmail box was unchecked, so nothing can be read. Try again and leave it checked.",
          );
    },
  );

  app.post<{ Body: { t?: string } }>("/connect/sample", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const sessionId = verifyLink(deps.secret, req.body?.t, now());
    if (!sessionId)
      return oauthResultPage(false, "This link expired", "Text your assistant for a fresh link.");
    finish(sessionId);
    deps.inbox.connectDemo(sessionId);
    await deps.hub.dispatch(sessionId, {
      type: "oauth_done",
      scopes: SCOPES,
      email: "sample inbox",
      name: null,
      demo: true,
    });
    return oauthResultPage(
      true,
      "Sample inbox connected",
      "Your assistant will look through a sample inbox, not your real email.",
    );
  });

  return {
    link: (sessionId: string) =>
      `${deps.baseUrl}${connectPath}?t=${signLink(deps.secret, sessionId, now())}`,
    /** The simulator reports that the connect popup closed. No callback means they backed out. */
    popupClosed(sessionId: string) {
      const o = opened.get(sessionId);
      if (!o || o.done) return;
      setTimeout(() => {
        const again = opened.get(sessionId);
        if (!again || again.done) return;
        again.done = true;
        void deps.hub.dispatch(sessionId, { type: "oauth_failed", reason: "cancelled" });
      }, CLOSE_GRACE_MS);
    },
  };
}

interface TokenResult {
  accessToken: string;
  expiresIn: number;
  scope: string;
  email: string;
  name: string | null;
}

async function exchangeCode(deps: OAuthDeps, code: string, verifier: string): Promise<TokenResult> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: deps.clientId ?? "",
      client_secret: deps.clientSecret ?? "",
      redirect_uri: deps.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!body.access_token || !body.id_token) throw new Error("token response is missing fields");
  // The ID token came straight from Google over TLS, so its payload can be read without re-verifying the signature.
  const claims = JSON.parse(
    Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as {
    email?: string;
    given_name?: string;
    name?: string;
  };
  if (!claims.email) throw new Error("no email in the ID token");
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? 3600,
    scope: body.scope ?? "",
    email: claims.email,
    name: claims.given_name ?? claims.name ?? null,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
