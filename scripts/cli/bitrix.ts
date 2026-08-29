import type { CliCommand } from "./main.ts";

/** Keeps the CLI loadable when the authored tree is damaged; Bitrix loads only on invocation. */
export function createBitrixCommand(): CliCommand {
  return async (args) => {
    const [action, ...rest] = args;
    if (action !== "sync")
      throw new Error("Usage: iva bitrix sync --health | --task <id> | --daily");
    const { runBitrixSync } = await import("../bitrix-sync.ts");
    await runBitrixSync(rest);
  };
}
