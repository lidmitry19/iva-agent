/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Якоря ридера плагина: по одному на каждую границу отказа спеки Agent Plugins 1.0.0.
// Свойства на случайных деревьях и случайном JSON — в plugin-reader.property.test.ts.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  IVA_NAMESPACE,
  MAX_PLUGIN_DEPTH,
  MAX_PLUGIN_ENTRIES,
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  readPlugin,
} from "./plugin-reader.ts";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-reader-"));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    $schema: PLUGIN_SCHEMA_URL,
    name: "demo",
    ...extra,
  });
}

function skill(name = "demo"): string {
  return `---\nname: ${name}\ndescription: Do the ${name} work.\n---\n\nBody.\n`;
}

/** Минимальный валидный плагин: манифест + один скилл. */
function plugin(extra: Record<string, unknown> = {}): string {
  const dir = world();
  write(dir, "plugin.json", manifest(extra));
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  return dir;
}

test("a minimal plugin returns its manifest, its skills and no diagnostics", async () => {
  const dir = plugin({ version: "1.2.0", description: "Demo." });
  write(dir, "skills/alpha/references/notes.md", "# notes\n");

  const report = await readPlugin(dir);
  assert.equal(report.manifest?.name, "demo");
  assert.equal(report.manifest?.version, "1.2.0");
  assert.deepEqual(
    report.skills.map((entry) => entry.path),
    ["skills/alpha"],
  );
  assert.deepEqual(report.mcp, {});
  assert.equal(report.code, false);
  assert.deepEqual(report.diagnostics, []);
});

test("a missing plugin.json rejects the plugin instead of throwing", async () => {
  const dir = world();
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));

  const report = await readPlugin(dir);
  assert.equal(report.manifest, null);
  assert.deepEqual(report.skills, []);
  assert.match(report.diagnostics.join("\n"), /not an agent plugin/u);
});

test("a missing directory rejects the plugin instead of throwing", async () => {
  const report = await readPlugin(join(world(), "absent"));
  assert.equal(report.manifest, null);
  assert.match(report.diagnostics.join("\n"), /plugin root unreadable/u);
});

test("a plugin root that is a file is rejected", async () => {
  const dir = world();
  write(dir, "file", "x");

  const report = await readPlugin(join(dir, "file"));
  assert.equal(report.manifest, null);
  assert.match(
    report.diagnostics.join("\n"),
    /plugin root must be a regular directory/u,
  );
});

test("every fatal manifest violation rejects the whole plugin", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["not JSON", "{", /not valid JSON|Unexpected|JSON/u],
    ["not an object", "[]", /must be a JSON object/u],
    [
      "foreign $schema",
      JSON.stringify({ $schema: "https://example.test/x.json", name: "demo" }),
      /\$schema must be/u,
    ],
    ["no $schema", JSON.stringify({ name: "demo" }), /\$schema must be/u],
    [
      "no name",
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL }),
      /name must be a string/u,
    ],
    ["uppercase name", manifestWithName("Demo"), /name must be lowercase/u],
    ["leading hyphen", manifestWithName("-demo"), /name must be lowercase/u],
    ["double hyphen", manifestWithName("de--mo"), /name must not contain/u],
    ["double period", manifestWithName("de..mo"), /name must not contain/u],
    ["empty name", manifestWithName(""), /name must be 1-64/u],
    ["long name", manifestWithName("a".repeat(65)), /name must be 1-64/u],
    [
      "version is not a string",
      manifest({ version: 3 }),
      /version must be a string/u,
    ],
    [
      "keywords are not strings",
      manifest({ keywords: ["ok", 2] }),
      /keywords must be an array of strings/u,
    ],
    [
      "author is not an object",
      manifest({ author: "someone" }),
      /author must be an object/u,
    ],
    [
      "author has an unknown field",
      manifest({ author: { name: "a", twitter: "@a" } }),
      /author has unknown field/u,
    ],
    [
      "author field is not a string",
      manifest({ author: { name: 7 } }),
      /author\.name must be a string/u,
    ],
  ];

  for (const [label, contents, expected] of cases) {
    const dir = world();
    write(dir, "plugin.json", contents);
    write(dir, "skills/alpha/SKILL.md", skill("alpha"));

    const report = await readPlugin(dir);
    assert.equal(report.manifest, null, label);
    assert.deepEqual(report.skills, [], label);
    assert.deepEqual(report.mcp, {}, label);
    assert.match(report.diagnostics.join("\n"), expected, label);
  }

  function manifestWithName(name: string): string {
    return JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name });
  }
});

