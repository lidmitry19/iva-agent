/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Юниты плагина: тела, план и reconcile против фейкового systemctl. Живых юнитов здесь
// нет и быть не может — фейк ведёт своё состояние (`enabled`/`active`) ровно как
// `systemctl --user`, и все проверки идут по файлам в каталоге юнитов и по вызовам.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ свойства: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { SAFE_PLUGIN_PART } from "#lib/plugin-store.ts";
import { createSystemdControl } from "./systemd-control.ts";
import {
  installedPluginUnits,
  mcpProxyUnitBody,
  mcpUnitName,
  pluginServiceUnitBody,
  pluginUnitNames,
  pluginUnitPlan,
  reconcilePluginUnits,
  runningPluginUnits,
  serviceUnitName,
  UNIT_PART,
  unitPartProblem,
  type PluginUnitSource,
} from "./plugin-units.ts";

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-units-"));
  worlds.push(dir);
  return dir;
}

/**
 * `systemctl --user` как его видит systemd-control: состояние в памяти, журнал вызовов,
 * и один юнит, который отказывается подниматься, — этим проверяется, что сосед всё равно
 * получает свой.
 */
function fakeSystemctl({ broken }: { broken?: string } = {}) {
  const calls: string[] = [];
  const enabled = new Set<string>();
  const active = new Set<string>();
  const control = createSystemdControl({
    run: (args) => {
      calls.push(args.join(" "));
      const [action, ...rest] = args;
      const unit = rest.filter((value) => !value.startsWith("--")).at(0) ?? "";
      switch (action) {
        case "enable":
          if (unit === broken) return { code: 1, out: "job failed" };
          enabled.add(unit);
          if (rest.includes("--now")) active.add(unit);
          return { code: 0, out: "" };
        case "disable":
          enabled.delete(unit);
          active.delete(unit);
          return { code: 0, out: "" };
        case "restart":
          active.add(unit);
          return { code: 0, out: "" };
        case "stop":
          active.delete(unit);
          return { code: 0, out: "" };
        case "is-enabled":
          return enabled.has(unit)
            ? { code: 0, out: "enabled" }
            : { code: 1, out: "disabled" };
        case "is-active":
          return active.has(unit)
            ? { code: 0, out: "active" }
            : { code: 3, out: "inactive" };
        default:
          return { code: 0, out: "" };
      }
    },
  });
  return { control, calls, enabled, active };
}

const NODE = "/home/iva/.nvm/versions/node/v24.5.0/bin/node";
const NODE_BIN = "/home/iva/.nvm/versions/node/v24.5.0/bin";
const ROOT = "/home/iva/iva/current";
const DATA = "/home/iva/iva/data";

function source0(overrides: Partial<PluginUnitSource> = {}): PluginUnitSource {
  return {
    name: "trace",
    enabled: true,
    trusted: true,
    root: `${DATA}/custom/plugins/trace`,
    data: `${DATA}/plugin-data/trace`,
    mcp: [],
    services: [],
    ...overrides,
  };
}

function plan(plugins: readonly PluginUnitSource[]) {
  return pluginUnitPlan({
    plugins,
    root: ROOT,
    node: NODE,
    nodeBinDir: NODE_BIN,
    dataDir: DATA,
    dataDirEnvironment: `"ASSISTANT_DATA_DIR=${DATA}"`,
  });
}

test("a unit is named after the plugin and the server or the service", () => {
  assert.equal(mcpUnitName("trace", "viewer"), "iva-mcp-trace-viewer.service");
  assert.equal(
    serviceUnitName("trace", "viewer"),
    "iva-plugin-trace-viewer.service",
  );
  assert.equal(unitPartProblem("MCP server", "viewer"), null);
  assert.equal(unitPartProblem("MCP server", "my.srv_1-2"), null);
  // Имя-путь наружу не становится именем юнита ни при каких условиях.
  assert.match(
    unitPartProblem("MCP server", "../../evil") ?? "",
    /cannot become a systemd unit/u,
  );
  assert.match(unitPartProblem("service", "a b") ?? "", /letters, digits/u);
  assert.match(unitPartProblem("service", "") ?? "", /letters, digits/u);
});

