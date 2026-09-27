// Builds the brain and its model dependencies from the environment.

import { Brain } from "../brain/brain.ts";
import { DEFAULT_CONFIG } from "../brain/config.ts";
import { LlmInterpreter } from "../brain/interpret.ts";
import { LlmRenderer, TemplateRenderer } from "../brain/render.ts";
import { type LlmClient, modelsFromEnv, OpenAiClient } from "../llm/openai.ts";
import { signLink } from "./oauth.ts";

export interface BuiltBrain {
  brain: Brain;
  /** Null without an API key. Inbox scans need it. */
  llm: LlmClient | null;
  fastModel: string;
  /** Writes replies, task results, and drafts. */
  replyModel: string;
  summary: string;
}

export function buildBrain(env: NodeJS.ProcessEnv, baseUrl: string, secret: string): BuiltBrain {
  const cfg = DEFAULT_CONFIG;
  const template = new TemplateRenderer(cfg.nameIdeas);
  const links = (sessionId: string) => ({
    legal: `${baseUrl}/legal`,
    gmail: `${baseUrl}/connect/gmail?t=${signLink(secret, sessionId, Date.now())}`,
  });
  const models = modelsFromEnv(env);
  if (!env.OPENAI_API_KEY) {
    return {
      brain: new Brain({ cfg, interpreter: null, renderer: null, template, links }),
      llm: null,
      fastModel: models.fast,
      replyModel: models.reply,
      summary: "none (keyword interpreter, template replies)",
    };
  }
  const llm = new OpenAiClient(env.OPENAI_API_KEY);
  return {
    brain: new Brain({
      cfg,
      interpreter: new LlmInterpreter(llm, models.fast),
      renderer: new LlmRenderer(llm, models.reply, cfg.nameIdeas),
      template,
      links,
    }),
    llm,
    fastModel: models.fast,
    replyModel: models.reply,
    summary: `interpreter ${models.fast}, replies ${models.reply}`,
  };
}