test("the two non-fatal violations are reported and the plugin still loads", async () => {
  const dir = plugin({ extensions: "nope", surprise: 1 });

  const report = await readPlugin(dir);
  assert.equal(report.manifest?.name, "demo");
  assert.deepEqual(
    report.skills.map((entry) => entry.name),
    ["alpha"],
  );
  assert.deepEqual(report.diagnostics, [
    "plugin.json: extensions is not an object; ignored",
    'plugin.json: unknown field "surprise" ignored',
  ]);
});

test("a foreign extension namespace is kept and never validated", async () => {
  const dir = plugin({ extensions: { "com.example.client": { setting: 1 } } });

  const report = await readPlugin(dir);
  assert.deepEqual(report.manifest?.extensions, {
    "com.example.client": { setting: 1 },
  });
  assert.equal(report.code, false);
  assert.deepEqual(report.diagnostics, []);
});

test("our own namespace must be an object; a foreign one is never inspected", async () => {
  const dir = plugin({
    extensions: { [IVA_NAMESPACE]: "yes", "com.example.client": 7 },
  });

  const report = await readPlugin(dir);
  assert.deepEqual(report.diagnostics, [
    'plugin.json: extensions["sh.iva"] is not an object; ignored',
  ]);
  assert.equal(report.code, false, "an unusable payload is not code");
  assert.deepEqual(report.manifest?.extensions, { "com.example.client": 7 });
});

test("code is the sh.iva package manifest, and only with the namespace declared", async () => {
  // Заявка без папки — не код: собирать нечего (ADR-0009).
  const declaredOnly = plugin({ extensions: { [IVA_NAMESPACE]: {} } });
  assert.equal((await readPlugin(declaredOnly)).code, false);

  // Папка без заявки игнорируется целиком, и об этом говорится вслух.
  const undeclared = plugin();
  write(undeclared, `${IVA_NAMESPACE}/package.json`, "{}\n");
  const silent = await readPlugin(undeclared);
  assert.equal(silent.code, false);
  assert.deepEqual(silent.diagnostics, [
    'sh.iva/: ignored: plugin.json does not declare extensions["sh.iva"]',
  ]);

  // Заявка плюс `sh.iva/package.json` — это eve Extension.
  const withCode = plugin({ extensions: { [IVA_NAMESPACE]: {} } });
  write(withCode, `${IVA_NAMESPACE}/index.ts`, "export {};\n");
  assert.equal(
    (await readPlugin(withCode)).code,
    false,
    "a file is not a package",
  );
  write(withCode, `${IVA_NAMESPACE}/package.json`, "{}\n");
  const code = await readPlugin(withCode);
  assert.equal(code.code, true);
  assert.deepEqual(code.diagnostics, []);
});

test("services are read from sh.iva/services, one folder at a time", async () => {
  const dir = plugin({ extensions: { [IVA_NAMESPACE]: {} } });
  write(
    dir,
    `${IVA_NAMESPACE}/services/viewer/service.json`,
    JSON.stringify({
      command: "node",
      args: ["server.mjs", "${PLUGIN_DATA}/trace"],
      port: 8726,
    }),
  );
  // Битое объявление не валит соседей — оно называется и пропускается.
  write(
    dir,
    `${IVA_NAMESPACE}/services/broken/service.json`,
    '{"command":"node","port":80}',
  );
  write(dir, `${IVA_NAMESPACE}/services/nothing/README.md`, "no service\n");

  const report = await readPlugin(dir);
  // Сервисы — не Extension: версия из-за них не пересобирается.
  assert.equal(report.code, false);
  assert.deepEqual(report.services, {
    viewer: {
      command: "node",
      args: ["server.mjs", "${PLUGIN_DATA}/trace"],
      port: 8726,
    },
  });
  assert.deepEqual(report.diagnostics, [
    "sh.iva/services/broken: skipped: port must be an integer between 1024 and 65535",
    "sh.iva/services/nothing: skipped: no service.json",
  ]);
});