test("the MCP proxy unit runs the proxy of the running version, with no secrets", () => {
  const body = mcpProxyUnitBody({
    plugin: "trace",
    server: "viewer",
    port: 8731,
    tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
    root: ROOT,
    node: NODE,
    nodeBinDir: NODE_BIN,
    dataDirEnvironment: `"ASSISTANT_DATA_DIR=${DATA}"`,
  });
  assert.match(
    body,
    new RegExp(
      `^ExecStart=/usr/bin/env "ASSISTANT_DATA_DIR=${DATA}" "${NODE}" "${ROOT}/services/mcp-proxy/serve.ts" --plugin "trace" --server "viewer" --port 8731 --token-file "${DATA}/plugin-data/trace/mcp-viewer.token"$`,
      "mu",
    ),
  );
  // ROOT — это `current`: flip переносит прокси на новую версию без правки юнита.
  assert.match(body, new RegExp(`^WorkingDirectory=${ROOT}$`, "mu"));
  assert.match(body, /^Restart=on-failure$/mu);
  assert.match(body, /^RestartSec=5$/mu);
  assert.match(body, /^UMask=0077$/mu);
  assert.match(body, /^After=network-online\.target$/mu);
  assert.match(body, /^WantedBy=default\.target$/mu);
  assert.match(body, new RegExp(`^Environment="PATH=${NODE_BIN}:`, "mu"));
  // Ни одного секрета инсталляции: EnvironmentFile у прокси нет.
  assert.doesNotMatch(body, /EnvironmentFile/u);
  assert.doesNotMatch(body, /TELEGRAM|OPENAI|ASSISTANT_BEARER/u);
});

test("a plugin service gets its port, its paths, and nothing of the agent's", () => {
  const body = pluginServiceUnitBody({
    plugin: "trace",
    service: "viewer",
    command: "node",
    args: ["server.mjs", `${DATA}/plugin-data/trace/state`],
    port: 8726,
    pluginRoot: `${DATA}/custom/plugins/trace`,
    pluginData: `${DATA}/plugin-data/trace`,
    dataDir: DATA,
    nodeBinDir: NODE_BIN,
  });
  assert.match(
    body,
    new RegExp(
      `^WorkingDirectory=${DATA}/custom/plugins/trace/sh\\.iva/services/viewer$`,
      "mu",
    ),
  );
  assert.match(
    body,
    new RegExp(
      `^ExecStart=/usr/bin/env "node" "server.mjs" "${DATA}/plugin-data/trace/state"$`,
      "mu",
    ),
  );
  // Ровно четыре значения плюс PATH — контракт сервиса плагина (ADR-0009).
  assert.deepEqual(
    body.split("\n").filter((line) => line.startsWith("Environment=")),
    [
      'Environment="IVA_SERVICE_PORT=8726"',
      `Environment="IVA_DATA_DIR=${DATA}"`,
      `Environment="PLUGIN_ROOT=${DATA}/custom/plugins/trace"`,
      `Environment="PLUGIN_DATA=${DATA}/plugin-data/trace"`,
      `Environment="PATH=${NODE_BIN}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"`,
    ],
  );
  assert.doesNotMatch(body, /EnvironmentFile/u);
  assert.match(body, /^Restart=on-failure$/mu);

  // `./`-команда — файл автора, и запускается по абсолютному пути: у systemd нет
  // ExecStart относительно cwd.
  const own = pluginServiceUnitBody({
    plugin: "trace",
    service: "viewer",
    command: "./serve.mjs",
    args: [],
    port: 8726,
    pluginRoot: `${DATA}/custom/plugins/trace`,
    pluginData: `${DATA}/plugin-data/trace`,
    dataDir: DATA,
    nodeBinDir: NODE_BIN,
  });
  assert.match(
    own,
    new RegExp(
      `^ExecStart="${DATA}/custom/plugins/trace/sh\\.iva/services/viewer/serve\\.mjs"$`,
      "mu",
    ),
  );
});

test("only an enabled and trusted plugin has units at all", () => {
  const mcp = [
    {
      server: "viewer",
      port: 8731,
      tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
    },
  ];
  assert.deepEqual(
    plan([source0({ mcp })]).units.map((unit) => unit.unit),
    ["iva-mcp-trace-viewer.service"],
  );
  assert.deepEqual(plan([source0({ mcp, trusted: false })]).units, []);
  assert.deepEqual(plan([source0({ mcp, enabled: false })]).units, []);
});

