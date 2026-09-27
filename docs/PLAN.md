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
Decisions D42 to D56 are in `docs/DECISIONS.md`.

The last M3 stress run passed every invariant at 97% or higher over 49 conversations.
The stress runs found these bugs, and each one is fixed with a regression test:
- "Call the NYT" and "I can take a call" read as call requests, so the agent rang four times (D53).
- The agent said it could not send the Gmail link that the user asked for (D54).
- A failed scan promised "I'll try again later", and later claimed it found nothing (D55).
- "Got it: reminding you before the bill is due" read as a promise (D56).
- A typed name that matched the call got "Fixed", and the confused answer said "I'm Persona" to a user who named the agent.

Real Google consent was verified on 2026-09-27 with the test user, first by Zhiyuan and then again in the browser with his approval:
- The Gmail box unchecked, then checked: the right message each time, from the granted scopes.
- Cancel on Google's screen: "nothing's connected", with no re-ask (fixed after this run).
- The popup closed on Google's page: no false alarm, then "sign-in didn't finish" after 3 minutes.
- A plain scan by text, and a task, both on the real inbox.
- A draft reply to a real sender: addressed from the email's headers, and sent only to the simulated outbox.
- A dev server restart: the next task said it lost access and sent a new link.
- A live call: Gmail connected mid-call, and the agent said a real finding within 12 seconds, then hung up and texted the recap.

Not tested: a Google account outside the test users, which Google blocks on its own page.

## Milestone 4: a real first task

Graduation into a real first task: read the full email behind a finding, and draft the outward action (a cancellation email, a reply to a landlord), which waits for the user's yes.

### Status (2026-09-27)

Done.
A yes to an inbox finding, or a stated task, starts real work on the sample inbox or real Gmail.
Each result is one of five kinds, checked in code: an answer, a draft, a reminder, one question, or a plain "can't".
Every result carries a receipt quoted word for word from the email.
A draft shows as a card and waits for "Send it?". A yes records it in a simulated outbox and says plainly that nothing left the account.
Reminders are real timers in the user's time zone.
An answer ends with one follow-up offer, like "Want me to start on canceling the NYT trial?".
The user can take a request back, and a canceled reminder never goes out.
Decisions D57 to D69 are in `docs/DECISIONS.md`.

Browser QA passed the full loop on the sample inbox: finding, yes, draft card, edit, send, a list task with a follow-up offer, and a reminder that fired on time after a fast-forward.
The last stress run passed every invariant at 96% or higher over 50 conversations, with real tasks. The new `yes_before_send` invariant held on every send.
`pnpm eval:tasks` checks the work step on the real model.

Known gaps:
- Text that code writes (receipt labels, "Send it?", the address question) is English only. The model's own words follow the user's language.
- "Already shown" tracks the email behind each receipt, not every email an answer mentions.
- Real Gmail tasks are covered by unit tests with a faked API. Only the sample inbox was run end to end.

### Plan

A task starts from a stated request ("cancel my gym") or from a yes to an inbox finding ("want me to start on the NYT trial?").
A task service does the work outside the session queue, like the inbox scan, and sends the result back to the brain as an event.
Every result is real or plainly simulated:

| Result | What the user sees |
| --- | --- |
| Answer | The answer, with the receipt: sender, date, and the exact number from the email. |
| Draft email | The receipt, a draft card, and "Send it?". A yes marks it sent and says plainly that nothing left their account. |
| Reminder | "I'll text you on Oct 4 at 9 AM." A timer sends the reminder text for real. |
| Help in the thread | A short answer right in the chat, like a meal plan or the steps to cancel. |
| Cannot | A plain "I can't do that from here yet", plus the closest real thing it can do. |