test("a service command is one token, resolved inside the service folder", async () => {
  const dir = plugin({ extensions: { [IVA_NAMESPACE]: {} } });
  const declare = (svc: string, raw: unknown): void =>
    write(
      dir,
      `${IVA_NAMESPACE}/services/${svc}/service.json`,
      JSON.stringify(raw),
    );
  declare("shell", { command: "node server.mjs", port: 8726 });
  declare("escape", { command: "./../../serve.mjs", port: 8726 });
  declare("option", { command: "-rf", port: 8726 });
  declare("extra", { command: "node", port: 8726, restart: "always" });
  declare("own", { command: "./serve.mjs", args: ["--quiet"], port: 8726 });
  write(dir, `${IVA_NAMESPACE}/services/own/serve.mjs`, "// server\n");

  const report = await readPlugin(dir);
  assert.deepEqual(Object.keys(report.services), ["own"]);
  assert.deepEqual(report.diagnostics, [
    "sh.iva/services/escape: skipped: command escapes the plugin root",
    'sh.iva/services/extra: skipped: unknown field "restart"',
    "sh.iva/services/option: skipped: command must not start with a dash",
    "sh.iva/services/shell: skipped: command must be a single token",
  ]);
});

test("skills that is not a directory disables only the skills component", async () => {
  const dir = world();
  write(dir, "plugin.json", manifest());
  write(dir, "skills", "not a directory\n");
  write(
    dir,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        api: { type: "streamable-http", url: "https://a.test/mcp" },
      },
    }),
  );

  const report = await readPlugin(dir);
  assert.equal(report.manifest?.name, "demo");
  assert.deepEqual(report.skills, []);
  assert.deepEqual(Object.keys(report.mcp), ["api"]);
  assert.deepEqual(report.diagnostics, [
    "skills: not a directory; skills component skipped",
  ]);
});

test("a missing skills directory is not an error", async () => {
  const dir = world();
  write(dir, "plugin.json", manifest());

  const report = await readPlugin(dir);
  assert.deepEqual(report.skills, []);
  assert.deepEqual(report.diagnostics, []);
});

test("a broken skill is skipped and its siblings still load", async () => {
  const dir = world();
  write(dir, "plugin.json", manifest());
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  write(dir, "skills/beta/notes.md", "no SKILL.md here\n");
  write(dir, "skills/gamma/SKILL.md", "no frontmatter at all\n");
  write(dir, "skills/delta/SKILL.md", "---\nname: delta\n---\n\nbody\n");
  write(dir, "skills/stray.md", "a file is not a skill\n");
  write(dir, "skills/nested/deep/SKILL.md", skill("deep"));

  const report = await readPlugin(dir);
  assert.deepEqual(
    report.skills.map((entry) => entry.name),
    ["alpha"],
  );
  assert.deepEqual(report.diagnostics, [
    "skills/beta: skipped: no SKILL.md",
    'skills/delta: skipped: SKILL.md frontmatter is missing "description"',
    "skills/gamma: skipped: SKILL.md has no frontmatter",
    "skills/nested: skipped: no SKILL.md",
  ]);
});

test("a skill name eve would refuse is skipped, not returned", async () => {
  const dir = world();
  write(dir, "plugin.json", manifest());
  write(dir, "skills/привет/SKILL.md", skill("hi"));
  write(dir, "skills/ok/SKILL.md", skill("ok"));

  const report = await readPlugin(dir);
  assert.deepEqual(
    report.skills.map((entry) => entry.name),
    ["ok"],
  );
  assert.match(report.diagnostics.join("\n"), /skills\/привет: skipped: name/u);
});

test("a SKILL.md that is not a regular file skips only that skill", async () => {
  const dir = world();
  write(dir, "plugin.json", manifest());
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  write(dir, "skills/beta/SKILL.md/inside.txt", "SKILL.md is a directory\n");

  const report = await readPlugin(dir);
  assert.deepEqual(
    report.skills.map((entry) => entry.name),
    ["alpha"],
  );
  assert.deepEqual(report.diagnostics, [
    "skills/beta: skipped: SKILL.md is not a regular file",
  ]);
});

