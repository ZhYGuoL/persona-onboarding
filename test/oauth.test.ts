import fastifyFormbody from "@fastify/formbody";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GMAIL_SCOPE } from "../src/brain/brain.ts";
import type { InboxService } from "../src/inbox/service.ts";
import { mapGoogleError, registerOAuth, signLink, verifyLink } from "../src/server/oauth.ts";
import { World } from "./world.ts";

const SECRET = "test-secret";

function fakeInbox() {
  const calls: string[] = [];
  return {
    calls,
    inbox: {
      connectGmail: (sid: string, token: string) => calls.push(`gmail:${sid}:${token}`),
      connectDemo: (sid: string) => calls.push(`demo:${sid}`),
    } as unknown as InboxService,
  };
}

async function setup() {
  const w = new World({ caps: { gmail: true } });
  const app = Fastify();
  await app.register(fastifyFormbody);
  const { inbox, calls } = fakeInbox();
  const oauth = registerOAuth(app, {
    hub: w.hub,
    inbox,
    secret: SECRET,
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/auth/google/callback",
    baseUrl: "http://localhost:3000",
    log: { warn: () => {} },
  });
  const t = signLink(SECRET, w.sid, Date.now());
  const events = () =>
    w.store
      .events(w.sid)
      .filter((e) => e.dir === "in")
      .map((e) => e.type);
  return { w, app, oauth, t, calls, events };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect links", () => {
  it("are signed and expire", () => {
    const now = Date.now();
    const t = signLink(SECRET, "s1", now);
    expect(verifyLink(SECRET, t, now)).toBe("s1");
    expect(verifyLink("other-secret", t, now)).toBeNull();
    expect(verifyLink(SECRET, t.replace("s1", "s2"), now)).toBeNull();
    expect(verifyLink(SECRET, t, now + 25 * 60 * 60_000)).toBeNull();
    expect(verifyLink(SECRET, undefined, now)).toBeNull();
  });

  it("maps Google's errors", () => {
    expect(mapGoogleError("access_denied")).toBe("access_denied");
    expect(mapGoogleError("admin_policy_enforced")).toBe("admin_blocked");
    expect(mapGoogleError("server_error")).toBe("error");
  });
});

describe("oauth routes", () => {
  it("the connect page offers Google and the sample inbox, and an expired link says so", async () => {
    const { app, t } = await setup();
    const page = await app.inject(`/connect/gmail?t=${encodeURIComponent(t)}`);
    expect(page.body).toContain("Continue with Google");
    expect(page.body).toContain("Use a sample inbox instead");
    const expired = await app.inject("/connect/gmail?t=bogus");
    expect(expired.body).toContain("This link expired");
  });

  it("starts Google sign-in with PKCE, the Gmail scope, and the account picker", async () => {
    const { app, t } = await setup();
    const res = await app.inject(`/auth/google/start?t=${encodeURIComponent(t)}`);
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toContain(GMAIL_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
  });

  it("the sample inbox connects without Google", async () => {
    const { app, t, w, calls } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/connect/sample",
      payload: `t=${encodeURIComponent(t)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.body).toContain("Sample inbox connected");
    await w.settle();
    expect(calls).toEqual([`demo:${w.sid}`]);
    expect(w.state.slots.gmail).toMatchObject({ status: "confirmed", source: "sample_inbox" });
  });

  it("a denied consent tells the brain, and an admin block says what works instead", async () => {
    const { app, t, w, events } = await setup();
    const start = await app.inject(`/auth/google/start?t=${encodeURIComponent(t)}`);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const res = await app.inject(
      `/auth/google/callback?state=${state}&error=admin_policy_enforced`,
    );
    expect(res.body).toContain("A personal Gmail account works");
    await w.settle();
    expect(events()).toContain("oauth_failed");
    // The same state cannot be replayed.
    const replay = await app.inject(`/auth/google/callback?state=${state}&code=abc`);
    expect(replay.body).toContain("This sign-in expired");
  });

  it("an unchecked Gmail box is detected from the granted scopes, and no token is kept", async () => {
    const { app, t, w, calls } = await setup();
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "dana@gmail.com", given_name: "Dana" })).toString("base64url")}.y`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "secret-token",
          expires_in: 3599,
          scope: "openid email profile",
          id_token: idToken,
        }),
      ),
    );
    const start = await app.inject(`/auth/google/start?t=${encodeURIComponent(t)}`);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const res = await app.inject(`/auth/google/callback?state=${state}&code=abc`);
    expect(res.body).toContain("the Gmail box was unchecked");
    expect(calls).toEqual([]);
    await w.settle();
    expect(w.state.slots.gmail.status).toBe("unknown");
  });

  it("a full grant connects Gmail, and the token never reaches the page or the session state", async () => {
    const { app, t, w, calls } = await setup();
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "dana@gmail.com", given_name: "Dana" })).toString("base64url")}.y`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "secret-token",
          expires_in: 3599,
          scope: `openid email profile ${GMAIL_SCOPE}`,
          id_token: idToken,
        }),
      ),
    );
    const start = await app.inject(`/auth/google/start?t=${encodeURIComponent(t)}`);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const res = await app.inject(`/auth/google/callback?state=${state}&code=abc`);
    expect(res.body).toContain("Connected dana@gmail.com");
    expect(res.body).not.toContain("secret-token");
    expect(calls).toEqual([`gmail:${w.sid}:secret-token`]);
    await w.settle();
    expect(w.state.slots.gmail).toMatchObject({ status: "confirmed", value: "dana@gmail.com" });
    expect(JSON.stringify(w.state)).not.toContain("secret-token");
    expect(JSON.stringify(w.store.events(w.sid))).not.toContain("secret-token");
  });

  it("a close signal after reaching Google is ignored; only a missing callback counts", async () => {
    vi.useFakeTimers();
    try {
      const { app, t, oauth, w, events } = await setup();
      await app.inject(`/connect/gmail?t=${encodeURIComponent(t)}`);
      await app.inject(`/auth/google/start?t=${encodeURIComponent(t)}`);
      oauth.popupClosed(w.sid);
      await vi.advanceTimersByTimeAsync(10_000);
      await w.settle();
      expect(events()).not.toContain("oauth_failed");
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await w.settle();
      expect(events()).toContain("oauth_failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing the popup without finishing counts as a cancel", async () => {
    vi.useFakeTimers();
    try {
      const { app, t, oauth, w, events } = await setup();
      await app.inject(`/connect/gmail?t=${encodeURIComponent(t)}`);
      oauth.popupClosed(w.sid);
      await vi.advanceTimersByTimeAsync(2500);
      await w.settle();
      expect(events()).toContain("oauth_failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