Steps, each with tests and its own commits:
1. Inbox providers read a full thread. The sample inbox gets fuller bodies with real next steps.
2. Scan findings keep their thread and a suggested next action.
3. A work step picks the thread, reads it, and asks the model for one result in a strict schema.
Code validates the result: a draft goes only to an address in that thread, and no URLs or scam content pass.
4. The brain starts tasks, handles results, and runs the yes, no, and edit loop for drafts.
5. The phone shows a draft card. The reviewer panel shows tasks and the simulated outbox.
6. Calls hand tasks to text: the work runs after the call ends.
7. The stress harness runs the real task service on the sample inbox, and a new code invariant checks that nothing is sent without a yes.

Inputs from the M3 stress run:
- A "yes" to "want me to start there?" leads nowhere today.
The agent says "got it" and then "I can't do that from here yet".
M4 must make that yes start real work, or the offer must not be made.
- An acknowledgment like "got it: reminding you before the bill is due" reads as a promise.
The judge flags it as a false promise when the next sentence says the agent cannot do it.
- Some requests need no tools at all, like "help me plan meals for the week".
The agent refuses them today, but it can do them right in the thread.

## Milestone 5: scale the stress tests, fix failures, measure latency

Budget: at most $2.50 of the remaining OpenAI credit.

### Status (2026-09-27)

Done. Spend was about $2.50, at the cap: $1.24 of GPT-Live (69 calls, 1487 s), $1.01 for three stress runs, and about $0.25 for evals and the text model on calls.

Voice, from `docs/voice-results.md` (nine scripted GPT-Live calls after all fixes, 20 of 20 checks):
- Tap to live session: p50 672 ms, p95 940 ms.
- Tap to first agent audio: p50 1886 ms, p95 1956 ms.
- End of caller speech to agent reply: p50 1125 ms, p95 1253 ms.
- Caller talks over the agent: the agent finishes its sentence, then yields (0.8 to 1.8 s).

Text, from `docs/stress-results.md` (76 conversations, 13 personas): every invariant at 93% or higher.
Across the three runs, `no_duplicates` went from 88% to 97% and `same_language` from 96% to 100%.
Text turn model time: p50 2.5 s, p95 6.3 s. Task work time: p50 1.8 s, p95 4.0 s.

Fixes from the voice runs (D70 to D76): whole caller phrases, one goodbye, shared facts about Persona, a dead-call guard, a spoken check-in, and a Gmail link push that lets the agent finish its sentence.
Fixes from the stress runs (D77 to D87): offers keep their email, stated tasks match findings, no repeated questions, "wrong email" restarts, template variants rotate in any language, reminders quote themselves, edits after a send, and guards against "nothing" needs and prompt talk.

Known gaps:
- About 1 in 20 GPT-Live calls never started its audio clock. The guard ends it at 10 s and texts the user. The cause is not known.
- GPT-Live finishes its current sentence before it yields to an interruption. Only the prompt steers this.
- `honesty` is judged by a model, so its score moves between runs (91% to 99%). The flagged turns were read by hand. Real ones were fixed. The rest are judge noise or adversarial personas.
- The last fix ("No rush" after a repeated question) is covered by unit tests but came after the final stress run.

### Plan

Text:
1. Text that code writes (receipt labels, "Send it?", "Looking into it.") follows the user's language.
A short translation pass keeps quotes, names, and addresses exact.
2. A new invariant, `same_language`, flags agent texts in a different language than the user's.
3. Three new personas aim at the task loop: an editor who revises a draft several times, a user who takes requests back, and a user who asks for things the agent cannot do.
4. The report adds task latency (p50 and p95) next to text-turn latency.

Voice:
5. The browser measures voice latency on every call: time to first audio after the user accepts, and the gap between the end of the user's speech and the start of the agent's reply.
With the test voice, the end of each clip is exact.
6. Scripted voice runs play prerecorded clips into real GPT-Live calls: the happy path, a spelled unusual name, an interruption, silence, Spanish, "are you a bot?", "gotta go", and a dropped line.
A runner in the reviewer panel drives them, so anyone can rerun them without tools.
7. A report script grades the runs from the event log and writes `docs/voice-results.md`.

Then run everything, fix what fails, and record the results.
