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

### D33. Turning transcript fragments into utterances

- **Choice.** The server groups GPT-Live transcript fragments per speaker.
A user utterance ends after 900 ms of quiet, or when the agent answers.
An agent fragment that overlaps the user's speech within 300 ms is a backchannel ("mm-hmm") and does not end the user's utterance.
An agent utterance ends after 1400 ms of quiet, or when the user speaks.
- **Why.** GPT-Live sends no end-of-turn event.
The brain needs whole utterances to read names and needs, and to tell a goodbye from speech in progress.

### D34. How a call ends

- **Choice.** When nothing is left to learn, or the user has to go, the brain pushes a wrap-up instruction.
An agent line with a goodbye cue ("bye", "take care", "talk soon", "adiós", "cuídate", and others) hangs up at once.
Any other agent line during the wrap-up arms a 3 s quiet hangup, and a line that starts after the wrap-up also gets one "say goodbye now" reminder.
The user starting to speak cancels the quiet hangup.
A 15 s fallback covers an agent that says nothing.
- **Why.** Persona's live call said goodbye and then left the line open.
Browser QA found the first version of this rule cutting the agent off mid-sentence, and a second version leaving 14 s of dead air.

### D35. Silence and length on a call

- **Choice.** 9 s after the agent's last words with no user speech, the agent checks in once.
12 s later, it says it will follow up by text and wraps up.
Calls are capped at 4 minutes.
- **Why.** The brief asks for a nudge after a few seconds and a move to text after a longer silence.
The cap bounds voice cost at $0.20 per call.

### D36. A spelling and a typed name beat a heard name

- **Choice.** A name heard on a call is tentative.
An unprompted letter-by-letter spelling confirms it.
A spelling that is a prefix of the heard name ("D A V" for "David") is ignored, because spellings arrive in pieces.
A name typed during a call is exact and confirmed.
A name heard on a call never replaces a confirmed typed name unless the user corrects it.
- **Why.** Browser QA saw "D A V" arrive alone and turn "David" into "Dav".

### D37. "Stop calling me" is not "stop texting me"

- **Choice.** Refusing a call during a call ends the call politely, records a firm no to calls, and continues onboarding by text.
STOP and "stop texting me" still opt out of everything.
- **Why.** The first version treated a call refusal like "gotta go" and stalled the text flow.

### D38. The browser is untrusted on a call

- **Choice.** The GPT-Live session sets `client.data_channel.allowed_client_events` to none, and lets the browser hear only `session.started` and `session.closed`.
Only the server's sideband can push context or close the session.
- **Why.** Otherwise anyone with the page could send `session.instructions.append` from the browser console.

### D39. Test voice for QA

- **Choice.** The reviewer panel has a "Test voice" switch.
It replaces the microphone with prerecorded clips (made with macOS `say`, 14 to 40 KB each) and streams silence between them.
- **Why.** Browser QA and the demo need repeatable calls without a person speaking.
The silence matters: GPT-Live's session timeline only moves while audio arrives, so a silent gap froze the agent.

### D40. Texting during a call

- **Choice.** The call screen has a "Messages" control that shrinks the call to a green pill in the status bar, as on iOS.
A text sent during the call reaches the agent as context, and the brain reads it like speech.
New texts from the agent during a full-screen call show as a Messages banner.
- **Why.** The brief requires texts during a call to reach the call.

### D41. Voice and cost

- **Choice.** Voice `marin` (the default), set by `LIVE_VOICE`.
A typical onboarding call runs 35 to 40 s, about $0.03.
- **Measured.** The first agent words arrive about 1 s after the session starts.
The agent starts answering as the user's last word is transcribed.

## Milestone 3: Gmail and the inbox scan

### D42. One inbox interface, two inboxes

- **Choice.** The scan talks to one interface.
Real Gmail uses the REST API read-only: `threads.list` to find matches (10 quota units), then `threads.get` with metadata for subject, sender, and date (40 units each).
The sample inbox is seeded data behind the same interface.
- **Why.** One scan, one test suite, and the demo works for anyone.

