import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { plantCliTree } from "../fixtures/cli-tree.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type AccountFixture = {
  readonly fakeBin: string;
  readonly home: string;
  readonly project: string;
};

async function createAccountFixture(t: TestContext): Promise<AccountFixture> {
  const dir = await mkdtemp(join(tmpdir(), "iva-cli-account-entrypoints-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  // Деревья CLI — общим списком (scripts/fixtures/cli-tree.ts), а не своим перечнем:
  // списком забывают новый пакет (T20: packages/secret-redaction). scripts/lib копией —
  // тест правит в нём codex-oauth.ts, ссылкой это правило бы тронуло сам репозиторий.
  // cli и lib — копиями: симлинк cli увёл бы относительный `../lib` в настоящий
  // репозиторий (Node резолвит символы ссылок), и правка codex-oauth.ts ниже не подействовала.
  await plantCliTree(ROOT, project, {
    copy: ["scripts/cli", "scripts/lib"],
  });
  await symlink(
    join(ROOT, "node_modules"),
    join(project, "node_modules"),
    "dir",
  );

  const fakeShell = join(fakeBin, "sh");
  await writeFile(fakeShell, "#!/bin/sh\nexit 0\n");
  await chmod(fakeShell, 0o755);

  await writeFile(
    join(project, "scripts/lib/codex-oauth.ts"),
    [
      "export async function listCodexModelCatalog() { return []; }",
      "export async function runDeviceCodeLogin(options = {}) {",
      "  options.log?.(`device:${options.lang}:${options.dataDir}`);",
      '  if (process.env.IVA_TEST_LOGIN === "fail-device") throw new Error("device boom");',
      '  return { planType: "pro", accountId: "account-1" };',
      "}",
      "export async function runBrowserLogin(options = {}) {",
      "  options.log?.(`browser:${options.lang}:${options.dataDir}`);",
      '  if (process.env.IVA_TEST_LOGIN === "fail-browser") throw new Error("browser boom");',
      "  return {};",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "iva", version: "9.8.7", type: "module" })}\n`,
  );
  await writeFile(
    join(project, ".env"),
    [
      "AGENT_LANGUAGE=RU",
      "ASSISTANT_DATA_DIR=data",
      "MODEL_PROVIDER=codex",
      "",
    ].join("\n"),
  );

  return { fakeBin, home, project };
}

function runCli(
  { fakeBin, home, project }: AccountFixture,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [join(project, "bin/iva.mjs"), ...args], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      HOME: home,
      NO_COLOR: "1",
      PATH: fakeBin,
      TERM: "dumb",
    },
  });
}

void test("uninstall cancellation leaves the command and purge targets untouched", async (t) => {
  const fixture = await createAccountFixture(t);
  const command = join(fixture.home, ".local/bin/iva");
  const vault = join(fixture.project, "vault");
  await mkdir(dirname(command), { recursive: true });
  await mkdir(vault);
  await writeFile(command, "kept\n");

  const result = runCli(fixture, ["uninstall", "--purge"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    result.stdout,
    [
      "! Uninstalling Iva: systemd units and the `iva` command will be removed.",
      "✗ --purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).",
      "Cancelled.",
      "",
    ].join("\n"),
  );
  assert.equal(result.stderr, "");
  assert.equal(await readFile(command, "utf8"), "kept\n");
  assert.equal(existsSync(join(fixture.project, "package.json")), true);
  assert.equal(existsSync(vault), true);
});

void test("version preserves metadata fallback and undefined-version output", async (t) => {
  const fixture = await createAccountFixture(t);

  let result = runCli(fixture, ["version"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "iva 9.8.7 · commit ? · updates stable\n");
  assert.equal(result.stderr, "");

  await writeFile(join(fixture.project, "package.json"), "{}\n");
  result = runCli(fixture, ["version"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "iva undefined · commit ? · updates stable\n");

  await rm(join(fixture.project, "package.json"));
  result = runCli(fixture, ["version"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "iva ? · commit ? · updates stable\n");
});

void test("usage tail preserves Number(args[1]) || 10 slicing quirks", async (t) => {
  const fixture = await createAccountFixture(t);
  const dataDir = join(await realpath(fixture.project), "data");
  await mkdir(dataDir);
  const entries = Array.from({ length: 12 }, (_, index) => ({ index }));
  await writeFile(
    join(dataDir, "usage.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  const tailTwo = runCli(fixture, ["usage", "tail", "2"]);
  assert.equal(tailTwo.status, 0, tailTwo.stderr || tailTwo.stdout);
  assert.equal(tailTwo.stdout, '{"index":10}\n{"index":11}\n');

  const zeroFallsBackToTen = runCli(fixture, ["usage", "tail", "0"]);
  assert.equal(
    zeroFallsBackToTen.stdout,
    `${entries
      .slice(-10)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );

  const negativeOneSlicesFromIndexOne = runCli(fixture, [
    "usage",
    "tail",
    "-1",
  ]);
  assert.equal(
    negativeOneSlicesFromIndexOne.stdout,
    `${entries
      .slice(1)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
});

void test("login selects the lazy flow and keeps its success and failure boundary", async (t) => {
  const fixture = await createAccountFixture(t);
  const dataDir = join(await realpath(fixture.project), "data");

  const device = runCli(fixture, ["login"]);
  assert.equal(device.status, 0, device.stderr || device.stdout);
  assert.equal(
    device.stdout,
    [
      "▸ OpenAI sign-in (device code)…",
      `device:ru:${dataDir}`,
      "✓ Signed in — plan: pro · account account-1",
      `Token stored: ${join(dataDir, "codex-auth.json")} (chmod 600)`,
      "",
    ].join("\n"),
  );
  assert.equal(device.stderr, "");

  const browserFailure = runCli(fixture, ["login", "--browser"], {
    IVA_TEST_LOGIN: "fail-browser",
  });
  assert.equal(
    browserFailure.status,
    1,
    browserFailure.stderr || browserFailure.stdout,
  );
  assert.equal(
    browserFailure.stdout,
    [
      "▸ OpenAI sign-in (browser)…",
      `browser:ru:${dataDir}`,
      "✗ Sign-in failed: browser boom",
      "",
    ].join("\n"),
  );
  assert.equal(browserFailure.stderr, "");
});
