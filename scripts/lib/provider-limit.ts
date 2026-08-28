function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True only for an upstream provider quota/usage block, never session state. */
export function isExternalUsageLimit(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error.code;
  const message = error.message;
  return (
    (typeof code === "string" && /usage[_ -]?limit/i.test(code)) ||
    (typeof message === "string" && /\busage limit\b/i.test(message))
  );
}