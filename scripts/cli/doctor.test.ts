/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  MODEL_PROVIDER_NAMES,
  invalidModelProviderMessage,
} from "#lib/model-provider.ts";
import { PLUGIN_SCHEMA_URL } from "#lib/plugin-reader.ts";
import { pluginRoot, writePluginsState } from "#lib/plugin-store.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";
import { createVersionStore } from "../lib/version-store.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output/server"), { recursive: true });
  writeFileSync(join(root, ".output/server/index.mjs"), "export {};\n");
  return root;
}

function completeEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: "ollama-key",
    OLLAMA_MODEL: "model",
    DEEPGRAM_API_KEY: "deepgram-key",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_ALLOWED_USER_IDS: "1",
    ASSISTANT_BEARER: "b".repeat(43),
    TAVILY_API_KEY: "tavily-key",
  };
}

function lifecycle(
  overrides: Partial<SystemdLifecycle> = {},
): SystemdLifecycle {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    retireDeferredBrainUnits: () => [],
    retireLegacyMemoryUnits: () => [],
    migrateEnv: () => false,
    restartServices: () => undefined,
    ...overrides,
  };
}

test("non-systemd doctor preserves exact counter and exit semantics", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const exitCodes: number[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: (...args) => summaryLogs.push(args),
    exit: (code) => exitCodes.push(code),
  })();

  assert.deepEqual(events, [
    ["ok", "Node 24.19.0"],
    ["ok", ".env filled in (provider: ollama)"],
    ["ok", "web_search: tavily"],
    ["ok", "memory_search: grep"],
    ["ok", "Build in place (.output)"],
    [
      "warn",
      "systemd unavailable (not Linux) — skipping service and timer checks",
    ],
  ]);
  assert.deepEqual(summaryLogs, [
    [],
    ["Summary: 5 ok · 0 warn · 0 fixed · 0 fail"],
  ]);
  assert.deepEqual(exitCodes, [0]);
});

test("doctor accepts a custom embedding endpoint for hybrid memory search", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({
      ...completeEnv(),
      MEMORY_SEARCH_MODE: "hybrid",
      MEMORY_EMBED_URL: " https://embeddings.example.test/v1 ",
    }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.deepEqual(
    events.filter(([, message]) => message.startsWith("memory_search:")),
    [["ok", "memory_search: hybrid"]],
  );
});

test("doctor warns when hybrid memory search has no embedding source", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({
      ...completeEnv(),
      MEMORY_SEARCH_MODE: "hybrid",
    }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.deepEqual(
    events.filter(([, message]) => message.startsWith("memory_search:")),
    [
      [
        "warn",
        "memory_search: MEMORY_SEARCH_MODE=hybrid but no JINA_API_KEY/DEEPINFRA_API_KEY/MEMORY_EMBED_URL — falls back to BM25",
      ],
    ],
  );
});

test("missing env remains a failure while the systemd warning stays uncounted", async (t) => {
  const root = await sandbox(t);
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const exitCodes: number[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({}),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: (...args) => summaryLogs.push(args),
    exit: (code) => exitCodes.push(code),
  })();

  assert.deepEqual(events, [
    ["ok", "Node 24.0.0"],
    ["bad", ".env missing — run: iva config"],
    ["ok", "Build in place (.output)"],
    [
      "warn",
      "systemd unavailable (not Linux) — skipping service and timer checks",
    ],
  ]);
  assert.deepEqual(summaryLogs, [
    [],
    ["Summary: 2 ok · 0 warn · 0 fixed · 1 fail"],
  ]);
  assert.deepEqual(exitCodes, [1]);
});

