/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// СБОРКА ПЛАГИНА НАСТОЯЩИМ eve. Единственный тест здесь, который не подменяет ни eve, ни
// его сборку агента: остальные тесты рельсов гоняют фейковый раннер, и именно поэтому они
// пропустили то, что ловит этот — сгенерированный mount собирался у discovery и падал у
// бандлера. На 0.47.3 путь `sh.iva` без `/.` перехватывает asset-loader и падает с EISDIR;
// `eve extension build` также не пишет `main`, нужный относительному спецификатору.
//
// Что проверяется на живом eve:
//   • `eve extension build` собирает `sh.iva/` внутри версии;
//   • сгенерированный mount резолвится И у discovery, И у бандлера;
//   • тул плагина доезжает до агента под префиксом namespace (`demo__x`);
//   • сгенерированные connection-файлы MCP-серверов плагина eve действительно
//     регистрирует под теми именами, которые мы им дали (ADR-0009).
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
import { fileURLToPath, pathToFileURL } from "node:url";
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
    `${root}/mcp.json`,
    `${JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        viewer: { type: "stdio", command: "node", args: ["serve.mjs"] },
        api: {
          type: "streamable-http",
          url: "https://api.test/mcp",
          headers: { Authorization: "Bearer ${API_KEY}" },
        },
      },
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
          // Доверен: именно доверие включает connection-файлы (ADR-0009).
          trusted: true,
          mcp: { viewer: { port: 8730 } },
          installedAt: "2026-08-17T00:00:00.000Z",
        },
      ],
    })}\n`,
  );
}

/**
 * Записывает команды, но выполняет их настоящими. У тестового пакета есть только peer,
 * поэтому `npm install --omit=peer` не ходит в сеть и обязан оставить eve снаружи.
 */
function recordingRunner(): { run: Runner; steps: string[] } {
  const real = commandRunner(false);
  const steps: string[] = [];
  return {
    steps,
    run: (command, args, cwd) => {
      steps.push(`${command} ${args.join(" ")}`);
      return real(command, args, cwd);
    },
  };
}

test(
  "plugin names use the exact eve 0.47.3 extension and connection grammar",
  { skip: existsSync(EVE) ? false : "eve is not installed in node_modules" },
  async () => {
    const grammar = (await import(
      pathToFileURL(join(ROOT, "node_modules/eve/dist/src/discover/grammar.js"))
        .href
    )) as {
      EXTENSION_SLUG_PATTERN: RegExp;
      CONNECTION_SLUG_PATTERN: RegExp;
    };
    assert.equal(
      grammar.EXTENSION_SLUG_PATTERN.source,
      "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$",
    );
    assert.equal(
      grammar.CONNECTION_SLUG_PATTERN.source,
      "^[a-z][a-z0-9-]{0,63}$",
    );
  },
);

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
    const { run, steps } = recordingRunner();

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
    assert.ok(
      steps.includes("npm install --omit=dev --omit=peer --no-audit --no-fund"),
      steps.join("\n"),
    );
    assert.equal(
      existsSync(join(dir, "plugins/demo/sh.iva/node_modules/eve")),
      false,
      "the plugin must use the version's eve, never a nested copy",
    );

    // Настоящая сборка агента: именно она падала на сгенерированном mount'е.
    const agent = await commandRunner(false)(EVE, ["build"], dir);
    assert.equal(agent.code, 0, agent.output.slice(-4000));
    // Тул плагина доехал до агента под префиксом namespace.
    const summary = readFileSync(join(dir, ".eve/agent-summary.json"), "utf8");
    assert.match(summary, /demo__x/u);
    // И connection-файлы: eve приняла их имена и собрала их содержимое. Форма
    // `<ns>__<server>` здесь бы не прошла — eve не принимает `_` в имени connection.
    assert.match(summary, /mcp-demo--viewer/u);
    assert.match(summary, /mcp-demo--api/u);
    assert.ok(
      existsSync(join(dir, "agent/connections/mcp-demo--viewer.ts")),
      "the proxied server has a connection file",
    );

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
