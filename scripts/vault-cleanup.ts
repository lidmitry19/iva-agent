import { resolve } from "node:path";
import { cleanupVault } from "./lib/vault-cleanup.ts";

const args = process.argv.slice(2);
const root = args.find((arg) => !arg.startsWith("--"));
if (!root) {
  console.error("Usage: vault-cleanup.ts <vault-dir> [--apply] [--verbose]");
  process.exitCode = 1;
} else {
  const apply = args.includes("--apply");
  const result = cleanupVault(resolve(root), apply, args.includes("--verbose"));
  for (const failure of result.failures) console.error(`  ! ${failure}`);
  console.log(
    `cleanup (${apply ? "applied" : "dry-run"}): ${result.cleaned} file(s), ${result.saved.toLocaleString("en-US")} bytes of bug garbage${apply ? "" : " — run with --apply to fix"}`,
  );
  if (result.failures.length > 0) process.exitCode = 1;
}
