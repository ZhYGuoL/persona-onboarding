// Server-side validation for every value that enters the slot ledger, from
// text or from a voice tool call. The model never writes the ledger directly.

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Remove control and zero-width characters, collapse whitespace. */
export function sanitize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\p{Cc}\u200b-\u200d\u2060\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type NameCheck = { ok: true; value: string } | { ok: false; reason: "empty" | "too_long" };

export function cleanName(raw: string): string {
  return sanitize(raw)
    .replace(/^["'“”‘’`*_\s]+|["'“”‘’`*_\s.,!?;:]+$/g, "")
    .trim();
}

export function checkName(raw: string, maxLength: number): NameCheck {
  const value = cleanName(raw);
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (graphemeLength(value) > maxLength) return { ok: false, reason: "too_long" };
  return { ok: true, value };
}

export function cleanHelpNeed(raw: string, maxLength: number): string | null {
  const value = sanitize(raw);
  if (value.length === 0) return null;
  if (graphemeLength(value) <= maxLength) return value;
  return `${[...segmenter.segment(value)]
    .slice(0, maxLength - 1)
    .map((s) => s.segment)
    .join("")
    .trimEnd()}…`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}
