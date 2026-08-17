/**
 * The systemd units of a plugin: one MCP proxy per stdio server, one unit per declared
 * service (ADR-0009).
 *
 * Units are generated here rather than shipped in `deploy/`, because there is nothing to
 * ship: their names and their arguments come from what the owner installed, which no
 * release can know. The bodies are written by hand for the same reason `ivaServiceBody()`
 * is - a template with placeholders would be a second language to get wrong - and every
 * value that reaches an `ExecStart=` goes through the systemd escaper first.
 *
 * Nothing here reads the authored tree at load time (ADR-0003): the caller hands over
 * what it already read, and the plan is a pure function of that. It is also the only
 * shape a test needs - a plan and a fake systemctl, no live units.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupSystemdUnits, systemdExecArgument } from "./systemd-control.ts";

type Say = (message: string) => void;

/** What a plugin's units are called. Both prefixes belong to Iva and to nobody else. */
const MCP_PREFIX = "iva-mcp-";
const SERVICE_PREFIX = "iva-plugin-";
/** Every unit of a plugin, by name: what a reconcile may remove as well as write. */
export const PLUGIN_UNIT_RE = /^iva-(?:mcp|plugin)-.+\.service$/u;
/**
 * What a server or service name may contain when it becomes part of a unit name. The
 * copy of `SAFE_PLUGIN_PART` in `agent/lib/plugin-store.ts`, kept here because unit
 * generation must load without the authored tree; `plugin-units.test.ts` pins them equal.
 */
export const UNIT_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** The PATH every generated unit runs with: node first, then the usual places. */
const UNIT_PATH = "%h/.local/bin:/usr/local/bin:/usr/bin:/bin";

/** One unit to be on disk, with the body it must have. */
export type PluginUnit = {
  readonly unit: string;
  readonly body: string;
  /** Which plugin it belongs to - what a message about it has to name. */
  readonly plugin: string;
};

/** What the units of the installation should be, and what could not be turned into one. */
export type PluginUnitPlan = {
  readonly units: readonly PluginUnit[];
  readonly diagnostics: readonly string[];
};

/**
 * Раскрыть `${PLUGIN_ROOT}` и `${PLUGIN_DATA}` — один проход, без рекурсии. Копия
 * `expandPluginPlaceholders` из `agent/lib/plugin-reader.ts`: юниты пишутся командой,
 * которая обязана грузиться без authored tree, а правило подстановки у обеих сторон
 * одно. Равенство копий пинует `plugin-units.test.ts`.
 */
export function expandPluginPlaceholders(
  value: string,
  paths: { readonly root: string; readonly data: string },
): string {
  return value.replaceAll(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu, (_, key) =>
    key === "PLUGIN_ROOT" ? paths.root : paths.data,
  );
}

/** The unit of the MCP proxy for one server of one plugin. */
export function mcpUnitName(plugin: string, server: string): string {
  return `${MCP_PREFIX}${plugin}-${server}.service`;
}

/** The unit of one declared service of one plugin. */
export function serviceUnitName(plugin: string, service: string): string {
  return `${SERVICE_PREFIX}${plugin}-${service}.service`;
}

/**
 * Why this name cannot go into a unit name, or null. A plugin name is already restricted
 * by the spec, but a key in `mcp.json` and a folder under `sh.iva/services/` are not: a
 * server called `../../evil` would name a file outside the unit directory.
 */
export function unitPartProblem(kind: string, part: string): string | null {
  return UNIT_PART.test(part)
    ? null
    : `the ${kind} ${JSON.stringify(part)} cannot become a systemd unit: use letters, digits, ".", "-" and "_", starting with a letter or a digit`;
}

