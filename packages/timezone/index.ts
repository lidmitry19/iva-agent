/**
 * Return the canonical IANA timezone `Intl` resolves the input to, or `null`.
 * `Intl` accepts any case and the historical aliases, systemd accepts neither, so
 * the canonical spelling is what callers get: `europe/moscow` and `US/Pacific`
 * come back as `Europe/Moscow` and `America/Los_Angeles`.
 */
export function validateTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Resolve every configured timezone to a valid IANA zone or the stable UTC fallback. */
export function resolveTimeZone(value: unknown): string {
  return validateTimeZone(value) ?? "UTC";
}