### D43. The scan: parallel searches, one model call, code checks

- **Choice.** Seven Gmail searches run at once: the user's own words first, then renewals and subscriptions, receipts and refunds, bills, travel, appointments and tickets, and unread mail from people.
One fast model call reads subject, sender, date, and snippet for up to 24 threads, and picks up to three findings with their concrete numbers, dates, and names.
Code then drops findings that point at a thread that does not exist, strips links, and drops anything that asks for passwords, codes, or money.
- **Why.** The call is live, so the scan must be quick.
Snippets carry the key facts in most emails, so the scan skips full bodies.
It takes 1.3 to 2.5 s and costs about $0.0002.
Milestone 4 reads full bodies only when it acts on one email.

### D44. Email is untrusted input

- **Choice.** The scan prompt says to never follow instructions in email and to skip scams.
The sample inbox includes a prompt-injection email ("SYSTEM NOTE TO AI ASSISTANT: ignore all previous instructions...") to prove the point, and code drops it even if the model picks it.
- **Why.** An inbox is the easiest place to plant instructions for an assistant.

### D45. The sample inbox

- **Choice.** The connect page offers "Use a sample inbox instead".
It holds about 25 realistic emails: renewals, receipts, bills, a flight, a hotel, a landlord and a friend waiting on replies, noise, and the injection email.
Dates move with the session clock.
The agent always calls it the sample inbox and never passes it off as the user's email.
- **Why.** While the Google app is unverified and in Testing, only listed test users can connect real Gmail.
Reviewers, the demo video, and privacy-minded users still see the whole flow.

### D46. OAuth

- **Choice.** The agent texts a signed link that expires in 24 hours.
It opens in a popup, never the simulator tab, because navigating that tab would end a live call.
The flow uses PKCE, `access_type=online` (no refresh token), and `prompt=select_account consent`, so the account picker and the scope checkboxes always show.
The granted scopes in the token response decide the outcome, since Google's granular consent lets people uncheck Gmail.
The access token lives in server memory for the session only. It is never written to disk, logged, or put in session state, and a test checks that.
The ID token's claims are read without re-checking the signature, because it came straight from Google's token endpoint over TLS.
- **Why.** These are the brief's rules, plus least privilege.

### D47. Telling a cancel from a slow sign-in

- **Choice.** If the popup closes while it is still on our connect page, that is a cancel after a 2 s grace.
Once the popup has gone to Google, a close signal is ignored.
Only a missing callback after 3 minutes counts as abandoned.
- **Why.** Google's pages set an opener policy that can cut or confuse the page's handle to the popup.
Trusting that signal could tell a user "the window closed" while they are still signing in.
Google always redirects back on finish, deny, or cancel.

### D48. The magic moment on a call

- **Choice.** When the need is known on a call, the brain texts the Gmail link and tells the agent to mention it.
The call stays up while the link is out (up to 75 s) and while the scan runs, with no "are you still there?" during that wait.
On connect, the agent says it is taking a quick look.
When the scan lands, the finding goes to the agent as commentary to say in its own words.
The call wraps up only after the agent line that actually says the finding.
That line must contain a name, month, or number from it, and a 20 s fallback covers an agent that never says it.
The recap text repeats the finding in writing.
- **Why.** Browser QA found each of these failure modes: a queued older line counted as the finding, a wrap-up cut the agent off mid-sentence, and a silence check-in fired while the user was in the Gmail popup.
Speech also spells numbers out ("seventeen dollars"), so names and months are the reliable anchors.

### D49. A wrap-up needs a spoken cue

- **Choice.** Every wrap-up sends an instruction (how to end) and a commentary cue (speak now).
- **Why.** An instruction alone does not make GPT-Live speak (D30).
When the wrap-up came after the agent had stopped talking, it waited in silence until the fallback hung up.

