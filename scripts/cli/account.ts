import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";
import { resolveVaultDir } from "../../packages/vault-dir/index.ts";
import { betaOf } from "../lib/update-channel.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;
type UsageModule = Pick<
  typeof import("../lib/usage.ts"),
  "readEntries" | "summarize" | "formatUsageReport" | "parseWindow"
>;
type CodexOauthModule = Pick<
  typeof import("../lib/codex-oauth.ts"),
  "runDeviceCodeLogin" | "runBrowserLogin"
>;

type RemoveOptions = {
  readonly recursive?: boolean;
  readonly force?: boolean;
};

export type AccountDependencies = {
  readonly readPackage?: (path: string) => string;
  readonly parsePackage?: (text: string) => { readonly version?: unknown };
  readonly remove?: (path: string, options?: RemoveOptions) => void;
  readonly homeDir?: () => string;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
  readonly exit?: (code: number) => unknown;
  readonly loadUsage?: () => Promise<UsageModule>;
  readonly loadCodexOauth?: () => Promise<CodexOauthModule>;
};

/** Create account-oriented CLI commands without running command work at import time. */
export function createAccountCommands(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: AccountDependencies = {},
) {
  const {
    ROOT,
    C,
    ok,
    warn,
    bad,
    step,
    hasSystemd,
    readEnv,
    dataDirAbs,
    confirm,
    gitHead,
  } = runtime;
  const { removeUnits } = systemdLifecycle;
  const readPackage =
    dependencies.readPackage ?? ((path: string) => readFileSync(path, "utf8"));
  const parsePackage =
    dependencies.parsePackage ??
    ((text: string) =>
      JSON.parse(text) as {
        readonly version?: unknown;
      });
  const remove =
    dependencies.remove ??
    ((path: string, options?: RemoveOptions) => rmSync(path, options));
  const homeDir = dependencies.homeDir ?? homedir;
  const now = dependencies.now ?? Date.now;
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  const loadUsage = dependencies.loadUsage ?? (() => import("../lib/usage.ts"));
  const loadCodexOauth =
    dependencies.loadCodexOauth ?? (() => import("../lib/codex-oauth.ts"));

  async function cmdUninstall(args: readonly string[]): Promise<void> {
    const purge = args.includes("--purge");
    warn(
      "Uninstalling Iva: systemd units and the `iva` command will be removed.",
    );
    if (purge)
      bad(
        "--purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).",
      );
    if (!(await confirm("Continue?", false))) {
      log("Cancelled.");
      return;
    }

    if (hasSystemd()) ok(`Removed systemd units: ${removeUnits().length}`);
    try {
      remove(join(homeDir(), ".local/bin/iva"));
      ok("iva command removed from ~/.local/bin");
    } catch {
      // An already absent CLI symlink is a successful uninstall outcome.
    }

    if (!purge) {
      log(`${C.d}Code and vault kept: ${ROOT}${C.x}`);
      ok("Done.");
      return;
    }
    if (
      !(await confirm(
        `Delete the ${ROOT} directory AND vault IRREVERSIBLY?`,
        false,
      ))
    ) {
      log("Code and vault kept.");
      return;
    }
    const vaultPath = resolveVaultDir(ROOT, readEnv().ASSISTANT_VAULT_DIR);
    for (const [path, label] of [
      [vaultPath, "vault"],
      [ROOT, "code"],
    ] as const) {
      try {
        remove(path, { recursive: true, force: true });
        ok(`${label} deleted`);
      } catch (error) {
        warn(`did not delete ${label}: ${(error as Error).message}`);
      }
    }
  }

  function cmdVersion(): void {
    let version: unknown = "?";
    try {
      version = parsePackage(readPackage(join(ROOT, "package.json"))).version;
    } catch {
      // Keep the fallback version marker when package metadata is unavailable.
    }
    const updates = betaOf(ROOT) ? "beta" : "stable";
    log(
      `iva ${version as string} · commit ${gitHead() || "?"} · updates ${updates}`,
    );
  }

  async function cmdUsage(args: readonly string[]): Promise<void> {
    const { readEntries, summarize, formatUsageReport, parseWindow } =
      await loadUsage();
    const env = readEnv();
    const dataDir = dataDirAbs(env);
    if (args[0] === "tail") {
      const count = Number(args[1]) || 10;
      for (const entry of readEntries(dataDir).slice(-count))
        log(JSON.stringify(entry));
      return;
    }
    const aggregate = summarize(readEntries(dataDir), {
      window: parseWindow(args[0]),
      now: now(),
      tz: env.ASSISTANT_TIMEZONE,
    });
    log(formatUsageReport(aggregate));
  }

  async function cmdLogin(args: readonly string[]): Promise<void> {
    const { runDeviceCodeLogin, runBrowserLogin } = await loadCodexOauth();
    const dataDir = dataDirAbs();
    const lang = (readEnv().AGENT_LANGUAGE || "en").toLowerCase();
    const browser = args.includes("--browser");
    step(
      browser ? "OpenAI sign-in (browser)…" : "OpenAI sign-in (device code)…",
    );
    try {
      const auth = browser
        ? await runBrowserLogin({ dataDir, lang, log })
        : await runDeviceCodeLogin({ dataDir, lang, log });
      ok(
        `Signed in${auth.planType ? ` — plan: ${auth.planType}` : ""}${auth.accountId ? ` · account ${auth.accountId}` : ""}`,
      );
      log(
        `${C.d}Token stored: ${join(dataDir, "codex-auth.json")} (chmod 600)${C.x}`,
      );
      if (readEnv().MODEL_PROVIDER !== "codex")
        warn(
          "Set MODEL_PROVIDER=codex to use it: iva config (then iva restart)",
        );
    } catch (error) {
      bad(`Sign-in failed: ${(error as Error).message}`);
      exit(1);
    }
  }

  return { cmdUninstall, cmdVersion, cmdUsage, cmdLogin };
}
