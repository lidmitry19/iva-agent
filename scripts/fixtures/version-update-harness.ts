import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isEntrypoint } from "../lib/version-layout.ts";
import { probeVersion } from "../lib/health-probe.ts";
import { runVersionUpdate, type Runner } from "../lib/version-update.ts";

/**
 * Shared fixture for the version updater: a stand-in for npm that behaves like the
 * real thing where it matters - a build fails when the tree contains broken code,
 * and a successful build leaves a server that the real health probe can start.
 */
const SERVER = `import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
if (existsSync(join(process.cwd(), "UNHEALTHY"))) {
  process.stderr.write("boom: cannot find module '../scripts/lib/provider.ts'\\n");
  process.exit(1);
}
createServer((_request, response) => response.writeHead(200).end("ok"))
  .listen(Number(process.env.PORT), "127.0.0.1");
`;

const SKIP = new Set(["node_modules", ".output", ".iva-incomplete"]);

/** Files the fake build refuses to compile, mimicking a customization that broke. */
export function brokenFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = join(dir, name);
    // data/ and vault/ are links to shared state and are never part of a build.
    if (lstatSync(full).isSymbolicLink()) return [];
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (lstatSync(full).isDirectory()) return brokenFiles(full, relativePath);
    return readFileSync(full, "utf8").includes("BREAK") ? [relativePath] : [];
  });
}

export function fixtureRunner(hook?: (step: string) => Promise<void>): Runner {
  return async (_command, args, cwd) => {
    if (args[0] === "ci") {
      await hook?.("install");
      mkdirSync(join(cwd, "node_modules"), { recursive: true });
      return { code: 0, output: "dependencies installed" };
    }
    // `eve extension build` in a plugin's `sh.iva/`: the same rule as the build
    // below, and its cwd is what names the plugin whose code did not compile.
    if (args[0] === "extension" && args[1] === "build") {
      await hook?.("extension");
      const broken = brokenFiles(cwd);
      if (broken.length > 0)
        return {
          code: 1,
          output: `eve: extension build failed on ${broken.join(", ")}`,
        };
      mkdirSync(join(cwd, "dist/extension"), { recursive: true });
      writeFileSync(
        join(cwd, "dist/extension/extension.mjs"),
        "export default {};\n",
      );
      writeFileSync(join(cwd, "dist/extension/_manifest.json"), "{}\n");
      writeFileSync(join(cwd, "dist/index.mjs"), "export default {};\n");
      // Exactly what the real eve leaves behind (0.30.8): an `exports` map pointing at
      // the build and no `main`. The missing `main` is why a generated mount used to
      // resolve for discovery and fail in the bundler, so the fake must not invent one.
      const manifest = join(cwd, "package.json");
      const declared = JSON.parse(readFileSync(manifest, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        manifest,
        `${JSON.stringify(
          {
            ...declared,
            exports: {
              ".": {
                types: "./dist/index.d.ts",
                default: "./dist/index.mjs",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      return { code: 0, output: "extension built" };
    }
    if (args[0] === "run" && args[1] === "build") {
      await hook?.("build");
      const broken = brokenFiles(cwd);
      if (broken.length > 0)
        return { code: 1, output: `cannot compile ${broken.join(", ")}` };
      mkdirSync(join(cwd, ".output"), { recursive: true });
      writeFileSync(join(cwd, ".output/server.mjs"), SERVER);
      return { code: 0, output: "built" };
    }
    return { code: 0, output: "" };
  };
}

export function fixtureProbe(hook?: (step: string) => Promise<void>) {
  return async (dir: string, port: number) => {
    await hook?.("probe");
    if (!existsSync(join(dir, ".output/server.mjs")))
      return { ok: false, log: "no build output" };
    return probeVersion({
      dir,
      port,
      command: process.execPath,
      args: [join(dir, ".output/server.mjs")],
      timeoutMs: 8000,
      intervalMs: 50,
      stopGraceMs: 500,
    });
  };
}

/**
 * Entry point for interruption tests: run one update and hang forever at the
 * requested step so the parent can SIGKILL the process exactly there.
 */
async function main(): Promise<void> {
  const home = process.env.IVA_TEST_HOME ?? "";
  const stallAt = process.env.IVA_TEST_STALL ?? "";
  const marker = process.env.IVA_TEST_MARKER ?? "";
  const hook = async (step: string): Promise<void> => {
    if (step !== stallAt) return;
    writeFileSync(marker, step);
    // A timer keeps the process alive so the parent has to actually kill it.
    const alive = setInterval(() => {}, 1000);
    await new Promise(() => {});
    clearInterval(alive);
  };
  const outcome = await runVersionUpdate({
    home,
    resolveTarget: () =>
      Promise.resolve(
        JSON.parse(readFileSync(process.env.IVA_TEST_TARGET ?? "", "utf8")) as {
          sha: string;
          version: string;
        },
      ),
    run: fixtureRunner(hook),
    probe: fixtureProbe(hook),
    // The steps after the flip are killable too, and each of them has to be
    // finishable by the run that comes next.
    quiesce: () => hook("quiesce"),
    resumeOldWriters: () => hook("resume"),
    startCandidate: () => hook("restart"),
    // Nothing here runs a unit, so there is no service for the wait after the
    // restart to find; the failure it guards has its own tests.
    serving: () => Promise.resolve({ ok: true, log: "" }),
    adopt: () => {
      if (stallAt === "cleanup") {
        writeFileSync(marker, "cleanup");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      writeFileSync(join(home, "adopted"), "");
    },
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

if (isEntrypoint(import.meta.url)) await main();
