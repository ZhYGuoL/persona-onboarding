// Local time for the user. Reminders are set and shown in the user's own time
// zone, which the simulator reports from the browser.

export const DEFAULT_TIME_ZONE = "America/New_York";

/** A usable IANA time zone name, or the default. */
export function safeTimeZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - Math.floor(at / 1000) * 1000;
}

/** "2026-10-04T09:00" in the zone, as epoch milliseconds. Null if it does not parse. */
export function zonedToEpoch(local: string, timeZone: string): number | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetMs(asUtc, timeZone);
  // A second pass settles instants near a daylight saving change.
  return asUtc - offsetMs(first, timeZone);
}

/** "Sunday, Sep 27, 2026, 9:30 AM", in the zone. */
export function formatNow(at: number, timeZone: string): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Sun, Oct 4 at 9:00 AM", in the zone. */
export function formatWhen(at: number, timeZone: string): string {
  const day = new Date(at).toLocaleDateString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = new Date(at).toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} at ${time}`;
}

/** "Sep 25", in the zone. */
export function formatDay(at: number, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
}
