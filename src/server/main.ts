// HTTP and WebSocket server. One long-lived process owns every session's
// brain, so timers and live calls survive across requests.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { RealClock } from "../runtime/clock.ts";
import { Hub } from "../runtime/hub.ts";
import { Store } from "../runtime/store.ts";
import { CallNotActiveError, VoiceManager } from "../voice/live.ts";
import { buildBrain } from "./deps.ts";
import { legalPage, privacyPage, termsPage } from "./pages.ts";
import { attachChannel } from "./ws.ts";

const env = process.env;
const isProd = env.NODE_ENV === "production";
const port = Number(env.PORT ?? 3000);
const baseUrl = (env.APP_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const root = resolve(import.meta.dirname, "../..");
const COOKIE = "sid";

if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL ?? "info",
    redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
  },
});

const store = new Store(env.DATABASE_PATH ?? join(root, "data/persona.db"));
const clock = new RealClock();
const { brain, models } = buildBrain(env, baseUrl);
const hub = new Hub({
  store,
  clock,
  brain,
  // Voice needs the API key. The page also reports whether the browser can do WebRTC.
  // Gmail turns on in milestone 3.
  defaultCaps: { voice: Boolean(env.OPENAI_API_KEY), gmail: false },
  onError: (err, sessionId) => app.log.error({ err, sessionId }, "hub error"),
});
const voice = env.OPENAI_API_KEY
  ? new VoiceManager({
      hub,
      cfg: brain.cfg,
      apiKey: env.OPENAI_API_KEY,
      clock,
      voice: env.LIVE_VOICE || "marin",
      log: app.log,
    })
  : null;
if (voice)
  hub.subscribeAll((msg) => msg.type === "action" && voice.onAction(msg.sessionId, msg.action));

await app.register(fastifyCookie, { secret: env.SESSION_SECRET });
await app.register(fastifyWebsocket);

function sessionFrom(req: FastifyRequest): string | null {
  const raw = req.cookies[COOKIE];
  if (!raw) return null;
  const un = req.unsignCookie(raw);
  return un.valid ? un.value : null;
}

function newSession(reply: FastifyReply): string {
  const id = randomUUID();
  reply.setCookie(COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    signed: true,
    maxAge: 60 * 60 * 24 * 30,
  });
  return id;
}

app.get("/healthz", async () => ({ ok: true }));

app.get("/api/session", async (req, reply) => {
  const id = sessionFrom(req) ?? newSession(reply);
  return { sessionId: id };
});

app.post("/api/reset", async (_req, reply) => {
  return { sessionId: newSession(reply) };
});

app.post<{ Body: { ms?: unknown } }>("/api/reviewer/fast-forward", async (req, reply) => {
  const id = sessionFrom(req);
  const ms = Number(req.body?.ms);
  if (!id) return reply.code(401).send({ error: "no session" });
  if (!Number.isFinite(ms) || ms <= 0 || ms > 7 * 24 * 3600_000) {
    return reply.code(400).send({ error: "ms must be between 1 and one week" });
  }
  await hub.fastForward(id, ms);
  return { now: hub.now(id) };
});

app.post<{ Body: { callId?: unknown; sdp?: unknown } }>("/api/call/offer", async (req, reply) => {
  const id = sessionFrom(req);
  if (!id) return reply.code(401).send({ error: "no session" });
  if (!voice) return reply.code(503).send({ error: "voice is not available" });
  const { callId, sdp } = req.body ?? {};
  if (
    typeof callId !== "string" ||
    typeof sdp !== "string" ||
    !sdp.trim() ||
    sdp.length > 100_000
  ) {
    return reply.code(400).send({ error: "callId and an SDP offer are required" });
  }
  try {
    return { sdp: await voice.connect(id, callId, sdp) };
  } catch (err) {
    if (err instanceof CallNotActiveError) return reply.code(409).send({ error: err.message });
    req.log.error({ err }, "live session creation failed");
    return reply.code(502).send({ error: "could not start the call" });
  }
});

app.post("/api/reviewer/drop-call", async (req, reply) => {
  const id = sessionFrom(req);
  if (!id) return reply.code(401).send({ error: "no session" });
  const call = hub.state(id).call;
  if (call.status === "idle" || !call.callId) return reply.code(409).send({ error: "no call" });
  // Simulate the network dropping the call mid-sentence.
  if (voice) voice.endFromClient(id, call.callId, "connection_lost");
  else
    await hub.dispatch(id, { type: "call_ended", callId: call.callId, reason: "connection_lost" });
  return { ok: true };
});

app.post<{ Body: { ms?: unknown } }>("/api/reviewer/lag", async (req, reply) => {
  const id = sessionFrom(req);
  const ms = Number(req.body?.ms);
  if (!id) return reply.code(401).send({ error: "no session" });
  if (!Number.isFinite(ms) || ms < 0 || ms > 20_000) {
    return reply.code(400).send({ error: "ms must be between 0 and 20000" });
  }
  hub.setLag(id, ms);
  return { lagMs: ms };
});

app.get("/ws", { websocket: true }, (socket, req) => {
  const id = sessionFrom(req);
  if (!id) {
    socket.close(4401, "no session");
    return;
  }
  attachChannel({ hub, voice }, id, socket);
});

const html = (body: string) => (_req: FastifyRequest, reply: FastifyReply) =>
  reply.type("text/html; charset=utf-8").send(body);
app.get("/legal", html(legalPage()));
app.get("/privacy", html(privacyPage()));
app.get("/terms", html(termsPage()));

if (isProd) {
  await app.register(fastifyStatic, { root: join(root, "dist/web"), wildcard: false });
  app.get("/", (_req, reply) => reply.sendFile("index.html"));
} else {
  const { createServer } = await import("vite");
  const middie = (await import("@fastify/middie")).default;
  await app.register(middie);
  const vite = await createServer({
    configFile: join(root, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { port: 24678 } },
    appType: "custom",
    // The default loader writes a temp file that makes `node --watch` restart in a loop.
    configLoader: "native",
  });
  app.use(vite.middlewares);
  app.get("/", async (req, reply) => {
    const template = await readFile(join(root, "src/web/index.html"), "utf8");
    const page = await vite.transformIndexHtml(req.url, template);
    return reply.type("text/html; charset=utf-8").send(page);
  });
}

const restored = hub.restore();
await app.listen({ port, host: "0.0.0.0" });
app.log.info({ models, restored, baseUrl }, "persona onboarding is up");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}