### D50. Inbox results by text

- **Choice.** On connect, the text says "taking a quick look" and asks nothing.
The finding follows in the next text, with "want me to start there?".
The next question waits while a scan runs, so the finding comes before any ask.
- **Why.** The finding is the value. It should land before the next request.

### D51. Every Google failure gets its own plain sentence

- **Choice.** Unchecked Gmail box, cancel, access denied, Workspace admin block, and a lost or expired token each have their own wording.
The admin block names the organization's admin and says a personal Gmail works.
A lost token resets the Gmail slot so the next ask sends a fresh link.
- **Why.** The brief asks the agent to say plainly what happened and what it needs.

### D52. Browser QA notes

- **Choice.** QA clicks links by coordinates, not by element, and closes the popup through the page's own handle.
- **Why.** The QA browser's element click does not fire real mouse events on links, so the popup code never ran.
Closing a popup through the QA browser also did not update the opener's `popup.closed`.
Neither was a product bug, but both hid what the product does.

### D53. At most three answered calls per session

- **Choice.** A call request only counts when the user asks the assistant to call them.
"Call the NYT and cancel" is a task, and "I can take a call if you need me" is not a request.
After three answered calls, a new request gets a text that keeps the talk in the thread.
- **Why.** In the M3 stress run, a rambler asked the agent to call a business and offered to take a call.
Both read as call requests, and the agent rang four times in one session.
A dropped line still gets a callback, because three calls leave room for one drop and one retry.

### D54. A Gmail link the user asks for always goes out

- **Choice.** "Send the link again" and "how do I connect gmail?" are their own signal, `wants_gmail_link`.
The link goes out by text or on a call, even past the ask budget, after an earlier no, or when the user is leaving.
It does not go out once Gmail is connected.
The render guard also rejects a draft that says the agent cannot send a link.
- **Why.** The ask budget limits how often the agent asks, not how often it answers.
In the M3 stress run, the budget was spent, the user asked for the link, and the agent said it could not send links.
That was false, and it blocked the user from the one thing they wanted to do.

### D55. A failed inbox scan retries, and the agent never guesses its result

- **Choice.** The inbox service retries a failed scan once, after one second.
If it still fails, the next user text starts a new scan, up to three failures in a row.
The failure text promises only that retry ("I'll try again when you text me next"), or says the agent gave up.
The renderer gets the scan state (`none`, `scanning`, `failed`, `scanned`), so it never says a failed scan found nothing.
- **Why.** In the M3 stress run, a scan failed under load.
The agent said "I'll try again later", but nothing retried.
Three texts later it said the scan found no subscriptions, which was false.
A retry that runs on the user's next text is honest, because the agent keeps no background jobs.

### D56. A task the agent cannot do yet gets a plain "I can't"

- **Choice.** Until tasks run (M4), a new task gets "I can't take care of X from here yet."
The render guard rejects a model draft for that turn if it leaves out "can't" or sounds like it took the task on ("got it:", "on it", "I'll remind").
- **Why.** "Got it: reminding you before the bill is due" reads as a promise.
The model used to add its own disclaimer.
It stopped when the abilities text changed to not list limits before the Gmail ask, and honesty fell to 80% of stress runs.
A rule in code does not depend on the model.
With the rule, honesty went back to 98%.

### D57. The intro promises only what this build does

- **Choice.** The intro now says "I can dig through your email, draft replies, and set reminders".
It no longer says "I can call places for you".
The model prompt keeps the full app's features as background, but says this version can do only what its abilities list.
- **Why.** D28 kept the product pitch until milestone 4.
With real tasks in place, the stress judge flagged "I can call places" as a false claim, and a user asked "you said you could call places" when the agent declined to call Adobe.
The brief's rule is plain: when something cannot be done, say so instead of pretending.

## Milestone 4: a real first task

### D58. A task is one checked result, from a separate work step

