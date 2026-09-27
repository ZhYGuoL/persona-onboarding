# Decisions

Every non-obvious choice, with the reason.
Newest milestone last.
Each entry says what we chose, why, and what we did not choose.

## Milestone 1: brain, text channel, harness

### D1. Stack: Node 24, TypeScript, Fastify, React with Vite

- **Choice.** One Node 24 process runs the server.
Node runs the TypeScript files directly with its built-in type stripping, so the server has no build step.
Fastify serves HTTP and WebSockets.
The simulator page is a React single-page app built by Vite.
- **Why.** The core of this product is a long-lived, stateful process.
It owns timers, WebSockets to the browser, and (in milestone 2) a sideband WebSocket into each live voice session.
A serverless model does not fit that.
- **Not chosen.** Next.js.
It is the default stack, but the app is one page plus three static legal pages.
A Next custom server would also give up most of what Next offers.

### D2. Storage: built-in `node:sqlite`, state snapshot plus append-only log

- **Choice.** Each session has one row with its full state as JSON.
Each session also has an append-only event log: every event in, every action out, and every internal note.
The snapshot is the source of truth for resume.
The log feeds the reviewer timeline and the stress graders.
- **Why.** `node:sqlite` has no native dependency, so installs and deploys cannot break on a compiler.
A snapshot makes resume after a restart trivial.
- **Not chosen.** Pure event sourcing (rebuild state by replaying the log).
The model outputs are not deterministic, so a replay would need every model output stored as an event anyway.
The snapshot gets the same safety with less machinery.

### D3. The brain splits every turn into interpret, decide, render

- **Choice.** A fast model reads the user's texts into structured signals.
Plain code (`decide()`) applies them to the slot ledger.
Then it picks the plan: what to acknowledge, what to answer, and at most one question.
A second model call writes the plan as texts.
A code guard checks the texts.
If the guard fails twice or the model fails, a template renderer writes the turn.
- **Why.** The model never decides what to ask.
So every invariant lives in code: one question per turn, never re-ask a confirmed slot, the ask budget, graduation, and the call offer budget.
Unit tests cover them without a model, and a jailbreak cannot talk them away.
- **Not chosen.** One model call that extracts and replies at once.
It is faster, but invariants would depend on the prompt holding under stress.

### D4. The interpreter returns sparse signals

- **Choice.** The interpreter returns `{language, reply_to_pending, signals: [...]}` with only the signals the message contains, instead of all 22 fields every time.
- **Why.** Output tokens set the latency.
The first version took 1.3 to 3.3 s per read.
The sparse version takes about 1 s.

### D5. Models: `gpt-6-luna` for everything in milestone 1

- **Choice.** `gpt-6-luna` with reasoning effort `none` for the interpreter, the replies, the simulated users, and the judge.
`OPENAI_TEXT_MODEL` sets the reply model and defaults to `gpt-6-luna` when empty.
The new optional `OPENAI_FAST_MODEL` sets the interpreter model.
- **Why.** The account has a hard cap of $10.
Luna costs $0.10 per 1M input tokens and $0.50 per 1M output tokens (model page, 2026-09-26).
A 50-conversation stress run costs about $0.16.
`gpt-6-sol` costs 20 times more.
- **Open.** Try `gpt-6-sol` for replies only on the live demo if the tone needs it.
The stress harness stays on Luna.

### D6. One reply per burst of texts

- **Choice.** The brain waits 700 ms after the last text before it starts a turn.
If a new text arrives while the model works, the brain drops the in-flight turn at commit.
A fresh turn then covers every pending text.
- **Why.** People send several short texts in a row.
Persona's live onboarding sent a duplicate message when state changed between turns.
This design makes a stale reply impossible.

### D7. Re-decide at commit time

- **Choice.** When a turn's model work finishes, the brain runs `decide()` again on the live state.
The plan can change, for example when OAuth finishes during the model call.
Then the brain renders the turn again from templates and never sends stale text.
- **Why.** Model calls take seconds.
The state can move while they run.

### D8. Ask budget and the deferral ladder

- **Choice.** Each slot gets two direct asks.
After the second unanswered ask, the slot is `deferred`.
A deferred slot gets exactly one more try at a natural moment (usually when a task needs it).
If that try goes unanswered, the slot is `declined` and never asked again.
A soft refusal ("not now") defers.
A hard or repeated refusal declines.
An idle nudge counts as an ask.
- **Why.** This is the brief's rule, made exact so the harness can grade it.

### D9. Call offers

- **Choice.** The brain offers a call once, right after the agent name settles.
It offers a second time only if the user shows typing fatigue.
It never offers after two declines or after a call already happened.
It skips the offer when only Gmail is missing, because a link does that better than a call.
A call the user asks for is always placed if voice works.
- **Why.** The assignment asks the bot to attempt a call.
A second unprompted offer after a "no" feels pushy.