test("a symlinked SKILL.md rejects the plugin: we allow no symlink at all", async () => {
  const outside = world();
  write(outside, "SKILL.md", skill("outside"));

  const dir = world();
  write(dir, "plugin.json", manifest());
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  mkdirSync(join(dir, "skills/beta"), { recursive: true });
  symlinkSync(join(outside, "SKILL.md"), join(dir, "skills/beta/SKILL.md"));

  const report = await readPlugin(dir);
  assert.equal(report.manifest, null);
  assert.match(
    report.diagnostics.join("\n"),
    /skills\/beta\/SKILL\.md is a symlink/u,
  );
});

test("a symlinked skill directory is rejected by the containment walk", async () => {
  const outside = world();
  write(outside, "SKILL.md", skill("outside"));

  const dir = world();
  write(dir, "plugin.json", manifest());
  symlinkSync(outside, join(dir, "skills"));

  const report = await readPlugin(dir);
  assert.equal(report.manifest, null);
  assert.match(report.diagnostics.join("\n"), /skills is a symlink/u);
});

test("the depth, entry and size caps each reject the plugin", async () => {
  const deep = world();
  write(deep, "plugin.json", manifest());
  write(
    deep,
    `${Array.from({ length: MAX_PLUGIN_DEPTH + 1 }, (_, index) => `d${index}`).join("/")}/file.txt`,
    "x",
  );
  assert.match(
    (await readPlugin(deep)).diagnostics.join("\n"),
    new RegExp(`deeper than ${MAX_PLUGIN_DEPTH} levels`, "u"),
  );

  const many = world();
  write(many, "plugin.json", manifest());
  mkdirSync(join(many, "bulk"), { recursive: true });
  for (let index = 0; index <= MAX_PLUGIN_ENTRIES; index++)
    writeFileSync(join(many, "bulk", `f${index}`), "");
  assert.match(
    (await readPlugin(many)).diagnostics.join("\n"),
    new RegExp(`more than ${MAX_PLUGIN_ENTRIES} entries`, "u"),
  );

  const huge = world();
  write(huge, "plugin.json", manifest());
  const handle = openSync(join(huge, "big.bin"), "w");
  // Разреженный файл: потолок про заявленный размер, а не про занятые блоки.
  ftruncateSync(handle, 51 * 1024 * 1024);
  closeSync(handle);
  assert.match(
    (await readPlugin(huge)).diagnostics.join("\n"),
    /total size exceeds/u,
  );
});

test("a .git checkout in the plugin folder is not plugin content", async () => {
  const dir = plugin();
  // Симлинк внутри .git отверг бы плагин, если бы обход туда заходил.
  mkdirSync(join(dir, ".git/objects"), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  symlinkSync("/etc/hosts", join(dir, ".git/link"));

  const report = await readPlugin(dir);
  assert.equal(report.manifest?.name, "demo");
  assert.deepEqual(report.diagnostics, []);
});

test("a broken mcp.json disables MCP and still returns the skills", async () => {
  const cases: Array<[string, RegExp]> = [
    ["{", /not valid JSON/u],
    ["[]", /not a JSON object/u],
    [JSON.stringify({ mcpServers: {} }), /\$schema must be/u],
    [
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, mcpServers: {} }),
      /\$schema must be/u,
    ],
    [
      JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: {}, extra: 1 }),
      /allows exactly \$schema and mcpServers/u,
    ],
    [
      JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: [] }),
      /mcpServers must be an object/u,
    ],
  ];

  for (const [contents, expected] of cases) {
    const dir = plugin();
    write(dir, "mcp.json", contents);

    const report = await readPlugin(dir);
    assert.equal(report.manifest?.name, "demo", contents);
    assert.deepEqual(
      report.skills.map((entry) => entry.name),
      ["alpha"],
      contents,
    );
    assert.deepEqual(report.mcp, {}, contents);
    assert.match(report.diagnostics.join("\n"), expected, contents);
  }
});