test("doctor keeps the initial env snapshot but reads the migrated listener port fresh", async (t) => {
  const root = await sandbox(t);
  const unitDir = join(root, "units");
  const vault = join(root, "vault-initial");
  mkdirSync(unitDir);
  mkdirSync(vault);
  writeFileSync(join(unitDir, "iva.service"), "[Service]\n");
  writeFileSync(join(root, ".env"), "present=true\n");

  const initialEnv = {
    ...completeEnv(),
    ASSISTANT_DATA_DIR: "data-initial",
    ASSISTANT_VAULT_DIR: "vault-initial",
  };
  const migratedEnv = { IVA_PORT: "9123" };
  const calls: string[] = [];
  const dataDirInputs: Array<Partial<Record<string, string>>> = [];
  const listenerArgs: Array<readonly string[]> = [];
  const exitCodes: number[] = [];
  let readCount = 0;
  const systemd = createSystemdControl({
    run: (args) => {
      if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
      if (args[0] === "is-active") return { code: 0, out: "active" };
      return { code: 0, out: "" };
    },
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: unitDir,
    SERVICES: [],
    BRAIN_SERVICE: "iva-brain.service",
    BRAIN_TIMER: "iva-brain.timer",
    TIMERS: [],
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: () => undefined,
    hasSystemd: () => true,
    systemd,
    readEnv: () => {
      readCount++;
      calls.push(readCount === 1 ? "read-initial" : "read-fresh");
      return readCount === 1 ? initialEnv : migratedEnv;
    },
    dataDirAbs: (env = initialEnv) => {
      dataDirInputs.push(env);
      calls.push("data-dir");
      return join(root, "data-initial");
    },
    cap: (command, args) => {
      if (command === "ss") {
        calls.push("inspect-listener");
        listenerArgs.push(args);
        return {
          code: 0,
          out: "LISTEN 0 511 127.0.0.1:9123 0.0.0.0:*",
          err: "",
        };
      }
      assert.equal(command, "git");
      return { code: 0, out: "git@example.test:vault.git", err: "" };
    },
  };
  const systemdLifecycle = lifecycle({
    ensureAssistantBearer: () => {
      calls.push("ensure-bearer");
      return false;
    },
    migrateEnv: () => {
      calls.push("migrate-env");
      return true;
    },
    writeUnits: () => {
      calls.push("write-units");
      return [];
    },
  });

  await createDoctorCommand(runtime, systemdLifecycle, {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: (code) => exitCodes.push(code),
  })();

  assert.equal(readCount, 2);
  assert.ok(calls.indexOf("read-initial") < calls.indexOf("migrate-env"));
  assert.ok(calls.indexOf("migrate-env") < calls.indexOf("read-fresh"));
  assert.ok(calls.indexOf("read-fresh") < calls.indexOf("inspect-listener"));
  assert.deepEqual(listenerArgs, [["-H", "-ltn", "sport", "=", ":9123"]]);
  assert.equal(dataDirInputs.length, 1);
  assert.strictEqual(dataDirInputs[0], initialEnv);
  assert.deepEqual(exitCodes, [0]);
});

test("opencode diagnostics preserve required-key order", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=opencode\n");
  const failures: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: (message) => failures.push(message),
    readEnv: () => ({ MODEL_PROVIDER: "opencode" }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.equal(
    failures[0],
    ".env incomplete, missing: OPENCODE_API_KEY, OPENCODE_MODEL, DEEPGRAM_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ASSISTANT_BEARER — run: iva config",
  );
});

test("doctor reports an update that flipped but never finished", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const name = "0.3.15-abcdefabcdef";
  const dir = join(home, "versions", name);
  mkdirSync(join(dir, ".output/server"), { recursive: true });
  writeFileSync(join(dir, ".output/server/index.mjs"), "export {};\n");
  writeFileSync(join(dir, ".env"), "present=true\n");
  mkdirSync(join(home, "data"), { recursive: true });
  symlinkSync(dir, join(home, "current"));

  const events: Array<[string, string]> = [];
  const root = join(home, "current");
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };
  const doctor = createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  });

  await doctor();
  const unfinished = (): boolean =>
    events.some(([, message]) => message.includes(`update to ${name} never`));
  assert.ok(unfinished(), JSON.stringify(events));

  // Once the installation records the move, there is nothing left to report.
  createVersionStore(home).settle(name);
  events.length = 0;
  await doctor();
  assert.equal(unfinished(), false, JSON.stringify(events));
});

test("doctor rejects an invalid model provider instead of diagnosing Ollama", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=ollmaa\n");
  const failures: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: (message) => failures.push(message),
    readEnv: () => ({ MODEL_PROVIDER: "ollmaa" }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.equal(
    failures[0],
    'Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config',
  );
  assert.equal(
    failures.some((message) => message.includes("OLLAMA_")),
    false,
  );
});

