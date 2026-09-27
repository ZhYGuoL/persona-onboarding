// Short, honest legal pages. Google requires a privacy policy and terms before
// the OAuth app can be published.

const CONTACT = "zhiyuang2007@gmail.com";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --ink: #111; --muted: #555; --bg: #fff; --rule: #e6e6e6; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eee; --muted: #aaa; --bg: #111; --rule: #2a2a2a; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 28px; letter-spacing: -0.02em; margin: 0 0 8px; }
  h2 { font-size: 17px; margin: 32px 0 4px; }
  p, li { color: var(--muted); }
  a { color: inherit; }
  .date { font-size: 14px; color: var(--muted); border-bottom: 1px solid var(--rule); padding-bottom: 16px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function legalPage(): string {
  return page(
    "Terms and Privacy",
    `<h1>Terms and Privacy</h1>
<p class="date">Updated September 26, 2026</p>
<p>This is an independent onboarding prototype built by Zhiyuan Guo for a Persona take-home project. It is not a Persona product.</p>
<ul>
  <li><a href="/terms">Terms of use</a></li>
  <li><a href="/privacy">Privacy policy</a></li>
</ul>`,
  );
}

export function privacyPage(): string {
  return page(
    "Privacy policy",
    `<h1>Privacy policy</h1>
<p class="date">Updated September 26, 2026</p>
<p>This is an independent onboarding prototype built by Zhiyuan Guo for a Persona take-home project. It is not a Persona product.</p>
<h2>What we keep</h2>
<p>We keep the text thread, the call transcript, and the four setup answers (the name you give the assistant, your name, what you want help with, and your Gmail address). We keep them in a database on our server so the conversation can resume. We do not keep call audio.</p>
<h2>What we read in Gmail</h2>
<p>If you connect Gmail, we ask for read-only access. We search recent message subjects and snippets to find things like receipts, renewals, and bills. We read the full text of a few matching messages only to help with the task you asked for. We never send, delete, or change email.</p>
<h2>How long we keep it</h2>
<p>We keep the Gmail access token in server memory for your session only. We do not write it to disk. We delete stored conversations when the prototype review ends.</p>
<h2>Who we share it with</h2>
<p>We send message text and call audio to OpenAI to understand and answer you. We do not sell data or share it with anyone else. Use of information from Google APIs follows the Google API Services User Data Policy, including the Limited Use requirements.</p>
<h2>How to revoke access</h2>
<p>Go to <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and remove "Persona Onboarding Demo". Access stops at once. To delete your conversation, email <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
<h2>Age</h2>
<p>You must be 18 or older to use this prototype.</p>`,
  );
}

export function termsPage(): string {
  return page(
    "Terms of use",
    `<h1>Terms of use</h1>
<p class="date">Updated September 26, 2026</p>
<p>This is an independent onboarding prototype built by Zhiyuan Guo for a Persona take-home project. It is not a Persona product and has no warranty.</p>
<h2>What it does</h2>
<p>The assistant is an AI. It can talk with you by text and by a simulated phone call in your browser. It never sends real emails, texts, or payments, and it never places real phone calls. It drafts outward actions and waits for your yes.</p>
<h2>Your part</h2>
<p>You must be 18 or older. Do not share information you do not want an AI to process. Text STOP at any time to stop all messages.</p>
<h2>Contact</h2>
<p>Zhiyuan Guo, <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
  );
}
