/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// СБОРКА ПЛАГИНА НАСТОЯЩИМ eve. Единственный тест здесь, который не подменяет ни eve, ни
// его сборку агента: остальные тесты рельсов гоняют фейковый раннер, и именно поэтому они
// пропустили то, что ловит этот — сгенерированный mount собирался у discovery и падал у
// бандлера (`[UNRESOLVED_IMPORT] Could not resolve '../../plugins/demo/sh.iva'`), потому
// что `eve extension build` не пишет `main`, а rolldown применяет `exports` только к bare-
// спецификаторам.
//
// Что проверяется на живом eve:
//   • `eve extension build` собирает `sh.iva/` внутри версии;
//   • сгенерированный mount резолвится И у discovery, И у бандлера;
//   • тул плагина доезжает до агента под префиксом namespace (`demo__x`).
//
// Медленный (реальная сборка nitro, единицы секунд) и пропускается там, где eve нет:
// `iva` обязан ставиться и без node_modules, а тесты — идти на такой машине тоже.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codePlugins, buildPluginExtension } from "./plugin-build.ts";
import { commandRunner, type Runner } from "./version-update.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVE = join(ROOT, "node_modules/.bin/eve");

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/**
 * Дерево, которое выглядит как версия Ивы для eve: минимальный агент, `agent/lib` со
 * всеми файлами (mount читает оттуда `plugin-config.ts`), общий пакет data-dir и
 * `node_modules` установки. Полное дерево репозитория здесь не нужно: проверяется
 * резолв mount'а, а не набор тулов Ивы.
 */
function version(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-eve-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "agent/lib"), join(dir, "agent/lib"), { recursive: true });
  cpSync(join(ROOT, "packages"), join(dir, "packages"), { recursive: true });
  cpSync(join(ROOT, "tsconfig.json"), join(dir, "tsconfig.json"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  write(
    dir,
    "package.json",
    `${JSON.stringify(
      {
        name: "iva-version-under-test",
        version: "0.0.0",
        private: true,
        type: "module",
        imports: { "#*": "./agent/*" },
      },
      null,
      2,
    )}\n`,
  );
  write(
    dir,
    "agent/agent.ts",
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-4o-mini" });\n',
  );
  write(dir, "agent/instructions.md", "# Test\n\nYou are a test agent.\n");
  return dir;
}

/** Плагин в Custom layer: eve Extension с одним тулом, как его пишет автор. */
function plantPlugin(data: string, name: string): void {
  const root = `custom/plugins/${name}`;
  write(
    data,
    `${root}/plugin.json`,
    `${JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      version: "1.0.0",
      // Ключ обязателен: без него `sh.iva/` не читается (ADR-0009).
      extensions: { "sh.iva": {} },
    })}\n`,
  );
  write(
    data,
    `${root}/sh.iva/package.json`,
    `${JSON.stringify(
      {
        name: `sh.iva.${name}`,
        version: "1.0.0",
        type: "module",
        private: true,
        eve: {
          extension: { source: "./extension", dist: "./dist/extension" },
        },
        peerDependencies: { eve: "*" },
      },
      null,
      2,
    )}\n`,
  );
  // Свой tsconfig обязателен: `eve extension build` эмитит декларации через tsc со
  // списком файлов, а tsc отказывается (TS5112), если находит конфиг выше по дереву —
  // а он там всегда есть, потому что копия плагина лежит ВНУТРИ версии.
  write(
    data,
    `${root}/sh.iva/tsconfig.json`,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          target: "ES2022",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["extension/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  write(
    data,
    `${root}/sh.iva/extension/extension.ts`,
    'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
  );
  write(
    data,
    `${root}/sh.iva/extension/tools/x.ts`,
    'export default { description: "the plugin\'s own tool", execute: () => "ok" };\n',
  );
  write(
    data,
    "custom/plugins.json",
    `${JSON.stringify({
      marketplaces: [],
      plugins: [
        {
          name,
          source: `/tmp/${name}`,
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
}

/**
 * npm не участвует: у плагина нет своих зависимостей, а сеть в тесте — чужой отказ.
 * Всё остальное — настоящее, включая eve версии, которым он и собирается.
 */
function runnerWithoutNpm(): { run: Runner; steps: string[] } {
  const real = commandRunner(false);
  const steps: string[] = [];
  return {
    steps,
    run: (command, args, cwd) => {
      steps.push(`${command} ${args.join(" ")}`);
      return command === "npm"
        ? Promise.resolve({ code: 0, output: "" })
        : real(command, args, cwd);
    },
  };
}

test(
  "the generated mount builds with the real eve and the plugin tool reaches the agent",
  { skip: existsSync(EVE) ? false : "eve is not installed in node_modules" },
  async (t) => {
    const dir = version(t);
    const data = join(dir, "data");
    plantPlugin(data, "demo");

    const { plugins, diagnostics } = await codePlugins(data);
    assert.deepEqual(diagnostics, []);
    assert.equal(plugins.length, 1);
    const { run, steps } = runnerWithoutNpm();

    const built = await buildPluginExtension({
      versionDir: dir,
      plugin: plugins[0],
      run,
      log: () => {},
    });
    assert.deepEqual(built, { ok: true });
    // Собирал eve ЭТОЙ версии, не машинный: путь полный, а не имя команды.
    assert.ok(
      steps.includes(`${join(dir, "node_modules/.bin/eve")} extension build`),
      steps.join("\n"),
    );

    // Настоящая сборка агента: именно она падала на сгенерированном mount'е.
    const agent = await commandRunner(false)(EVE, ["build"], dir);
    assert.equal(agent.code, 0, agent.output.slice(-4000));
    // Тул плагина доехал до агента под префиксом namespace.
    const summary = readFileSync(join(dir, ".eve/agent-summary.json"), "utf8");
    assert.match(summary, /demo__x/u);

    // Пакет собран, и у него есть `main` — без него бандлер не резолвит относительный
    // спецификатор mount'а, хотя discovery резолвит.
    const manifest = JSON.parse(
      readFileSync(join(dir, "plugins/demo/sh.iva/package.json"), "utf8"),
    ) as { main?: string; exports?: Record<string, unknown> };
    assert.equal(manifest.main, "./dist/index.mjs");
    assert.ok(existsSync(join(dir, "plugins/demo/sh.iva/dist/index.mjs")));
    assert.ok(
      existsSync(
        join(dir, "plugins/demo/sh.iva/dist/extension/_manifest.json"),
      ),
    );
    // Копия в сторе остаётся ровно такой, как её поставили: digest плагина не съезжает.
    const stored = JSON.parse(
      readFileSync(
        join(data, "custom/plugins/demo/sh.iva/package.json"),
        "utf8",
      ),
    ) as { main?: string };
    assert.equal(stored.main, undefined);
  },
);
