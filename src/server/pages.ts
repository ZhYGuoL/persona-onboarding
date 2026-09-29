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
<p class="date">Updated September 28, 2026</p>
<p>This is an independent onboarding prototype built by Zhiyuan Guo for a Persona take-home project. It is not a Persona product.</p>
<h2>What we keep</h2>
<p>We keep the text thread, the call transcript, and the four setup answers (the name you give the assistant, your name, what you want help with, and your Gmail address). We keep them in a database on our server so the conversation can resume. We do not keep call audio.</p>
<h2>What we read in Gmail</h2>
<p>If you connect Gmail, we ask for read-only access. We search recent message subjects and snippets to find things like receipts, renewals, and bills. We read the full text of a few matching messages only to help with the task you asked for. We never send, delete, or change email.</p>
<h2>How long we keep it</h2>
<p>We keep the Gmail access token in server memory for your session only. We do not write it to disk. We delete stored conversations when the prototype review ends.</p>
<h2>Who we share it with</h2>
<p>We send message text, call audio, and the parts of your email we read (the subjects and snippets a scan looks at, and the few messages a task needs) to OpenAI to understand and answer you. We do not sell data or share it with anyone else. Use of information from Google APIs follows the Google API Services User Data Policy, including the Limited Use requirements.</p>
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

const GOOGLE_G = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

function card(title: string, inner: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --ink: #1d1d1f; --soft: #6e6e73; --bg: #f5f5f7; --card: #fff; --line: #00000014; --blue: #0a84ff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --soft: #a1a1a6; --bg: #000; --card: #1c1c1e; --line: #ffffff1f; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 400px; padding: 28px 24px 24px; border: 1px solid var(--line); border-radius: 20px; background: var(--card); }
  .mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 16px; border-radius: 12px; background: linear-gradient(180deg, #5cf777, #0cbd2a); color: #fff; font-weight: 700; }
  h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: -0.02em; }
  p { margin: 0 0 12px; color: var(--soft); font-size: 15px; }
  ul { margin: 0 0 20px; padding-left: 18px; color: var(--soft); font-size: 15px; }
  li { margin: 4px 0; }
  .google { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 44px; border: 1px solid #dadce0; border-radius: 22px;
    background: #fff; color: #1f1f1f; font: 500 15px/1 "Roboto", -apple-system, system-ui, sans-serif; text-decoration: none; }
  .google:hover { background: #f8f9fa; }
  .alt { display: block; width: 100%; margin-top: 10px; padding: 10px; border: 0; background: none; color: var(--blue); font: inherit; font-size: 15px; cursor: pointer; }
  .fine { margin: 16px 0 0; font-size: 13px; }
  .fine a { color: inherit; }
  .ok { color: #1f8a4c; }
  .bad { color: #b3261e; }
</style>
</head>
<body><main>${inner}</main>${script}</body>
</html>`;
}

export function connectGmailPage(startUrl: string, sampleAction: string, token: string): string {
  return card(
    "Connect Gmail",
    `<div class="mark" aria-hidden="true">P</div>
<h1>Connect Gmail</h1>
<p>Persona reads your email so it can find what needs you: receipts, renewals, bills, and people waiting on a reply.</p>
<ul>
  <li>Read-only. It never sends, deletes, or changes email.</li>
  <li>Access lasts for this session. You can revoke it any time.</li>
  <li>Google will warn that the app is unverified. It is a prototype, so choose Advanced, then continue.</li>
</ul>
<a class="google" href="${startUrl}">${GOOGLE_G}Continue with Google</a>
<form method="post" action="${sampleAction}">
  <input type="hidden" name="t" value="${token}">
  <button class="alt" type="submit">Use a sample inbox instead</button>
</form>
<p class="fine">See the <a href="/privacy" target="_blank" rel="noopener">privacy policy</a> for exactly what is read and kept.</p>`,
  );
}

export function oauthResultPage(ok: boolean, title: string, message: string): string {
  return card(
    title,
    `<div class="mark" aria-hidden="true">P</div>
<h1 class="${ok ? "ok" : "bad"}">${title}</h1>
<p>${message}</p>
<p class="fine">You can close this window and go back to your messages.</p>`,
    ok ? "<script>setTimeout(() => { if (window.opener) window.close(); }, 1200);</script>" : "",
  );
}
