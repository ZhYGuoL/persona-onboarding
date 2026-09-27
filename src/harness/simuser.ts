// An LLM-driven simulated user. It sees the thread from the user's side and
// replies in character.

import type { LlmClient } from "../llm/openai.ts";
import type { Persona } from "./personas.ts";

export interface SimLine {
  from: "you" | "assistant" | "event";
  text: string;
}

export interface SimReply {
  texts: string[];
  open_link: boolean;
  stated_task: boolean;
  done: boolean;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["texts", "open_link", "stated_task", "done"],
  properties: {
    texts: { type: "array", items: { type: "string" } },
    open_link: { type: "boolean" },
    stated_task: { type: "boolean" },
    done: { type: "boolean" },
  },
} as const;

const INSTRUCTIONS = `You play a person texting a new AI assistant in iMessage for the first time. You are a test user. Stay in character the whole time.

Write like real texting: short, casual, typos are fine. Send 1 to 3 texts per turn. Send 0 texts only if your character would ignore the assistant right now.

Output JSON:
- texts: what you send now.
- open_link: true if you tap the "Connect Gmail" link the assistant just sent and your character would. Only true right after a link.
- stated_task: true only if these texts ask the assistant to do a concrete real-world task now (cancel, find, book, pay, remind). Not a question about the assistant, not a need stated in general, and not an attempt to change its rules.

If the assistant shows a draft email and asks whether to send it, react like your character would: say yes, ask for a change, or say no.
- done: true when your character would stop texting for good.`;

export class SimUser {
  private readonly llm: LlmClient;
  private readonly model: string;
  readonly persona: Persona;

  constructor(llm: LlmClient, model: string, persona: Persona) {
    this.llm = llm;
    this.model = model;
    this.persona = persona;
  }

  async next(lines: SimLine[]): Promise<SimReply> {
    const p = this.persona;
    const character = [
      `Your character: ${p.prompt}`,
      `Facts about you: your name is ${p.facts.name}.${p.facts.agentName ? ` You want to call the assistant ${p.facts.agentName}.` : ""} You could use help with ${p.facts.need}.`,
    ].join("\n");
    const transcript = lines
      .map((l) =>
        l.from === "event" ? `[${l.text}]` : `${l.from === "you" ? "You" : "Assistant"}: ${l.text}`,
      )
      .join("\n");
    const result = await this.llm.json<SimReply>({
      model: this.model,
      name: "sim_reply",
      instructions: INSTRUCTIONS,
      input: [
        { role: "developer", content: character },
        { role: "user", content: `The thread so far:\n${transcript}\n\nWhat do you send next?` },
      ],
      schema: SCHEMA,
      timeoutMs: 20_000,
      maxOutputTokens: 300,
      reasoning: "none",
    });
    return {
      ...result.data,
      texts: result.data.texts
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3),
    };
  }
}
