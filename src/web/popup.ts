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

export function openConnectPopup(url: string, onClosed: () => void): void {
  const width = 480;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  const popup = window.open(
    url,
    "persona-gmail",
    `popup,width=${width},height=${height},left=${left},top=${top}`,
  );
  if (!popup) {
    // Popups blocked: a new tab still keeps the simulator tab (and any call) alive.
    window.open(url, "_blank", "noopener");
    return;
  }
  popup.focus();
  clearInterval(watcher);
  watcher = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(watcher);
    onClosed();
  }, 500);
}