/** The body of an MCP proxy unit. */
export function mcpProxyUnitBody({
  plugin,
  server,
  port,
  tokenFile,
  root,
  node,
  nodeBinDir,
  dataDirEnvironment,
}: {
  readonly plugin: string;
  readonly server: string;
  readonly port: number;
  readonly tokenFile: string;
  /** The installation root; on the immutable layout this is the `current` symlink, so a
   * flip moves the proxy onto the new version without rewriting the unit. */
  readonly root: string;
  readonly node: string;
  readonly nodeBinDir: string;
  /** `ASSISTANT_DATA_DIR=…`, already escaped - the same one every other unit carries. */
  readonly dataDirEnvironment: string;
}): string {
  const argument = (value: string): string => systemdExecArgument(value);
  return [
    "[Unit]",
    `Description=Iva MCP proxy for ${plugin}/${server}`,
    "After=network-online.target",
    "",
    "[Service]",
    // The token file and whatever the MCP server writes stay private, exactly as the
    // userbot proxy's session does.
    "UMask=0077",
    `WorkingDirectory=${root}`,
    `ExecStart=/usr/bin/env ${dataDirEnvironment} ${argument(node)} ${argument(
      join(root, "services/mcp-proxy/serve.ts"),
    )} --plugin ${argument(plugin)} --server ${argument(server)} --port ${port} --token-file ${argument(tokenFile)}`,
    // No EnvironmentFile: the proxy must not have the installation's secrets to pass on.
    // node comes first on PATH so an MCP server started as `npx …` finds the same one.
    `Environment=PATH=${nodeBinDir}:${UNIT_PATH}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The body of a plugin service unit. */
export function pluginServiceUnitBody({
  plugin,
  service,
  command,
  args,
  port,
  pluginRoot,
  pluginData,
  dataDir,
  nodeBinDir,
}: {
  readonly plugin: string;
  readonly service: string;
  /** One token: a bare name found on PATH, or a `./`-path inside the service folder. */
  readonly command: string;
  /** Placeholders already expanded. */
  readonly args: readonly string[];
  /** The port Iva handed the service; it must listen on loopback only. */
  readonly port: number;
  readonly pluginRoot: string;
  readonly pluginData: string;
  /** Iva's data directory: where a service reads `trace/` from. */
  readonly dataDir: string;
  readonly nodeBinDir: string;
}): string {
  const argument = (value: string): string => systemdExecArgument(value);
  const workingDirectory = join(pluginRoot, "sh.iva/services", service);
  // A bare name is looked up on PATH by `env`; a `./`-path is the author's own file and
  // is run by its absolute path, because systemd has no cwd-relative ExecStart.
  const executable = command.startsWith("./")
    ? argument(join(workingDirectory, command.slice(2)))
    : `/usr/bin/env ${argument(command)}`;
  return [
    "[Unit]",
    `Description=Iva plugin service ${plugin}/${service}`,
    "After=network-online.target",
    "",
    "[Service]",
    "UMask=0077",
    `WorkingDirectory=${workingDirectory}`,
    `ExecStart=${executable}${args.length ? ` ${args.map(argument).join(" ")}` : ""}`,
    // The whole environment a service gets, and nothing of the agent's (ADR-0009).
    `Environment=IVA_SERVICE_PORT=${port}`,
    `Environment=IVA_DATA_DIR=${systemdEnvironmentValue(dataDir)}`,
    `Environment=PLUGIN_ROOT=${systemdEnvironmentValue(pluginRoot)}`,
    `Environment=PLUGIN_DATA=${systemdEnvironmentValue(pluginData)}`,
    `Environment=PATH=${nodeBinDir}:${UNIT_PATH}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * One `Environment=` value. systemd expands `$` and `%` here too, and a newline would
 * end the directive - the same rule as an `ExecStart` argument, minus the quotes, which
 * systemd does not want on this side.
 */
function systemdEnvironmentValue(value: string): string {
  const quoted = systemdExecArgument(value);
  return quoted.slice(1, -1);
}

/** What the caller already read about one plugin: enough to plan its units. */
export type PluginUnitSource = {
  readonly name: string;
  readonly enabled: boolean;
  readonly trusted: boolean;
  /** `PLUGIN_ROOT`: `data/custom/plugins/<name>`. */
  readonly root: string;
  /** `PLUGIN_DATA`: `data/plugin-data/<name>`. */
  readonly data: string;
  /** The stdio MCP servers of the plugin, with the port each was handed. */
  readonly mcp: readonly {
    readonly server: string;
    readonly port: number | undefined;
    readonly tokenFile: string;
  }[];
  /** The declared services of the plugin, with the port each was handed. */
  readonly services: readonly {
    readonly service: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly port: number | undefined;
  }[];
};

/**
 * Every unit the installation should have right now. A plugin contributes units only
 * while it is enabled AND trusted: `enabled` is the text in the prompt, `trusted` is a
 * process on the machine, and one switch for both was rejected in ADR-0009.
 */
export function pluginUnitPlan({
  plugins,
  root,
  node,
  nodeBinDir,
  dataDir,
  dataDirEnvironment,
}: {
  readonly plugins: readonly PluginUnitSource[];
  readonly root: string;
  readonly node: string;
  readonly nodeBinDir: string;
  readonly dataDir: string;
  readonly dataDirEnvironment: string;
}): PluginUnitPlan {
  const units: PluginUnit[] = [];
  const diagnostics: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.trusted) continue;
    const named = unitPartProblem("plugin", plugin.name);
    if (named) {
      diagnostics.push(named);
      continue;
    }
    for (const server of plugin.mcp) {
      const problem = unitPartProblem("MCP server", server.server);
      if (problem) {
        diagnostics.push(`plugin ${plugin.name}: ${problem}`);
        continue;
      }
      if (server.port === undefined) {
        diagnostics.push(
          `plugin ${plugin.name}: the MCP server ${JSON.stringify(server.server)} has no port yet - run: iva plugin trust ${plugin.name}`,
        );
        continue;
      }
      units.push({
        plugin: plugin.name,
        unit: mcpUnitName(plugin.name, server.server),
        body: mcpProxyUnitBody({
          plugin: plugin.name,
          server: server.server,
          port: server.port,
          tokenFile: server.tokenFile,
          root,
          node,
          nodeBinDir,
          dataDirEnvironment,
        }),
      });
    }
    for (const service of plugin.services) {
      const problem = unitPartProblem("service", service.service);
      if (problem) {
        diagnostics.push(`plugin ${plugin.name}: ${problem}`);
        continue;
      }
      if (service.port === undefined) {
        diagnostics.push(
          `plugin ${plugin.name}: the service ${JSON.stringify(service.service)} has no port yet - run: iva plugin trust ${plugin.name}`,
        );
        continue;
      }
      units.push({
        plugin: plugin.name,
        unit: serviceUnitName(plugin.name, service.service),
        body: pluginServiceUnitBody({
          plugin: plugin.name,
          service: service.service,
          command: service.command,
          args: service.args,
          port: service.port,
          pluginRoot: plugin.root,
          pluginData: plugin.data,
          dataDir,
          nodeBinDir,
        }),
      });
    }
  }
  return { units, diagnostics };
}

