# Persona's current onboarding (observed live)

Channel: iMessage. Number on yourpersona.com/start on 2026-09-26: +1 (650) 283-5031 (it showed +1 (213) 865-6308 on 2026-09-25, so they rotate numbers).
The start page pre-fills the first message: "Hey, what's a persona?"

## Run 1 (2026-09-26, EDT). Texts as they appear in Messages on the Mac.

| Time | Who | Message |
|---|---|---|
| 7:03:54 PM | user | Hey, what's a persona? |
| 7:03:56 PM | bot | Hey! I'm your new personal assistant |
| 7:03:57 PM | bot | You can text me or call me anytime and I can help with: 📞 calling places on your behalf / 💻 browsing the web / 🛍️ shopping for you / 📩 managing your email and calendar / 🚗 finding DoorDash or Uber options. By continuing to text or use Persona, you agree to our Terms of Service and SMS Terms, and acknowledge our Privacy Policy: yourpersona.com/legal |
| 7:03:58 PM | bot | What do you want to call me? |
| 7:27:15 PM | user | juno |
| 7:27:19 PM | bot | juno it is. save my contact card so you'll recognise me when I call. |
| 7:27:20 PM | bot | [contact card attachment] |
| 7:27:21 PM | bot | want to do a quick call now? it's faster to get me set up properly, and you can ask me anything. |
| 7:27:32 PM | user | sure |
| 7:27:37 PM | bot | juno it is, save my contact card so you'll recognise me when I call. (DUPLICATE of 7:27:19) |
| 7:27:39 PM | bot | good. did you save my contact card? then i'll call. |
| 7:29:25 PM | user | saved it |
| 7:29:30 PM | bot | calling you now. |
| (call) | | Zhiyuan answered on his iPhone. Call content: see "The call" below. |
| 7:30:21 PM | bot | yes, i can help with scheduling, Peter. connect your Google account so i can reach your calendar. |
| 7:30:23 PM | bot | https://app.yourpersona.com/link/google?t=...&src=imessage |
| 7:33:39 PM | user | not right now |
| 7:33:47 PM | bot | no problem, we can do it over text. i can help organize your classes and events whenever you're ready. |
| to 7:39 PM | | nothing further (no follow-up nudge within 5+ minutes) |

## The call

Reported by Zhiyuan right after the call:
- The agent spoke first.
- It did NOT say it was an AI.
- It asked the user's name first. He said "David". The follow-up text called him "Peter". So the name was misheard, never confirmed by voice, and never recapped for correction.
- Then it asked what it could help with. He said "help scheduling my classes and events." The later texts used this ("scheduling", "organize your classes and events").
- It did not ask for Google on the call. The Google link came by text during or just after the call.
- It ended with a closing sentence but never hung up. The line stayed open in silence until the user hung up himself.

## Observations (what to keep, what to beat)

What they do well (keep or match):
1. Value first: a capability list before the first question.
2. Agent name first, by text. The call is placed by the named agent.
3. Sends a contact card named after the agent right after naming. So the call shows up as "juno" and iOS does not silence it as an unknown caller. Our simulator's incoming call screen should show the agent name.
4. Asks before calling ("want to do a quick call now?"), with a reason ("faster to get me set up properly").
5. Sends the Google link by text while the call is live, justified by the user's stated need ("so i can reach your calendar").
6. Graceful refusal tone ("no problem").
7. Switches to lowercase once the user types lowercase.

Weak spots (our submission should beat these, and they are good stress-test examples for the README):
1. Duplicate message: re-sent "juno it is, save my contact card" after the user said "sure". State was not tracked across turns.
2. Hard gate: will not call until the user claims they saved the card. Adds a step; a user can just say "saved it" without doing it.
3. Name capture failed: the user said "David", the bot texted "Peter". No spelling confirmation on the call, no recap to catch it. Our fix: confirm tentative names ("David, like D-A-V-I-D?"), cross-check with the Google profile name after OAuth, and send a recap text ("reply to fix anything").
4. No recap text after the call listing what it captured.
5. After the Gmail/Google refusal the conversation dead-ends: no alternative value offered, no next step, no later nudge in 5+ minutes. "we can do it over text" is unclear, since Google linking cannot be done over text.
6. The link is generic Google ("calendar"); the take-home asks specifically for a connected Gmail.
7. No AI disclosure on the call, even though their privacy policy mentions automated-assistant disclosures. Our fix: exact-wording disclosure in the first sentence (`session.instructions.append`).
8. The agent said goodbye but never hung up, leaving dead air until the user hung up. Our fix: the agent ends the call itself (hangup endpoint / `session.close`) right after its closing line, and the brain logs `close_requested`.