test("an mcp.json version that differs from the manifest disables MCP", async () => {
  const dir = plugin();
  write(
    dir,
    "mcp.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
      mcpServers: {},
    }),
  );

  const report = await readPlugin(dir);
  assert.equal(report.manifest?.name, "demo");
  assert.deepEqual(report.mcp, {});
  assert.match(report.diagnostics.join("\n"), /mcp\.json: \$schema must be/u);
});

test("valid mcp entries are accepted across all three transports", async () => {
  const dir = plugin();
  write(
    dir,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        local: {
          type: "stdio",
          command: "./bin/server",
          args: ["--data", "${PLUGIN_DATA}/db"],
          env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
          cwd: "${PLUGIN_ROOT}",
        },
        bare: { type: "stdio", command: "npx" },
        remote: {
          type: "streamable-http",
          url: "https://deploy.example.test/mcp",
          headers: { "X-Tenant": "public" },
        },
        loopback: { type: "stdio", command: "node", cwd: "./tools" },
        legacy: { type: "sse", url: "https://legacy.example.test/sse" },
        plain: { type: "streamable-http", url: "http://localhost:8723/mcp" },
      },
    }),
  );
  write(dir, "bin/server", "#!/bin/sh\n");
  write(dir, "tools/keep", "");

  const report = await readPlugin(dir);
  assert.deepEqual(Object.keys(report.mcp).sort(), [
    "bare",
    "legacy",
    "local",
    "loopback",
    "plain",
    "remote",
  ]);
  assert.deepEqual(report.diagnostics, []);
  const local = report.mcp.local;
  assert.equal(local.type, "stdio");
  assert.deepEqual(local.type === "stdio" ? local.args : [], [
    "--data",
    "${PLUGIN_DATA}/db",
  ]);
});

test("an invalid mcp entry is skipped and its siblings still load", async () => {
  const bad: Record<string, unknown> = {
    notObject: "server",
    noType: { command: "node" },
    unknownType: { type: "grpc", url: "https://a.test" },
    foreignField: { type: "stdio", command: "node", url: "https://a.test" },
    shellCommand: { type: "stdio", command: "node server.js" },
    placeholderCommand: { type: "stdio", command: "${PLUGIN_ROOT}/bin/x" },
    absoluteCommand: { type: "stdio", command: "/usr/bin/node" },
    escapingCommand: { type: "stdio", command: "./../../bin/x" },
    dashCommand: { type: "stdio", command: "--upload-pack=touch" },
    rootCommand: { type: "stdio", command: "./bin/.." },
    dotCommand: { type: "stdio", command: ".." },
    reservedEnv: {
      type: "stdio",
      command: "node",
      env: { PLUGIN_ROOT: "/tmp" },
    },
    escapingCwd: { type: "stdio", command: "node", cwd: "./../outside" },
    escapingDataCwd: {
      type: "stdio",
      command: "node",
      cwd: "${PLUGIN_DATA}/../../etc",
    },
    bareCwd: { type: "stdio", command: "node", cwd: "tools" },
    remoteHttp: { type: "streamable-http", url: "http://example.test/mcp" },
    urlWithUser: {
      type: "streamable-http",
      url: "https://user:pass@example.test/mcp",
    },
    urlWithFragment: {
      type: "streamable-http",
      url: "https://example.test/mcp#frag",
    },
    repeatedHeader: {
      type: "streamable-http",
      url: "https://example.test/mcp",
      headers: { "X-A": "1", "x-a": "2" },
    },
  };
  const dir = plugin();
  write(
    dir,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { ...bad, good: { type: "stdio", command: "node" } },
    }),
  );

  const report = await readPlugin(dir);
  assert.deepEqual(Object.keys(report.mcp), ["good"]);
  assert.equal(report.diagnostics.length, Object.keys(bad).length);
  for (const name of Object.keys(bad))
    assert.match(
      report.diagnostics.join("\n"),
      new RegExp(`server "${name}" skipped`, "u"),
    );
  assert.deepEqual(
    report.skills.map((entry) => entry.name),
    ["alpha"],
  );
});
