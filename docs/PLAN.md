# Build plan

This file tracks the plan per milestone.
`BRIEF.md` is the spec. `docs/DECISIONS.md` records the reasons for each choice.

## Milestone 1: brain, text channel, ledger, event log, fake clock, text stress harness

### Goal

One brain per session runs the full onboarding by text.
It survives the text-side rows of the failure matrix.
A stress harness with LLM-driven users grades hard invariants in code and writes a results table.

### Shape of the brain

The brain splits every turn into three steps:

1. **Interpret** (LLM, fast model). Read the new user texts and return structured facts: slot values, corrections, refusals, yes/no answers, a concrete task, opt-out, age, injection attempts, language.
2. **Decide** (pure code, no LLM). Apply the facts to the slot ledger and pick the plan for this turn: what to acknowledge, what to answer, and at most one question. All invariants live here: ask budget, one question per turn, never re-ask a confirmed slot, graduation, call offer budget.
3. **Render** (LLM, reply model). Write the plan as short texts in Persona's voice. A code guard checks the output (question count, length, canary leak). If the guard fails twice or the model times out, a template renderer writes the turn.

The LLM never decides what to ask. It only understands and phrases.
This keeps every invariant testable without a model.

Events in: `text_in`, `client_connected`, `call_answered`, `call_declined`, `call_ended{reason}`, `voice_tool`, `transcript_final`, `oauth_done`, `oauth_failed`, `timer_fired`, `capabilities`.
Actions out: `send_text`, `send_link`, `typing`, `ring_phone`, `push_to_call`, `end_call`, `schedule_timer`, `cancel_timer`.

Call and Gmail events are in the brain from day one.
Milestone 1 tests them with fake events. Milestones 2 and 3 add the real voice and OAuth adapters.

### Work items

1. Scaffold: pnpm, TypeScript run by Node's native type stripping, Vitest, Biome, Fastify, Vite + React.
2. Brain core: types, slot ledger, validators, `decide()`, template renderer.
3. LLM layer: OpenAI Responses client with timeouts, retries, and cost tracking. Interpreter and renderer with structured outputs.
4. Runtime: clock (real, fake, per-session offset), SQLite store (`node:sqlite`), session hub with a serial queue per session, timers, and turn staleness checks.
5. Text channel: WebSocket adapter, a basic phone thread UI, and a basic reviewer panel (ledger, event timeline, fast-forward, reset).
6. Tests: unit tests for the ledger and `decide()`, and scenario tests for each text-side failure-matrix row with a scripted interpreter and the fake clock.
7. Stress harness: 10 simulated personas, a call simulator for call events, code graders for the invariants, a results table in `docs/stress-results.md`.
8. Browser QA of the text flow.

### Out of scope for milestone 1

Real voice (milestone 2), real Google OAuth and inbox scan (milestone 3), real task execution (milestone 4), final visual style (milestone 6).
The live server runs with `voice` and `gmail` capabilities off until those milestones land. The brain then skips the call offer and the Gmail ask.

### Status (2026-09-26)

Done.
The brain, the text channel, the ledger, the event log, the fake clock, and the stress harness all work.
Browser QA passed at 1440 px and 390 px.
Results are in `docs/stress-results.md`.
Decisions D1 to D29 are in `docs/DECISIONS.md`.

Known gap until milestones 3 and 4: the agent can ask for Gmail but cannot read it yet.
It says so plainly, and the stress harness counts the resulting "connect Gmail so I can look" asks against the `honesty` invariant.

### How to run

1. Run `pnpm install`.
2. Run `pnpm dev`, then open `http://localhost:3000` in desktop Chrome.
3. Run `pnpm test` for the unit and failure-matrix tests (no API key needed).
4. Run `pnpm stress --runs 5` for the stress harness. It needs `OPENAI_API_KEY` and costs about $0.17 per 50 conversations.
5. Run `pnpm eval:interpreter` for the interpreter eval (30 cases, under $0.01).
6. Run `pnpm lint` and `pnpm typecheck` before you commit.

## Milestone 2: next

Voice call in the simulator with GPT-Live, plus hangup, drop, and timer logic.
The brain already handles the call events and the voice tools.
Milestone 2 adds the WebRTC call in the page, the sideband connection from the server, and the call UI (ring screen, in-call screen, iMessage banner).
The first step is a time-boxed GPT-Live spike, as the brief asks.
