// What the voice session hears when a call starts. Milestone 2 wires this into
// GPT-Live with `session.instructions.append`. The disclosure wording is exact.

import type { BrainConfig } from "./config.ts";
import { agentDisplayName } from "./ledger.ts";
import type { SessionState } from "./types.ts";

export function disclosureLine(s: SessionState, cfg: BrainConfig): string {
  return `Hey, it's ${agentDisplayName(s, cfg)}, your AI assistant from Persona.`;
}

export function callBrief(s: SessionState, cfg: BrainConfig): string {
  const { user_name, help_need, gmail } = s.slots;
  const known = [
    user_name.value ? `The user's name is ${user_name.value} (${user_name.status}).` : null,
    help_need.value ? `They want help with: ${help_need.value}.` : null,
    gmail.status === "confirmed" ? `Gmail is connected (${gmail.value}).` : null,
  ].filter(Boolean);
  const goals = [
    user_name.status === "unknown" || user_name.status === "tentative"
      ? "Get their first name. Confirm the spelling if it is unusual, then call save_user_name."
      : null,
    help_need.status === "unknown"
      ? 'Ask "what\'s the most annoying thing on your plate this week?" and call save_help_need with a short summary.'
      : null,
    gmail.status !== "confirmed" && gmail.status !== "declined" && s.caps.gmail
      ? "Tie Gmail to what they need, then call send_gmail_link. Ask once. If they say no, drop it."
      : null,
  ].filter(Boolean);
  return [
    `Your first sentence must be exactly: "${disclosureLine(s, cfg)}"`,
    s.call.answered > 1
      ? "This is a callback. Do not start over. Pick up where you left off."
      : null,
    ...known,
    goals.length
      ? `Goals, one question at a time: ${goals.join(" ")}`
      : "You have what you need. Wrap up warmly.",
    "Never ask for something you already have. Keep it short and natural. When done, say a short goodbye and end the call.",
  ]
    .filter(Boolean)
    .join("\n");
}
