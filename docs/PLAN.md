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

## Milestone 2: voice call

### Status (2026-09-27)

Done.
The phone rings, the user accepts, and the browser connects to GPT-Live over WebRTC.
The server attaches a sideband, groups transcripts into utterances, and the brain writes slots from them and steers the call.
The agent opens with the exact AI disclosure, collects the name and the need, wraps up, and hangs up on its own goodbye.
A recap text follows every call.

Browser QA and the test voice passed these flows: accept, decline on the ring screen, ring timeout, drop mid-call with a text 1.6 s later, callback that resumes, "gotta go", text during a call, "stop calling me", a call the user places, and Spanish.
Decisions D30 to D41 are in `docs/DECISIONS.md`.

Not covered in a real browser: a denied microphone (unit tests cover it) and the Messages banner (it shows real content once the Gmail link can go out in milestone 3).

## Milestone 3: Gmail and the inbox scan

### Status (2026-09-27)

Done.
The agent texts a signed Gmail link, tied to the user's need.
It opens a popup with Google or a sample inbox.
On connect, a scan picks one concrete finding.
On a call, the agent says the finding in its own words, then wraps up and hangs up on its goodbye, and the recap text repeats it.

Browser QA passed the sample inbox by text and during a call, where the link arrives as a Messages banner.
It also passed the unchecked Gmail box, cancel, the admin block, a popup closed on our page, and the redirect to Google's account chooser with the right scopes.
Decisions D42 to D52 are in `docs/DECISIONS.md`.

Not verified: the last step of real Google consent (pick an account, then Allow).
QA stayed read-only on Google. Zhiyuan should run it once with a test user.

## Milestone 4: next

Graduation into a real first task: read the full email behind a finding, and draft the outward action (a cancellation email, a reply to a landlord), which waits for the user's yes.

Inputs from the M3 stress run:
- A "yes" to "want me to start there?" leads nowhere today.
The agent says "got it" and then "I can't do that from here yet".
M4 must make that yes start real work, or the offer must not be made.
- An acknowledgment like "got it: reminding you before the bill is due" reads as a promise.
The judge flags it as a false promise when the next sentence says the agent cannot do it.
- Some requests need no tools at all, like "help me plan meals for the week".
The agent refuses them today, but it can do them right in the thread.
