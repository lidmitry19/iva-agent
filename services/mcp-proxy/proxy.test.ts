/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// MCP proxy целиком, без единой заглушки на интересном пути: настоящий stdio-сервер
// на SDK с одной стороны, настоящий SDK-клиент по streamable-http с другой, между
// ними наш прокси на случайном порту. Проверяется то, за что он отвечает: тулы
// доходят, bearer обязателен, `/health` отвечает без него, и env ребёнка — только
// его собственный.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from "#lib/plugin-reader.ts";
import { pluginDataDir, pluginEnvFile, pluginRoot } from "#lib/plugin-store.ts";
import { startMcpProxy, type RunningProxy } from "./proxy.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ECHO_SERVER = join(ROOT, "scripts/fixtures/mcp-echo-server.ts");
const TOKEN = "3f6a1b8c9d0e4f5a6b7c8d9e0f1a2b3c";
/** Ставится в env САМОГО прокси: в ребёнке его быть не должно. */
const MARKER = "IVA_PROXY_MARKER";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Каталог данных с одним плагином, чей `mcp.json` объявляет stdio-сервер `echo`. */
function world({
  args = [],
  env = {},
  cwd,
}: {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-mcp-proxy-"));
  worlds.push(dir);
  const data = join(dir, "data");
  const root = pluginRoot(data, "demo");
  write(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "demo" }),
  );
  write(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        echo: {
          type: "stdio",
          command: "node",
          args: [ECHO_SERVER, ...args],
          ...(Object.keys(env).length ? { env } : {}),
          ...(cwd ? { cwd } : {}),
        },
      },
    }),
  );
  mkdirSync(pluginDataDir(data, "demo"), { recursive: true });
  return data;
}

/** Клиент, который агент и поднимает: streamable-http плюс bearer. */
async function connect(
  proxy: RunningProxy,
  token = TOKEN,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: "iva-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${proxy.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return { client, close: () => client.close() };
}

test("the proxy carries a stdio MCP server to an SDK client over streamable http", async (t) => {
  const data = world({
    args: ["--data", "${PLUGIN_DATA}", "--root", "${PLUGIN_ROOT}"],
    env: { DECLARED_BY_THE_AUTHOR: "yes", ROOTED: "${PLUGIN_ROOT}/inside" },
  });
  writeFileSync(
    pluginEnvFile(data, "demo"),
    "FROM_THE_ENV_FILE=s3cret\n# a comment\n",
  );
  process.env[MARKER] = "must not reach the child";
  process.env.TERM = "xterm-iva-test";
  t.after(() => {
    delete process.env[MARKER];
  });

  const proxy = await startMcpProxy({
    plugin: "demo",
    server: "echo",
    port: 0,
    token: TOKEN,
    dataDir: data,
    log: () => {},
  });
  t.after(() => proxy.close());

  const { client, close } = await connect(proxy);
  t.after(close);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["echo"],
  );

  const called = await client.callTool({ name: "echo", arguments: {} });
  const content = called.content as { type: string; text: string }[];
  assert.equal(content[0].type, "text");
  const child = JSON.parse(content[0].text) as {
    env: Record<string, string>;
    argv: string[];
    cwd: string;
  };

  const root = pluginRoot(data, "demo");
  const pluginData = pluginDataDir(data, "demo");
  // Клиент задаёт пути (спека §9.1), и они абсолютные.
  assert.equal(child.env.PLUGIN_ROOT, root);
  assert.equal(child.env.PLUGIN_DATA, pluginData);
  // Плейсхолдеры раскрыты один проход — и в args, и в env.
  assert.deepEqual(child.argv, ["--data", pluginData, "--root", root]);
  assert.equal(child.env.ROOTED, `${root}/inside`);
  assert.equal(child.env.DECLARED_BY_THE_AUTHOR, "yes");
  // Секреты приходят из `<name>.env`, и только оттуда.
  assert.equal(child.env.FROM_THE_ENV_FILE, "s3cret");
  // Изоляция: env прокси и агента ребёнку не достаётся, включая то, что SDK
  // наследует по умолчанию.
  assert.equal(child.env[MARKER], undefined);
  assert.equal(child.env.TERM, undefined);
  assert.equal(child.env.PATH, process.env.PATH);
  // macOS отдаёт cwd через /private: сравниваем разрешённые пути.
  assert.equal(child.cwd, realpathSync(root), "cwd defaults to PLUGIN_ROOT");
});

