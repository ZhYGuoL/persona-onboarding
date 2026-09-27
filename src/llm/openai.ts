// Thin wrapper over the OpenAI Responses API for structured JSON output.
// It adds a hard timeout, one retry on transient errors, and cost tracking,
// so the stress harness can stop before it spends past a budget.

import OpenAI from "openai";

export interface JsonRequest {
  model: string;
  name: string;
  instructions: string;
  input: Array<{ role: "user" | "assistant" | "developer"; content: string }>;
  schema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputTokens?: number;
  reasoning?: "none" | "low" | "medium";
}

export interface JsonResult<T> {
  data: T;
  latencyMs: number;
  usage: Usage;
}

export interface Usage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LlmClient {
  json<T>(req: JsonRequest): Promise<JsonResult<T>>;
}

/** USD per 1M tokens: input, cached input, output. From the model pages, 2026-09-26. */
const PRICES: Record<string, [number, number, number]> = {
  "gpt-6-luna": [0.1, 0.01, 0.5],
  "gpt-6-sol": [2, 0.2, 10],
  "gpt-6-astra": [10, 1, 50],
  "gpt-5.6-luna": [0.2, 0.02, 1.2],
  "gpt-5.6-terra": [2, 0.2, 12],
  "gpt-5.6-sol": [4, 0.4, 20],
};

export function priceUsd(model: string, input: number, cached: number, output: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return ((input - cached) * p[0] + cached * p[1] + output * p[2]) / 1_000_000;
}

export class BudgetExceededError extends Error {}

export class CostMeter {
  usd = 0;
  calls = 0;
  readonly limitUsd: number;
  constructor(limitUsd = Number.POSITIVE_INFINITY) {
    this.limitUsd = limitUsd;
  }
  add(u: Usage): void {
    this.usd += u.usd;
    this.calls += 1;
  }
  check(): void {
    if (this.usd >= this.limitUsd) {
      throw new BudgetExceededError(`LLM budget of $${this.limitUsd.toFixed(2)} is spent`);
    }
  }
}

export class OpenAiClient implements LlmClient {
  private readonly client: OpenAI;
  readonly meter: CostMeter;

  constructor(apiKey: string, meter = new CostMeter()) {
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
    this.meter = meter;
  }

  async json<T>(req: JsonRequest): Promise<JsonResult<T>> {
    this.meter.check();
    let lastError: unknown;
    const deadline = performance.now() + req.timeoutMs;
    for (let attempt = 0; attempt < 4; attempt++) {
      const started = performance.now();
      try {
        const response = await this.client.responses.create(
          {
            model: req.model,
            instructions: req.instructions,
            input: req.input,
            store: false,
            reasoning: { effort: req.reasoning ?? "none" },
            max_output_tokens: req.maxOutputTokens ?? 800,
            text: {
              format: { type: "json_schema", name: req.name, schema: req.schema, strict: true },
            },
          },
          { timeout: Math.max(1000, Math.round(deadline - started)) },
        );
        const latencyMs = performance.now() - started;
        const u = response.usage;
        const cached = u?.input_tokens_details?.cached_tokens ?? 0;
        const usage: Usage = {
          inputTokens: u?.input_tokens ?? 0,
          cachedTokens: cached,
          outputTokens: u?.output_tokens ?? 0,
          usd: priceUsd(req.model, u?.input_tokens ?? 0, cached, u?.output_tokens ?? 0),
        };
        this.meter.add(usage);
        if (response.status !== "completed") {
          throw new Error(
            `response ${response.status}: ${response.incomplete_details?.reason ?? ""}`,
          );
        }
        return { data: JSON.parse(response.output_text) as T, latencyMs, usage };
      } catch (err) {
        lastError = err;
        const wait = retryDelayMs(err, attempt);
        if (wait === null || performance.now() + wait > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  }
}

/**
 * How long to wait before a retry, or null to give up. Rate limits (429) and
 * connection errors get up to three retries, and 429s honor the server's "try
 * again in" hint. Server errors get one retry. Timeouts and quota errors never retry.
 */
export function retryDelayMs(err: unknown, attempt: number): number | null {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return null;
  const jitter = Math.random() * 150;
  if (err instanceof OpenAI.APIConnectionError)
    return attempt < 3 ? 300 * 2 ** attempt + jitter : null;
  if (!(err instanceof OpenAI.APIError)) return null;
  if (err.status === 429) {
    if (err.code === "insufficient_quota" || attempt >= 3) return null;
    const hint = rateLimitHintMs(err);
    return Math.min(4000, Math.max(hint ?? 0, 250 * 2 ** attempt) + jitter);
  }
  if ((err.status ?? 0) >= 500 && attempt === 0) return 300 + jitter;
  return null;
}

function rateLimitHintMs(err: InstanceType<typeof OpenAI.APIError>): number | null {
  const header = err.headers?.get?.("retry-after-ms");
  if (header && Number.isFinite(Number(header))) return Number(header);
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(err.message);
  if (!m?.[1]) return null;
  return m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
}

export interface ModelChoice {
  /** Fast tier: interpreter, simulated users, judges. */
  fast: string;
  /** Reply tier: the agent's texts. */
  reply: string;
}

export function modelsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const reply = env.OPENAI_TEXT_MODEL || "gpt-6-luna";
  const fast = env.OPENAI_FAST_MODEL || "gpt-6-luna";
  return { fast, reply };
}