### D10. Where names come from and how they get confirmed

- **Choice.** A typed name is `confirmed`, because the spelling is exact.
A name heard on a call is `tentative`.
Three things confirm it.
The user confirms the spelling on the call, or the Google profile name matches, or the user replies to the recap text without a correction.
A voice capture never overwrites a confirmed typed name unless the voice tool marks it as a correction.
- **Why.** Persona's live call misheard "David" as "Peter" and never checked.
The stress harness also caught our own version of this bug: a misheard call name replaced a typed one.

### D11. Name validation

- **Choice.** Agent names up to 32 graphemes, user names up to 40.
The brain accepts emoji, famous names, fake names, and unusual real names as written.
It blocks only clear slurs, and only the interpreter decides that.
Names from a message flagged as an injection attempt are not written.
- **Why.** The brief says to block only clear slurs and never correct an unusual real name.
We keep no list of slurs in the repo.
- **Not chosen yet.** A second check with the OpenAI moderation endpoint.
Add it if the stress tests show the interpreter misses slurs.

### D12. STOP and START

- **Choice.** An exact STOP, STOPALL, UNSUBSCRIBE, END, or QUIT text opts out, with no model involved.
The interpreter also catches "stop texting me".
After opt-out, the brain answers only START, UNSTOP, or RESUME.
CANCEL is not a keyword.
- **Why.** Opt-out must work even if the model is down.
CANCEL collides with tasks like "cancel my gym".

### D13. Under 18 stays stopped

- **Choice.** If a user says they are under 18, the brain sends one graceful stop message.
Then it stays silent, even if the user says "jk".
- **Why.** Persona requires 18+.
A retraction right after an age statement is not trustworthy.

### D14. Resume summary on the next text, not on page load

- **Choice.** A tab refresh restores the thread silently.
After a gap of one hour or more, the next user text gets a one-line summary first.
The summary uses only what the agent knew before that text.
- **Why.** iMessage has no "user opened the app" event.
This keeps the brain channel-agnostic.

### D15. Idle nudge

- **Choice.** Ten minutes after an unanswered slot or Gmail ask, the brain sends one gentle follow-up.
At most one per open question and two per session.
If the user texts first, the brain drops the nudge.
- **Why.** Persona's live onboarding dead-ended after the Google refusal with no follow-up.

### D16. Casing and values

- **Choice.** If the user types in lowercase, the agent writes in lowercase too.
Values the user gave (names, emails, their own words) keep their exact form in either case.
- **Why.** Persona's live bot does the same.
Lowercasing a name the user never typed ("David" heard on a call) looked wrong in browser QA.

### D17. Honest about what exists

- **Choice.** A `tasksEnabled` flag (off until milestone 4) goes into every reply brief as the agent's abilities.
When it is off, the agent never says it is on a task.
It never promises to look into something or report back, and it never invents commands or features.
The stress harness grades this with an `honesty` invariant.
- **Why.** Persona's public rule: "When something can't be done, Persona says so and tells you what it needs, instead of pretending." The first stress run found the agent promising to "review your gmail and send you the list".

### D18. Value before the first ask

- **Choice.** First contact sends a fixed three-line intro, then asks for the agent name.
The intro says who it is, what it can do, the yes-before-acting rule, and the legal line with a link.
The model may translate the intro but not change its claims.
- **Why.** Persona's current onboarding also leads with value.
A fixed intro gives a consistent first impression.

### D19. The Gmail link goes out once per moment

- **Choice.** If the call already texted the Gmail link, the recap after the call does not send it again.
- **Why.** The stress harness caught two links seconds apart.

### D20. Rate limits

- **Choice.** On a 429, the client waits for the server's "try again in" hint, or backs off exponentially.
It retries up to three times within the call's deadline.
Quota errors and timeouts never retry.
The harness runs four conversations at a time.
- **Why.** The account is Tier 1 with 200,000 tokens per minute on `gpt-6-luna`.
Ten parallel conversations hit that limit, and the live server shares it.

### D21. The stress harness

- **Choice.** An LLM plays each of ten personas against the real brain on a fake clock.
Scripted events per persona fake the calls and the Google consent screen: decline, let ring, hang up, drop, deny the Gmail box, admin block.
Code grades the invariants from the log.
One cheap judge call per conversation labels what each agent question asks for and flags false promises.
The judge exists because the renderer could phrase a question the plan did not ask.
If the simulator cannot finish a conversation (for example, on a rate limit), the report lists it and leaves it out of the pass rates.
- **Why.** The brief grades robustness under stress.
Code graders are exact.
The judge covers the one gap code cannot see.
- **Also.** `pnpm eval:interpreter` checks the model's reading of 30 tricky phrasings from the failure matrix.