/** What one reconcile did, so the command that asked can say it in one line. */
export type PluginUnitReconcile = {
  readonly written: readonly string[];
  readonly started: readonly string[];
  readonly removed: readonly string[];
  readonly failures: readonly string[];
};

/**
 * Make the unit directory say what the plan says: write what belongs there, `enable
 * --now` it, and take away every plugin unit that no longer belongs.
 *
 * A unit that will not come up is a failure of that unit and of nothing else: the plugin
 * beside it still gets its own, and the state on disk was decided before this ran. The
 * caller reports the failures; it does not roll the state back, because a proxy that does
 * not start is a thing to fix, not a reason to un-trust a plugin behind the owner's back.
 */
export function reconcilePluginUnits({
  plan,
  unitDir,
  systemd,
  ensureDataDir = () => {},
  log = () => {},
}: {
  readonly plan: PluginUnitPlan;
  readonly unitDir: string;
  readonly systemd: {
    readonly activate: (units: readonly string[]) => void;
    readonly disableNow: (units: readonly string[]) => void;
    readonly daemonReload: () => unknown;
    readonly resetFailed: (units?: readonly string[]) => unknown;
  };
  /** `PLUGIN_DATA` must exist before a unit starts: the unit does not create it. */
  readonly ensureDataDir?: (plugin: string) => void;
  readonly log?: Say;
}): PluginUnitReconcile {
  const wanted = new Map(plan.units.map((unit) => [unit.unit, unit]));
  const existing = existsSync(unitDir)
    ? readdirSync(unitDir).filter((name) => PLUGIN_UNIT_RE.test(name))
    : [];
  const stale = existing.filter((unit) => !wanted.has(unit));
  const failures: string[] = [];
  const written: string[] = [];

  mkdirSync(unitDir, { recursive: true });
  for (const unit of plan.units) {
    const file = join(unitDir, unit.unit);
    // Rewritten every time: a unit whose port or path changed must not keep the old one,
    // and comparing bodies would only save a write nobody notices.
    writeFileSync(file, unit.body);
    written.push(unit.unit);
  }
  // The old ones go before anything starts: a stale proxy holds the port its replacement
  // wants, and `disable --now` is what frees it.
  if (stale.length) {
    try {
      cleanupSystemdUnits({
        units: stale,
        disable: (unit) => systemd.disableNow([unit]),
        remove: (unit) => rmSync(join(unitDir, unit), { force: true }),
        reload: () => systemd.daemonReload(),
        reset: () => systemd.resetFailed(),
      });
      log(`removed ${stale.length} plugin unit(s) that no longer belong`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  } else if (written.length) {
    try {
      systemd.daemonReload();
    } catch (error) {
      // A reload that fails is a systemd of its own to fix; it is not this command's
      // to throw about, and every unit below will say so in its own words anyway.
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const started: string[] = [];
  for (const unit of plan.units) {
    try {
      ensureDataDir(unit.plugin);
    } catch (error) {
      failures.push(
        `${unit.plugin}: its data directory could not be created: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    try {
      systemd.resetFailed([unit.unit]);
    } catch {
      // Nothing to reset is the normal case; a unit that never failed has no state.
    }
    try {
      systemd.activate([unit.unit]);
      started.push(unit.unit);
    } catch (error) {
      failures.push(
        `${unit.unit}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { written, started, removed: stale, failures };
}

/** Every plugin unit on disk, in name order: what `iva doctor` inspects. */
export function installedPluginUnits(unitDir: string): string[] {
  if (!existsSync(unitDir)) return [];
  return readdirSync(unitDir)
    .filter((name) => PLUGIN_UNIT_RE.test(name))
    .sort();
}
