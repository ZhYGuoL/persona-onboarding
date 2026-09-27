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
import { buildBrain } from "./deps.ts";
import { legalPage, privacyPage, termsPage } from "./pages.ts";
import { attachTextChannel } from "./ws.ts";

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
const { brain, models } = buildBrain(env, baseUrl);
const hub = new Hub({
  store,
  clock: new RealClock(),
  brain,
  // Milestone 1 is text only. Voice and Gmail turn on in milestones 2 and 3.
  defaultCaps: { voice: false, gmail: false },
  onError: (err, sessionId) => app.log.error({ err, sessionId }, "hub error"),
});

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

app.get("/ws", { websocket: true }, (socket, req) => {
  const id = sessionFrom(req);
  if (!id) {
    socket.close(4401, "no session");
    return;
  }
  attachTextChannel(hub, id, socket);
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