// Доктор и рантайм обязаны принимать один и тот же набор имён и объяснять отказ одним
// предложением: разъедься они, доктор объявил бы .env здоровым перед сервисом, который
// на этом же значении отказывается стартовать, — и починку искали бы не там.
test("doctor accepts exactly the provider names the runtime accepts", async (t) => {
  async function diagnose(provider: string): Promise<string[]> {
    const root = await sandbox(t);
    writeFileSync(join(root, ".env"), `MODEL_PROVIDER=${provider}\n`);
    const failures: string[] = [];
    const runtime: CliRuntime = {
      ...createCliRuntime(root),
      C: NO_COLOR,
      ok: () => undefined,
      warn: () => undefined,
      bad: (message) => failures.push(message),
      readEnv: () => ({ ...completeEnv(), MODEL_PROVIDER: provider }),
      hasSystemd: () => false,
    };
    await createDoctorCommand(runtime, lifecycle(), {
      nodeVersion: "24.0.0",
      log: () => undefined,
      exit: () => undefined,
    })();
    return failures;
  }

  for (const name of MODEL_PROVIDER_NAMES) {
    const failures = await diagnose(name);
    assert.deepEqual(
      failures.filter((message) =>
        message.startsWith("Invalid MODEL_PROVIDER"),
      ),
      [],
      name,
    );
  }
  for (const value of [
    "ollmaa",
    " ollama",
    "ollama ",
    "OLLAMA",
    "оllama",
    "__proto__",
  ]) {
    assert.equal(
      (await diagnose(value))[0],
      invalidModelProviderMessage(value),
      JSON.stringify(value),
    );
  }
});

// --- Раздел «Plugins» (ADR-0009) -----------------------------------------------

function plantStorePlugin(
  data: string,
  name: string,
  manifest: string = JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name }),
): void {
  const root = pluginRoot(data, name);
  mkdirSync(join(root, "skills/alpha"), { recursive: true });
  writeFileSync(join(root, "plugin.json"), manifest);
  writeFileSync(
    join(root, "skills/alpha/SKILL.md"),
    "---\nname: alpha\ndescription: Do the alpha work.\n---\n\nBody.\n",
  );
}

/** Прогоняет доктора без systemd и отдаёт только строки про плагины. */
async function pluginEvents(root: string): Promise<Array<[string, string]>> {
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();
  return events.filter(([, message]) => message.startsWith("plugin"));
}

test("doctor stays silent about plugins on an installation that has none", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");

  assert.deepEqual(await pluginEvents(root), []);
});

test("doctor reports each installed plugin and what it carries", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "demo");
  plantStorePlugin(data, "quiet");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "demo",
        source: "./demo",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
      {
        name: "quiet",
        source: "./quiet",
        ref: "",
        sha: "",
        digest: "",
        enabled: false,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(await pluginEvents(root), [
    ["ok", "plugin demo: 1 skills"],
    ["ok", "plugin quiet (disabled): 1 skills"],
  ]);
});

test("doctor names a plugin missing from disk and points at sync", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "gone",
        source: "./gone",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(await pluginEvents(root), [
    [
      "bad",
      "plugin gone is missing from data/custom/plugins/ — run: iva plugin sync",
    ],
  ]);
});

test("doctor reports an unreadable manifest and a folder nobody recorded", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "broken", JSON.stringify({ name: "broken" }));
  plantStorePlugin(data, "stray");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "broken",
        source: "./broken",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  const events = await pluginEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0][0], "bad");
  assert.match(
    events[0][1],
    /plugin broken is unreadable: .*\$schema must be/u,
  );
  assert.deepEqual(events[1], [
    "warn",
    "plugin folder stray is not in plugins.json — run: iva plugin sync",
  ]);
});

test("doctor reports a damaged plugins.json instead of reading past it", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "demo");
  mkdirSync(join(data, "custom"), { recursive: true });
  writeFileSync(join(data, "custom", "plugins.json"), "{ broken");

  const events = await pluginEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "bad");
  assert.match(events[0][1], /plugins\.json is unusable: .*not valid JSON/u);
});

test("doctor sees the leftovers of an interrupted install that its dot filter hides", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  mkdirSync(join(pluginRoot(data, ".staging-xyz")), { recursive: true });
  mkdirSync(join(pluginRoot(data, ".replaced-ab12")), { recursive: true });

  assert.deepEqual(await pluginEvents(root), [
    [
      "warn",
      "plugin folder .replaced-ab12 is a leftover of an interrupted install — run: iva plugin sync",
    ],
    [
      "warn",
      "plugin folder .staging-xyz is a leftover of an interrupted install — run: iva plugin sync",
    ],
  ]);
});

