// Builds the brain and its model dependencies from the environment.

import { Brain } from "../brain/brain.ts";
import { DEFAULT_CONFIG } from "../brain/config.ts";
import { LlmInterpreter } from "../brain/interpret.ts";
import { LlmRenderer, TemplateRenderer } from "../brain/render.ts";
import { modelsFromEnv, OpenAiClient } from "../llm/openai.ts";

export function buildBrain(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
): { brain: Brain; models: string } {
  const cfg = DEFAULT_CONFIG;
  const template = new TemplateRenderer(cfg.nameIdeas);
  const links = () => ({ legal: `${baseUrl}/legal`, gmail: `${baseUrl}/connect/gmail` });
  if (!env.OPENAI_API_KEY) {
    return {
      brain: new Brain({ cfg, interpreter: null, renderer: null, template, links }),
      models: "none (keyword interpreter, template replies)",
    };
  }
  const llm = new OpenAiClient(env.OPENAI_API_KEY);
  const models = modelsFromEnv(env);
  return {
    brain: new Brain({
      cfg,
      interpreter: new LlmInterpreter(llm, models.fast),
      renderer: new LlmRenderer(llm, models.reply, cfg.nameIdeas),
      template,
      links,
    }),
    models: `interpreter ${models.fast}, replies ${models.reply}`,
  };
}