test("a name or a port that cannot make a unit is named instead of guessed", () => {
  const planned = plan([
    source0({
      mcp: [
        { server: "a b", port: 8731, tokenFile: "/t" },
        { server: "viewer", port: undefined, tokenFile: "/t" },
      ],
      services: [
        { service: "../evil", command: "node", args: [], port: 8726 },
        { service: "viewer", command: "node", args: [], port: undefined },
      ],
    }),
  ]);
  assert.deepEqual(planned.units, []);
  assert.deepEqual(planned.diagnostics, [
    'plugin trace: the MCP server "a b" cannot become a systemd unit: use letters, digits, ".", "-" and "_", starting with a letter or a digit',
    'plugin trace: the MCP server "viewer" has no port yet - run: iva plugin trust trace',
    'plugin trace: the service "../evil" cannot become a systemd unit: use letters, digits, ".", "-" and "_", starting with a letter or a digit',
    'plugin trace: the service "viewer" has no port yet - run: iva plugin trust trace',
  ]);
});

test("reconcile writes what belongs, starts it, and takes away what does not", () => {
  const home = world();
  const unitDir = join(home, "systemd");
  mkdirSync(unitDir, { recursive: true });
  // Юниты самой Ивы и чужого сервиса в том же каталоге: их трогать нельзя.
  writeFileSync(join(unitDir, "iva.service"), "[Service]\n");
  writeFileSync(join(unitDir, "iva-telegram-poll.service"), "[Service]\n");
  writeFileSync(join(unitDir, "unrelated.service"), "[Service]\n");
  // След прошлой раскладки: этот плагин снят.
  writeFileSync(join(unitDir, "iva-mcp-old-server.service"), "[Service]\n");
  writeFileSync(join(unitDir, "iva-plugin-old-svc.service"), "[Service]\n");

  const { control, calls } = fakeSystemctl();
  const created: string[] = [];
  const planned = plan([
    source0({
      mcp: [{ server: "viewer", port: 8731, tokenFile: "/t/mcp-viewer.token" }],
      services: [
        { service: "web", command: "node", args: ["server.mjs"], port: 8726 },
      ],
    }),
  ]);

  const done = reconcilePluginUnits({
    plan: planned,
    unitDir,
    systemd: control,
    ensureDataDir: (plugin) => created.push(plugin),
    log: () => {},
  });

  assert.deepEqual(done.written, [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
  ]);
  assert.deepEqual(done.started, done.written);
  assert.deepEqual(done.removed, [
    "iva-mcp-old-server.service",
    "iva-plugin-old-svc.service",
  ]);
  assert.deepEqual(done.failures, []);
  // PLUGIN_DATA создаётся до старта юнита: сам юнит его не создаёт.
  assert.deepEqual(created, ["trace", "trace"]);
  assert.deepEqual(readdirSync(unitDir).sort(), [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
    "iva-telegram-poll.service",
    "iva.service",
    "unrelated.service",
  ]);
  assert.match(
    readFileSync(join(unitDir, "iva-mcp-trace-viewer.service"), "utf8"),
    /--port 8731/u,
  );
  // Снятый юнит гаснет ДО того, как поднимается новый: иначе он держит порт.
  assert.ok(
    calls.indexOf("disable --now iva-mcp-old-server.service") <
      calls.indexOf("enable --now iva-mcp-trace-viewer.service"),
    calls.join("\n"),
  );
  assert.ok(calls.includes("daemon-reload"), calls.join("\n"));

  // Второй прогон с пустым планом уносит и наши юниты, и только их.
  const empty = reconcilePluginUnits({
    plan: plan([]),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(empty.removed, [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
  ]);
  assert.deepEqual(readdirSync(unitDir).sort(), [
    "iva-telegram-poll.service",
    "iva.service",
    "unrelated.service",
  ]);
  assert.deepEqual(installedPluginUnits(unitDir), []);
});

test("a unit that will not come up is reported and its neighbour still starts", () => {
  const unitDir = join(world(), "systemd");
  const { control } = fakeSystemctl({ broken: "iva-mcp-trace-viewer.service" });
  const done = reconcilePluginUnits({
    plan: plan([
      source0({
        mcp: [{ server: "viewer", port: 8731, tokenFile: "/t" }],
        services: [{ service: "web", command: "node", args: [], port: 8726 }],
      }),
    ]),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(done.started, ["iva-plugin-trace-web.service"]);
  assert.equal(done.failures.length, 1);
  assert.match(done.failures[0], /^iva-mcp-trace-viewer\.service: /u);
  // Файл всё равно на диске: чинить причину, а не искать, куда он делся.
  assert.ok(existsSync(join(unitDir, "iva-mcp-trace-viewer.service")));
});

test("the two copies of the plugin-part rule agree", () => {
  // Правило имени живёт в двух местах (юниты не грузят authored tree) — они обязаны
  // совпадать байт в байт, иначе `trust` примет имя, которое юнит потом отвергнет.
  assert.equal(UNIT_PART.source, SAFE_PLUGIN_PART.source);
  fc.assert(
    fc.property(fc.string(), (part) => {
      assert.equal(UNIT_PART.test(part), SAFE_PLUGIN_PART.test(part));
      return true;
    }),
  );
});

test("a data directory with a space or a percent survives into Environment=", () => {
  const odd = "/home/my box/100% iva/data";
  const body = pluginServiceUnitBody({
    plugin: "trace",
    service: "web",
    command: "node",
    args: ["server.mjs"],
    port: 8726,
    pluginRoot: `${odd}/custom/plugins/trace`,
    pluginData: `${odd}/plugin-data/trace`,
    dataDir: odd,
    nodeBinDir: "/opt/node bin",
  });
  // Кавычки — весь смысл: без них сервис получил бы `/home/my`, а `%` systemd съел бы
  // как спецификатор. `$` в `Environment=` не раскрывается, поэтому не трогается.
  assert.deepEqual(
    body.split("\n").filter((line) => line.startsWith("Environment=")),
    [
      'Environment="IVA_SERVICE_PORT=8726"',
      'Environment="IVA_DATA_DIR=/home/my box/100%% iva/data"',
      'Environment="PLUGIN_ROOT=/home/my box/100%% iva/data/custom/plugins/trace"',
      'Environment="PLUGIN_DATA=/home/my box/100%% iva/data/plugin-data/trace"',
      'Environment="PATH=/opt/node bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"',
    ],
  );
  // `%h` в нашей части PATH остаётся спецификатором: удваивается только чужое значение.
  const dollar = pluginServiceUnitBody({
    plugin: "trace",
    service: "web",
    command: "node",
    args: [],
    port: 8726,
    pluginRoot: "/r",
    pluginData: '/d/$HOME/"quoted"\\back',
    dataDir: "/d",
    nodeBinDir: "/n",
  });
  assert.match(
    dollar,
    /^Environment="PLUGIN_DATA=\/d\/\$HOME\/\\"quoted\\"\\\\back"$/mu,
  );
  assert.throws(
    () =>
      pluginServiceUnitBody({
        plugin: "trace",
        service: "web",
        command: "node",
        args: [],
        port: 8726,
        pluginRoot: "/r",
        pluginData: "/d/line\nbreak",
        dataDir: "/d",
        nodeBinDir: "/n",
      }),
    /NUL or a newline/u,
  );
});

test("a rewritten unit is restarted, an unchanged one is left running", () => {
  const unitDir = join(world(), "systemd");
  const { control, calls } = fakeSystemctl();
  const planned = () =>
    plan([
      source0({
        services: [{ service: "web", command: "node", args: [], port: 8726 }],
      }),
    ]);

  const first = reconcilePluginUnits({
    plan: planned(),
    unitDir,
    systemd: control,
  });
  // Первый прогон только поднимает: рестартовать нечего.
  assert.deepEqual(first.started, ["iva-plugin-trace-web.service"]);
  assert.deepEqual(first.restarted, []);

  // Тот же план — тот же файл: работающий юнит не трогаем.
  calls.length = 0;
  const again = reconcilePluginUnits({
    plan: planned(),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(again.restarted, []);
  assert.equal(
    calls.includes("restart iva-plugin-trace-web.service"),
    false,
    calls.join("\n"),
  );

  // Автор поменял `service.json`: тело юнита другое, и `enable --now` работающий
  // процесс не заменит — нужен рестарт.
  calls.length = 0;
  const changed = reconcilePluginUnits({
    plan: plan([
      source0({
        services: [
          { service: "web", command: "node", args: ["--quiet"], port: 8726 },
        ],
      }),
    ]),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(changed.restarted, ["iva-plugin-trace-web.service"]);
  assert.ok(
    calls.indexOf("enable --now iva-plugin-trace-web.service") <
      calls.indexOf("restart iva-plugin-trace-web.service"),
    calls.join("\n"),
  );
  assert.match(
    readFileSync(join(unitDir, "iva-plugin-trace-web.service"), "utf8"),
    /--quiet/u,
  );
});

test("one unit name for two plugins installs neither and names both", () => {
  // `a-b` с сервером `c` и `a` с сервером `b-c` дают одно имя юнита.
  const planned = pluginUnitPlan({
    plugins: [
      source0({
        name: "a-b",
        root: `${DATA}/custom/plugins/a-b`,
        data: `${DATA}/plugin-data/a-b`,
        mcp: [{ server: "c", port: 8730, tokenFile: "/t1" }],
      }),
      source0({
        name: "a",
        root: `${DATA}/custom/plugins/a`,
        data: `${DATA}/plugin-data/a`,
        mcp: [{ server: "b-c", port: 8731, tokenFile: "/t2" }],
      }),
      // Сервисы — то же правило и то же имя.
      source0({
        name: "x-y",
        root: `${DATA}/custom/plugins/x-y`,
        data: `${DATA}/plugin-data/x-y`,
        services: [{ service: "z", command: "node", args: [], port: 8732 }],
      }),
      source0({
        name: "x",
        root: `${DATA}/custom/plugins/x`,
        data: `${DATA}/plugin-data/x`,
        services: [{ service: "y-z", command: "node", args: [], port: 8733 }],
      }),
      // Сосед без коллизии остаётся.
      source0({
        mcp: [{ server: "viewer", port: 8734, tokenFile: "/t3" }],
      }),
    ],
    root: ROOT,
    node: NODE,
    nodeBinDir: NODE_BIN,
    dataDir: DATA,
    dataDirEnvironment: `"ASSISTANT_DATA_DIR=${DATA}"`,
  });

  assert.deepEqual(
    planned.units.map((unit) => unit.unit),
    ["iva-mcp-trace-viewer.service"],
  );
  assert.deepEqual(planned.diagnostics, [
    "plugins a and a-b both want the unit iva-mcp-a-b-c.service; neither is installed - remove one: iva plugin remove <name>",
    "plugins x and x-y both want the unit iva-plugin-x-y-z.service; neither is installed - remove one: iva plugin remove <name>",
  ]);
});

test("the units of one plugin are its ports, and only the running ones restart", () => {
  const unitDir = join(world(), "systemd");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "iva-mcp-trace-viewer.service"), "[Service]\n");
  writeFileSync(join(unitDir, "iva-plugin-trace-web.service"), "[Service]\n");

  assert.deepEqual(
    pluginUnitNames({
      name: "trace",
      mcp: { viewer: { port: 8730 } },
      services: { web: { port: 8726 }, gone: { port: 8727 } },
    }),
    [
      "iva-mcp-trace-viewer.service",
      "iva-plugin-trace-web.service",
      "iva-plugin-trace-gone.service",
    ],
  );
  assert.deepEqual(pluginUnitNames({ name: "bare" }), []);

  assert.deepEqual(
    runningPluginUnits({
      units: [
        "iva-mcp-trace-viewer.service",
        // Файла нет: не наш рестарт, а работа для `sync`.
        "iva-plugin-trace-gone.service",
        // Файл есть, но юнит стоит: его кто-то остановил.
        "iva-plugin-trace-web.service",
      ],
      unitDir,
      isActive: (unit) => unit !== "iva-plugin-trace-web.service",
    }),
    ["iva-mcp-trace-viewer.service"],
  );
});