test("doctor says whether an enabled plugin's code is in the version that runs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-version-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeFileSync(join(home, ".env"), "present=true\n");
  const store = createVersionStore(home);
  const name = "0.3.24-abcdefabcdef+11223344";
  const dir = store.stage(name);
  mkdirSync(join(dir, ".output/server"), { recursive: true });
  writeFileSync(join(dir, ".output/server/index.mjs"), "export {};\n");
  store.linkState(dir);
  store.complete(name);
  store.activate(name);
  const data = join(home, "data");
  // Заявка на namespace плюс `sh.iva/package.json` — это и есть код (ADR-0009).
  plantStorePlugin(
    data,
    "carrier",
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "carrier",
      extensions: { "sh.iva": {} },
    }),
  );
  mkdirSync(join(pluginRoot(data, "carrier"), "sh.iva"), { recursive: true });
  writeFileSync(
    join(pluginRoot(data, "carrier"), "sh.iva/package.json"),
    "{}\n",
  );
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "carrier",
        source: "./carrier",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  // Плагин стоит, а версия собрана без него: тулов плагина у агента нет.
  assert.deepEqual(await pluginEvents(dir), [
    ["ok", "plugin carrier: 1 skills, code"],
    [
      "warn",
      "plugin carrier: built into current version: no — run: iva update",
    ],
  ]);

  // Сборка версии оставляет копию плагина и его mount — доктор видит ровно их.
  mkdirSync(join(dir, "plugins/carrier"), { recursive: true });
  mkdirSync(join(dir, "agent/extensions"), { recursive: true });
  writeFileSync(
    join(dir, "agent/extensions/carrier.ts"),
    "export default 1;\n",
  );

  assert.deepEqual(await pluginEvents(dir), [
    ["ok", "plugin carrier: 1 skills, code"],
    ["ok", "plugin carrier: built into current version: yes"],
  ]);
});

test("doctor checks the plugin units and the health of every MCP proxy", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "trace");
  const unitDir = join(root, "systemd");
  mkdirSync(unitDir, { recursive: true });
  // Живой прокси: настоящий сервер на loopback, отвечающий как `/health` прокси.
  const alive = createServer((request, response) => {
    response
      .writeHead(request.url === "/health" ? 200 : 404, {
        "content-type": "application/json",
      })
      .end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((settle) => alive.listen(0, "127.0.0.1", settle));
  t.after(() => new Promise<void>((settle) => alive.close(() => settle())));
  const answering = (alive.address() as { port: number }).port;
  // Порт, на котором никто не слушает: юнит active, а сервера за ним нет.
  const silent = createServer();
  await new Promise<void>((settle) => silent.listen(0, "127.0.0.1", settle));
  const dead = (silent.address() as { port: number }).port;
  await new Promise<void>((settle) => silent.close(() => settle()));

  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "trace",
        source: "./trace",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: true,
        installedAt: "2026-08-17T12:00:00.000Z",
        mcp: { alive: { port: answering }, quiet: { port: dead } },
        services: { web: { port: 8726 }, gone: { port: 8727 } },
      },
    ],
  });
  for (const unit of [
    "iva-mcp-trace-alive.service",
    "iva-mcp-trace-quiet.service",
    "iva-plugin-trace-web.service",
    // Юнит без записи: остался от снятого плагина.
    "iva-mcp-orphan-srv.service",
  ])
    writeFileSync(join(unitDir, unit), "[Service]\n");

  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    UNIT_DIR: unitDir,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => true,
    systemd: {
      ...createCliRuntime(root).systemd,
      isActive: (unit: string) => unit !== "iva-plugin-trace-web.service",
      isEnabled: () => true,
    },
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  const said = events.filter(([, message]) =>
    /plugin|iva-mcp|iva-plugin/u.test(message),
  );
  assert.deepEqual(said, [
    ["ok", "plugin trace: 1 skills"],
    [
      "ok",
      `plugin trace: iva-mcp-trace-alive.service answers on 127.0.0.1:${answering}`,
    ],
    [
      "warn",
      `plugin trace: iva-mcp-trace-quiet.service runs but does not answer on 127.0.0.1:${dead} — check: journalctl --user -u iva-mcp-trace-quiet.service -n 100 --no-pager`,
    ],
    [
      "warn",
      "plugin trace: iva-plugin-trace-gone.service is missing — run: iva plugin sync",
    ],
    [
      "bad",
      "plugin trace: iva-plugin-trace-web.service is not running — check: journalctl --user -u iva-plugin-trace-web.service -n 100 --no-pager",
    ],
    [
      "warn",
      "iva-mcp-orphan-srv.service belongs to no enabled and trusted plugin — run: iva plugin sync",
    ],
  ]);
});
