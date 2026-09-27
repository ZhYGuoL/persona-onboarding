// Gmail connect opens in a popup. The simulator tab must never navigate away,
// because that would end a live call. When the popup closes, the server gets a
// signal so an unfinished sign-in counts as a cancel.

let watcher: ReturnType<typeof setInterval> | undefined;

export function isConnectLink(url: string): boolean {
  try {
    return new URL(url, location.href).pathname === "/connect/gmail";
  } catch {
    return false;
  }
}

/** Opens the popup. Returns false if the browser blocked it, so the link can open a normal tab. */
export function openConnectPopup(url: string, onClosed: () => void): boolean {
  const width = 480;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  const popup = window.open(
    url,
    "persona-gmail",
    `popup,width=${width},height=${height},left=${left},top=${top}`,
  );
  // Blocked: the link's own target="_blank" opens a tab instead, which still keeps
  // the simulator tab (and any call) alive.
  if (!popup) return false;
  popup.focus();
  clearInterval(watcher);
  const qa = window as unknown as { __popupEvents?: string[]; __popup?: Window };
  qa.__popupEvents = ["opened"];
  qa.__popup = popup;
  watcher = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(watcher);
    qa.__popupEvents?.push("closed");
    onClosed();
  }, 500);
  return true;
}