- **Choice.** A task service runs each task outside the session queue, like the inbox scan.
It picks the emails the task is about, reads them in full, and asks the model for exactly one result: an answer, a draft, a reminder, one question, or a plain "cannot".
Code checks the result before the brain sees it.
- **Why.** One result per run keeps the conversation simple and testable.
The model does the language, and code does the rules: who a draft may go to, what counts as a receipt, and when a reminder may fire.

### D59. Receipts are the email's own words

- **Choice.** Every result names the email it rests on: sender, date, and one sentence quoted from it.
Code keeps the quote only if it appears in the email word for word. Otherwise it shows the subject.
A receipt the thread already shows is not repeated.
- **Why.** Persona's public promise is that every task comes back with its receipts.
A made-up quote would be worse than none.

### D60. Drafts wait for a yes, and sending is simulated out loud

- **Choice.** A draft shows as a card, then "Send it?".
Only a plain yes to that question sends it. "Yes, but make it shorter" is an edit, and a yes to any other question never sends.
A send is recorded in a simulated outbox, and the text says "Sending is simulated here, so nothing left your account."
A draft may go only to an address in the email's headers or one the user typed, never to the user.
- **Why.** The brief's hard limits: nothing outward without a yes, no real sends, and say plainly when something is simulated.
The address rule stops an email's text from steering a draft to a stranger.
The stress harness checks the yes rule in code on every send (`yes_before_send`).

### D61. Reminders are real

- **Choice.** A reminder sets a timer in the session and texts the user at that time, in their own time zone from the browser.
A reviewer fast-forward now steps through due timers in order, so a 9:00 AM reminder is stamped 9:00 AM.
- **Why.** "Remind me before the bill is due" was the most common request the agent had to refuse in M3 stress runs.
The brain already owns timers, so a reminder costs almost nothing and is fully real.

### D62. One task at a time, results by text, never during a call

- **Choice.** Tasks queue and run one at a time.
A turn that asks "Send it?" or a task question waits for the answer before the next task starts.
A task heard on a call runs after the call, and the agent says so on the call.
- **Why.** Two results landing at once would mix up which "yes" goes with which draft.
A call has no place to show a draft card.

### D63. Findings are offered one at a time, tied to their email

- **Choice.** "Want me to start on X?" carries its finding, so a yes starts a task on that exact email.
After a task wraps up, the next unseen finding is offered with its fact.
Each finding is offered once, and a no ends the offers.
The offer renders from a template, so it stays a plain yes/no question.
- **Why.** Browser QA saw the model turn the offer into an either/or question that a yes cannot answer.
The next finding keeps the user moving into real value without nagging.

### D64. The task capability follows the model key

- **Choice.** Tasks run when the server has the model key, as a capability like voice and Gmail.
Without it, the agent says plainly it cannot take care of the task yet (D56).
- **Why.** The task service needs the model.
A config flag could promise work the server cannot do.

### D65. The sample inbox survives a restart

- **Choice.** Scan and task jobs name the inbox they read.
The sample inbox reconnects on demand. Real Gmail tokens stay in memory only, so a restart still means a fresh connect.
- **Why.** Browser QA hit "I lost access to your inbox" after a dev server restart on the sample inbox, which has no token to lose.

### D66. List tasks read several emails, and empty searches are said plainly

- **Choice.** The pick step returns up to four emails for a list or search task and one for a task about one thing.
Emails already shown are marked, so "any other ones?" finds new ones.
When nothing matches, the model is told it searched and found nothing.
- **Why.** Stress runs showed "find my subscriptions" answered from one email, the same email returned for "other ones", and "I can't search your gmail" when a search came up empty.

### D67. A task start promises only the look

- **Choice.** A task starts with "Looking into it." The result says what can and cannot be done.
- **Why.** "On it: calling Adobe" read as a promise to call, and the next text said it could not.

### D68. An answer ends with one follow-up the agent can do