### D22. Capabilities in the live server

- **Choice.** The live server runs with voice and Gmail off in milestone 1.
The brain then skips the call offer and the Gmail ask.
The tests and the stress harness turn both on and fake the channels.
- **Why.** The brain's call and Gmail logic exists now, and tests cover it.
The adapters land in milestones 2 and 3.

### D23. Session identity

- **Choice.** A random session id in a signed, httpOnly cookie.
"Reset session" in the reviewer panel issues a new id.
- **Why.** Simple and safe for a demo.
In production the iMessage handle or phone number is the identity.

### D24. Reviewer data on the same WebSocket

- **Choice.** The ledger and the event log stream to the page on the same WebSocket as the thread.
The phone UI never shows them.
Only the reviewer panel beside it does.
- **Why.** One connection keeps the demo simple.
A production build would put the reviewer stream behind an admin check.

### D25. Dev server details

- **Choice.** `node --watch`, not `--watch-path`.
Vite runs in middleware mode on port 3000 with its native config loader.
- **Why.** `--watch-path` restarted the server in a loop on this machine.
Vite's default config loader writes a temporary file that also triggers restarts.
Port 3000 matches the OAuth redirect URI.

### D26. Legal pages

- **Choice.** `/legal`, `/privacy`, and `/terms` say plainly that this is an independent prototype for a Persona take-home, not a Persona product.
They list what we keep, what we read in Gmail, and how to revoke access.
- **Contact.** zhiyuang2007@gmail.com, the same account that owns the Google Cloud project.

### D27. Abilities follow the session's capabilities

- **Choice.** The reply brief lists what the agent can do in this session, built from the live capability flags (voice, Gmail, tasks).
A question the intro or another answer already covers is never answered twice.
- **Why.** Browser QA caught a first turn that pitched "I can dig through your email" and then said "I can't read email" one text later.

### D28. The intro pitch is the product pitch

- **Choice.** The intro keeps Persona's product pitch ("I can call places for you, dig through your email").
Later texts stay honest about what this build can do.
- **Open.** Revisit in milestone 4.
Once the main experience exists, the pitch should promise only what the demo shows, with simulated steps labeled as simulated.

### D29. Repo state

- **Choice.** The repo has a local git history with no commits and no remote.
- **Why.** The brief says to keep the repo private until Zhiyuan says otherwise.
Commits wait for his go-ahead.

## Milestone 2: voice call

### D30. GPT-Live spike results (2026-09-27)

A Node script opened `gpt-live-1` sessions over the primary WebSocket, fed speech clips made with macOS `say`, and logged every event.
Five runs cost about $0.08.

- **Turn-taking.** The agent answered 0.2 to 0.6 s after the user stopped talking.
- **Transcripts.** User and agent transcripts stream in 200 ms fragments with timeline offsets. No event marks the end of a turn.
- **Greeting.** `session.instructions.append` alone did not make the agent speak first. It waited for the user, and once it skipped the disclosure. An instruction with the exact wording plus a `session.commentary.append` that triggers speech opened the call 700 ms later with the disclosure word for word.
- **Close.** `session.close` returns `session.closed` with `close_requested` and the billed seconds.
- **Sideband.** `attach` returns 404 for a session whose primary transport is a WebSocket. The docs describe attach for WebRTC and SIP sessions only, which is what the browser call uses.

### D31. GPT-Live talks, the brain writes the slots

- **Choice.** Stay on GPT-Live with client delegation and no backend tools.
The server attaches a sideband to each call, groups the transcript fragments into utterances, and feeds each finished user utterance to the brain as `transcript_final`.
The brain reads it with the same interpreter as texts, validates and writes the slots, and steers the call with `session.thinking.append` (quiet state updates) and `session.instructions.append` (opening, wrap-up, guardrails).
- **Why.** GPT-Live has no in-session function tools.
A slot write through Responses delegation needs a second model to decide to call a tool, which adds latency and a new way to fail.
Reading the transcript ourselves keeps one brain, one interpreter, and one validation path for text and voice.
- **Not chosen.** The Realtime fallback (`gpt-realtime-2.1`). It has in-session function calling, but the brief prefers GPT-Live, and the spike showed GPT-Live's turn-taking is fast.

### D32. How the call opens

- **Choice.** The session starts with the base voice prompt plus the call brief in `instructions`, and the recent text thread in `input`.
After the sideband attaches, the server sends an instruction with the exact disclosure ("Hey, it's {name}, your AI assistant from Persona.") and a commentary append that triggers the greeting.
- **Why.** This is the combination the spike proved.
