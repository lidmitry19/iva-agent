/** Go's model catalog carries IDs, not protocols. The owner selects the documented wire. */
export const OPENCODE_PROTOCOLS = ["chat-completions", "responses"] as const;
export type OpenCodeProtocol = (typeof OPENCODE_PROTOCOLS)[number];

export function resolveOpenCodeProtocol(
  raw: string | undefined,
  variable = "OPENCODE_PROTOCOL",
): OpenCodeProtocol {
  if (raw === undefined) return "chat-completions";
  if (OPENCODE_PROTOCOLS.includes(raw as OpenCodeProtocol))
    return raw as OpenCodeProtocol;
  throw new Error(
    `Invalid ${variable} ${JSON.stringify(raw)}; expected chat-completions or responses (Go /messages is unsupported) — run: iva config`,
  );
}