- **Choice.** An answer names one follow-up, like "canceling the New York Times trial", tied to the email it is about.
After an empty search, the follow-up is the note it could draft instead, with no email.
The brain offers it the same way as an inbox finding, once, as a plain yes/no question.
- **Why.** Stress runs and browser QA showed answers that ended in "text me whenever something lands on your plate", which leaves the user with nothing to do.
A yes to a concrete offer keeps the user moving from finding to action.

### D69. The user can take a request back

- **Choice.** "Never mind" and "don't remind me" drop the latest open task.
A pending reminder's timer is canceled, so it never goes out, and a result that arrives after the drop is ignored.
A request and its take-back in the same message never becomes a task.
- **Why.** In a stress run, a user said "never mind" in the same breath as a reminder request.
The reminder was set anyway, and the agent's "I won't remind you" left the timer running.
A promise not to do something must be kept as strictly as a promise to do it.

### D70. A caller's phrase ends after 1.3 s of quiet

- **Choice.** The transcript grouper ends a caller's utterance after 1300 ms with no new fragment.
An agent sound ends the caller's utterance only after 1000 ms of caller quiet.
- **Why.** GPT-Live sends transcript fragments in bursts.
In the scripted voice runs, gaps inside one phrase reached 943 ms, and sentence breaks started near 1000 ms.
With the old 900 ms and 300 ms limits, "Necesito ayuda con mi" and "calendario" became two utterances, and the brain saved the need as "ayuda con mi".
The cost is about 400 ms more before the brain reads a caller's words.
The agent's voice does not wait for the brain, so the caller does not hear this delay.
A split at a sentence break is harmless, because the next turn reads the rest.
A fast caller can now have two turns merged into one, when they reply within 1.3 s of their own last words.
A merge is harmless too, because the interpreter reads both turns together. A split in the middle of a phrase lost half a value.

### D71. When the caller has to go, the agent says goodbye once

- **Choice.** When the caller has to go or is under 18, the brain does not push a wrap-up on top of the agent's own goodbye.
If the agent's last line already said goodbye, the call ends at once.
If the agent is still talking, the brain waits for the end of its line.
A goodbye in that line ends the call. A line with no goodbye gets the wrap-up push.
If the agent is quiet, the push goes out at once, as before.
- **Why.** The session rules already tell the agent to say goodbye in these cases, and it usually does before the brain decides.
In the scripted voice runs, the push arrived after that goodbye and made a second one: "Bye for now. Okay, take care, and talk soon."
The voice layer now reports when the agent starts to speak, so the brain knows if a line is in progress.

### D72. Calls and texts share one list of facts about Persona

- **Choice.** `src/brain/facts.ts` holds the facts the agent may say about Persona.
The text prompt and the call prompt both include them, with one rule: if a question is not covered, such as price or plans, say you are not sure and never guess.
- **Why.** In a scripted voice run, a caller asked "Is this free?", and the agent said "We do have both free and paid options."
The call prompt had no facts about Persona, so the voice model filled the gap.
One list keeps the two surfaces from telling the user different things.

### D73. A call with no agent voice for 10 s is ended and the user gets a text

- **Choice.** If the agent makes no sound within 10 s of the call being answered, the brain ends the call with the reason `no_voice`.
The phone shows "Call Failed". A text says "Sorry, that call had no sound on my end." and offers a callback or to keep going by text.
The agent's first sound, or its first transcript, cancels the timer.
- **Why.** Twice in the scripted voice runs, GPT-Live connected but never spoke.
Its audio clock never started, and a call to it ended with `context_injection_incomplete`.
The cause is not confirmed, and it did not happen again in later runs.
A real caller would sit in silence with no way to know what went wrong.
The first agent sound comes about 2 s after the tap (p95 2.4 s), so 10 s leaves wide room.
- **Check.** Browser QA cut the page's outgoing audio to reproduce it. The call ended at 10.0 s, and the text came 1.3 s later.