test("the declared cwd wins, expanded once", async (t) => {
  const data = world({ cwd: "${PLUGIN_DATA}" });
  const proxy = await startMcpProxy({
    plugin: "demo",
    server: "echo",
    port: 0,
    token: TOKEN,
    dataDir: data,
    log: () => {},
  });
  t.after(() => proxy.close());
  const { client, close } = await connect(proxy);
  t.after(close);
  const called = await client.callTool({ name: "echo", arguments: {} });
  const content = called.content as { type: string; text: string }[];
  const child = JSON.parse(content[0].text) as { cwd: string };
  assert.equal(child.cwd, realpathSync(pluginDataDir(data, "demo")));
});

test("a second client takes the session over, so a restarted agent needs no restart here", async (t) => {
  const data = world();
  const proxy = await startMcpProxy({
    plugin: "demo",
    server: "echo",
    port: 0,
    token: TOKEN,
    dataDir: data,
    log: () => {},
  });
  t.after(() => proxy.close());

  const first = await connect(proxy);
  assert.equal((await first.client.listTools()).tools.length, 1);
  // Агент перезапустился: старая сессия ушла, новая забирает того же ребёнка.
  await first.close();
  const second = await connect(proxy);
  t.after(second.close);
  assert.equal((await second.client.listTools()).tools.length, 1);
  const called = await second.client.callTool({ name: "echo", arguments: {} });
  assert.equal((called.content as { type: string }[])[0].type, "text");
});

test("without the right bearer there is no MCP, and /health needs none", async (t) => {
  const data = world();
  const proxy = await startMcpProxy({
    plugin: "demo",
    server: "echo",
    port: 0,
    token: TOKEN,
    dataDir: data,
    log: () => {},
  });
  t.after(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.port}${"/mcp"}`;
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "curl", version: "1" },
    },
  });
  const post = (headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: initialize,
    });

  const none = await post({});
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: "unauthorized" });
  const wrong = await post({ authorization: `Bearer ${TOKEN.slice(0, -1)}x` });
  assert.equal(wrong.status, 401);
  const shorter = await post({ authorization: "Bearer x" });
  assert.equal(shorter.status, 401);
  const right = await post({ authorization: `Bearer ${TOKEN}` });
  assert.equal(right.status, 200);

  const health = await fetch(`http://127.0.0.1:${proxy.port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const elsewhere = await fetch(`http://127.0.0.1:${proxy.port}/`);
  assert.equal(elsewhere.status, 404);
});

test("a plugin, a server or a transport that is not there refuses to start", async () => {
  const data = world();
  const spec = {
    plugin: "demo",
    server: "echo",
    port: 0,
    token: TOKEN,
    dataDir: data,
    log: () => {},
  };
  await assert.rejects(
    startMcpProxy({ ...spec, token: "" }),
    /refuses to run without a token/u,
  );
  await assert.rejects(
    startMcpProxy({ ...spec, plugin: "absent" }),
    /is not a usable plugin/u,
  );
  await assert.rejects(
    startMcpProxy({ ...spec, server: "other" }),
    /declares no MCP server "other"/u,
  );

  const remote = world();
  writeFileSync(
    join(pluginRoot(remote, "demo"), "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        echo: { type: "streamable-http", url: "https://api.test/mcp" },
      },
    }),
  );
  await assert.rejects(
    startMcpProxy({ ...spec, dataDir: remote }),
    /only stdio needs a proxy/u,
  );
});

test("the MCP server going away is reported instead of being served as a dead port", async (t) => {
  // Сервер уходит сам, как это делает упавший MCP-сервер в живой инсталляции.
  const data = world({ args: ["--exit-after-ms", "50"] });
  const proxy = await startMcpProxy({
    plugin: "demo",
    server: "echo",
    port: 0,
    token: TOKEN,
    dataDir: data,
    log: () => {},
  });
  t.after(() => proxy.close());
  // Прокси не решает, что делать: он сообщает, а решает systemd (`Restart=on-failure`).
  assert.match(await proxy.childGone, /^the MCP server echo exited$/u);
});
