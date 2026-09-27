import { describe, expect, it } from "vitest";
import { emptyPlan } from "../src/brain/decide.ts";
import {
  type Rendered,
  type Renderer,
  renderTurn,
  TemplateRenderer,
  translateMarked,
} from "../src/brain/render.ts";
import type { Plan } from "../src/brain/types.ts";
import { World } from "./world.ts";

/** A stand-in translator: tags each line, and can be told to drop tokens. */
function fakeTranslator(opts: { dropTokens?: boolean } = {}) {
  const calls: Array<{ lines: string[]; language: string }> = [];
  return {
    calls,
    async translate(lines: string[], language: string) {
      calls.push({ lines, language });
      return lines.map(
        (l) => `[${language}] ${opts.dropTokens ? l.replace(/\{\{v\d+\}\}/g, "") : l}`,
      );
    },
  };
}

const V = (s: string) => `\u0001${s}\u0002`;

describe("translating template lines", () => {
  it("keeps marked values exact through tokens", async () => {
    const t = fakeTranslator();
    const r: Rendered = {
      intro: [],
      body: [`From ${V("Con Edison")}, Sep 23: “${V("Due date: Tue, Oct 6")}”`, "Send it?"],
    };
    const out = await translateMarked(r, "es", t.translate);
    expect(t.calls[0]?.lines[0]).toBe("From {{v1}}, Sep 23: “{{v2}}”");
    expect(out.body[0]).toBe(
      `[es] From ${V("Con Edison")}, Sep 23: “${V("Due date: Tue, Oct 6")}”`,
    );
    expect(out.body[1]).toBe("[es] Send it?");
  });

  it("refuses a translation that drops a value", async () => {
    const t = fakeTranslator({ dropTokens: true });
    await expect(
      translateMarked({ intro: [], body: [`Hi ${V("Priya")}`] }, "es", t.translate),
    ).rejects.toThrow(/dropped/);
  });
});

describe("template turns in another language", () => {
  async function spanishPlan(): Promise<{ plan: Plan; history: [] }> {
    const w = new World({ caps: { tasks: true } });
    await w.say("hola");
    const plan = emptyPlan(w.state, w.cfg);
    plan.facts = { ...plan.facts, language: "es", casing: "normal" };
    plan.acks = [
      {
        kind: "task_result",
        taskId: 1,
        result: {
          kind: "draft",
          text: "Aquí tienes una respuesta para Mark.",
          draft: { to: "mark@gmail.com", subject: "Re: lease", body: "Hola Mark", threadId: "t" },
          receipt: {
            threadId: "t",
            from: "Mark Delgado",
            subject: "Lease renewal",
            date: Date.UTC(2026, 8, 25, 15),
            quote: "Can you let me know by Friday?",
          },
        },
      },
    ];
    plan.question = { kind: "confirm_send", taskId: 1 };
    return { plan, history: [] };
  }

  it("a task result for a Spanish speaker is translated, with the quote and the draft untouched", async () => {
    const t = fakeTranslator();
    const renderer: Renderer = {
      render: async () => ({ intro: [], body: [] }),
      translate: t.translate,
    };
    const { plan, history } = await spanishPlan();
    const out = await renderTurn(
      { plan, history, links: { legal: "l", gmail: "g" } },
      renderer,
      new TemplateRenderer(["Nova"]),
    );
    const texts = out.bubbles.flatMap((b) => (b.kind === "text" ? [b.text] : []));
    expect(texts.every((x) => x.startsWith("[es]"))).toBe(true);
    expect(texts.join(" ")).toContain("“Can you let me know by Friday?”");
    expect(out.bubbles.find((b) => b.kind === "draft")).toMatchObject({ body: "Hola Mark" });
    expect(t.calls).toHaveLength(1);
  });

  it("English turns skip the translation", async () => {
    const t = fakeTranslator();
    const renderer: Renderer = {
      render: async () => ({ intro: [], body: [] }),
      translate: t.translate,
    };
    const { plan, history } = await spanishPlan();
    plan.facts = { ...plan.facts, language: "en" };
    await renderTurn(
      { plan, history, links: { legal: "l", gmail: "g" } },
      renderer,
      new TemplateRenderer(["Nova"]),
    );
    expect(t.calls).toHaveLength(0);
  });
});

describe("texts sent during a call", () => {
  it("the Gmail link line follows a Spanish caller's language", async () => {
    const t = fakeTranslator();
    const renderer: Renderer = {
      render: async () => ({ intro: [], body: [] }),
      translate: t.translate,
    };
    const w = new World({ caps: { voice: true, gmail: true }, renderer });
    await w.say("hola");
    await w.say("juno", { agent_name: { value: "juno", correction: false } });
    await w.say("sí", { reply_to_pending: "yes" });
    await w.event({ type: "call_answered", callId: w.of("ring_phone").at(-1)?.callId ?? "" });
    await w.hear("quiero ayuda con mis facturas", {
      language: "es",
      help_need: "pagar las facturas",
    });
    const link = w.turns().find((x) => x.links.some((l) => l.includes("/connect/gmail")));
    expect(link?.texts[0]).toMatch(/^\[es\] /);
  });
});
