/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva plugin` строит версию рельсами апдейтера, и обещание «плагин поставлен» — это
// обещание про КОД, который работает. Здесь проверяется именно оно: сборка прошла, а
// mount'а плагина в работающей версии нет — значит установка не удалась, и команда обязана
// это сказать, а не отчитаться галочкой.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { PLUGIN_SCHEMA_URL } from "#lib/plugin-reader.ts";
import { createVersionStore } from "../lib/version-store.ts";
import { createCliRuntime } from "./runtime.ts";
import { createVersionUpdateCommand } from "./version-update-command.ts";

const REPO = join(dirname(new URL(import.meta.url).pathname), "../..");

/**
 * Вторая половина апдейта, урезанная до того, о чём тест: она двигает установку так же,
 * как настоящая (complete → activate → settle), и по требованию оставляет в версии
 * сгенерированный mount. Всё остальное (npm, eve, probe, systemd) проверено в других
 * тестах фейковым раннером и живым eve.
 */
const FINISH = `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [home, name] = process.argv.slice(2);
const { createVersionStore } = await import(process.env.IVA_TEST_STORE);
const store = createVersionStore(home);
const previous = store.currentName();
if (process.env.IVA_TEST_MOUNT) {
  const mount = join(home, "versions", name, process.env.IVA_TEST_MOUNT);
  mkdirSync(dirname(mount), { recursive: true });
  writeFileSync(mount, "export default 1;\\n");
  const directory = join(home, "versions", name, "plugins/trace");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), "{}\\n");
}
store.complete(name);
store.activate(name);
store.settle(name);
writeFileSync(
  process.env.IVA_UPDATE_OUTCOME,
  JSON.stringify({ status: "updated", version: name, previous, custom: "applied", migrations: [], removed: [] }),
);
`;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.com",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.com",
    },
  }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

type World = {
  readonly home: string;
  readonly version: string;
  rebuild(
    mount?: string,
  ): ReturnType<ReturnType<typeof createVersionUpdateCommand>["rebuild"]>;
};

/** Установка на неизменяемом layout: активная версия, зеркало и плагин с кодом в сторе. */
function world(t: TestContext): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-rebuild-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "iva");
  const upstream = join(dir, "upstream.git");
  git(dir, ["init", "--bare", "--initial-branch=main", upstream]);
  mkdirSync(home, { recursive: true });
  write(
    home,
    "package.json",
    `${JSON.stringify({ name: "iva", version: "0.3.19", type: "module" }, null, 2)}\n`,
  );
  write(home, "scripts/update-finish.ts", FINISH);
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["remote", "add", "origin", upstream]);
  git(home, ["config", "iva.updateBranch", "main"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-m", "release"]);
  git(home, ["push", "-q", "origin", "main"]);
  const sha = git(home, ["rev-parse", "HEAD"]);

  // The version that runs, built before the plugin existed.
  const store = createVersionStore(home);
  const active = `0.3.19-${sha.slice(0, 12)}`;
  const versionDir = store.stage(active);
  write(
    versionDir,
    "package.json",
    `${JSON.stringify({ name: "iva", version: "0.3.19" })}\n`,
  );
  write(versionDir, "scripts/update-finish.ts", FINISH);
  write(home, ".env", "");
  store.linkState(versionDir);
  store.complete(active);
  store.activate(active);
  store.settle(active);

  // A plugin with code, enabled: from now on every build has to carry it.
  const data = join(home, "data");
  write(
    data,
    "custom/plugins/trace/plugin.json",
    `${JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "trace",
      version: "1.0.0",
      // Заявка на namespace: без неё `sh.iva/` не читается (ADR-0009).
      extensions: { "sh.iva": {} },
    })}\n`,
  );
  write(
    data,
    "custom/plugins/trace/sh.iva/package.json",
    `${JSON.stringify({ name: "sh.iva.trace", eve: { extension: { source: "./extension", dist: "./dist/extension" } } })}\n`,
  );
  write(
    data,
    "custom/plugins/trace/sh.iva/tsconfig.json",
    '{ "include": ["extension/**/*.ts"] }\n',
  );
  write(
    data,
    "custom/plugins/trace/sh.iva/extension/extension.ts",
    "export default 1;\n",
  );
  write(
    data,
    "custom/plugins.json",
    `${JSON.stringify({
      marketplaces: [],
      plugins: [
        {
          name: "trace",
          source: "/tmp/trace",
          ref: "",
          sha: "",
          digest: "",
          enabled: true,
          trusted: false,
          installedAt: "2026-08-17T00:00:00.000Z",
        },
      ],
    })}\n`,
  );

  const base = createCliRuntime(versionDir);
  return {
    home,
    version: active,
    rebuild: (mount) => {
      const command = createVersionUpdateCommand(
        {
          ...base,
          readEnv: () => ({ MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-test" }),
          dataDirAbs: () => data,
          childEnv: {
            ...process.env,
            IVA_TEST_STORE: join(REPO, "scripts/lib/version-store.ts"),
            ...(mount ? { IVA_TEST_MOUNT: mount } : {}),
          },
        },
        { restartServices: () => {} },
      );
      return command.rebuild({ requirePlugins: true });
    },
  };
}

test("a build that leaves the plugin's code out is reported as a failure", async (t) => {
  const iva = world(t);

  // The new version is built, flipped and settled - and carries no mount for the
  // plugin. Every step said yes; the installation is still missing the plugin's artifacts.
  const outcome = await iva.rebuild();

  assert.deepEqual(outcome, {
    status: "failed",
    reason: `${createVersionStore(iva.home).currentName() ?? ""} is missing artifacts of trace`,
  });
});

test("a build that carries the plugin's code is reported as built", async (t) => {
  const iva = world(t);

  const outcome = await iva.rebuild("agent/extensions/trace.ts");

  assert.equal(outcome.status, "built", JSON.stringify(outcome));
  assert.notEqual(
    (outcome as { version: string }).version,
    iva.version,
    "the plugin is a new release, so it is a new build",
  );
});
