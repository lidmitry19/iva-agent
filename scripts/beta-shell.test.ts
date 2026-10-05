/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration */
// beta.sh (ADR-0018) на поддельной установке 0.4.8: версия, current, data/active.json и зеркало
// repo; установленный `iva` — заглушка, которая записывает, что её позвали обновлять.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const BETA = fileURLToPath(new URL("../beta.sh", import.meta.url));
// IVA_TEST_FLIP: обновление «прошло» — активной становится эта версия (data/active.json).
const STUB = `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.IVA_TEST_HANDOFF, process.argv.slice(1).join(" ") + "\\n");
const flip = process.env.IVA_TEST_FLIP;
if (flip) writeFileSync(process.env.IVA_INSTALL_DIR + "/data/active.json", JSON.stringify({ version: flip }));
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const config = (repo: string, key: string) =>
  spawnSync("git", ["-C", repo, "config", "--local", "--get", key], {
    encoding: "utf8",
  }).stdout.trim();

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-beta-sh-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "iva");
  const handoff = join(dir, "handoff.log");
  const run = (env: Record<string, string> = {}) =>
    spawnSync("bash", [BETA], {
      encoding: "utf8",
      env: {
        ...process.env,
        IVA_INSTALL_DIR: home,
        IVA_TEST_HANDOFF: handoff,
        AGENT_LANGUAGE: "en",
        ...env,
      },
    });
  return { dir, home, handoff, run };
}

test("beta.sh on a 0.4.8 installation: branch beta and iva.beta in the mirror, then its own iva update", (t) => {
  const { dir, home, handoff, run } = fixture(t);
  const version = join(home, "versions", "0.4.8-0123456789ab");
  mkdirSync(join(version, "bin"), { recursive: true });
  mkdirSync(join(home, "data"));
  writeFileSync(join(version, "bin/iva.mjs"), STUB);
  symlinkSync(version, join(home, "current"));
  writeFileSync(
    join(home, "data/active.json"),
    '{"schema":"iva-active/v2","version":"0.4.8-0123456789ab"}\n',
  );
  git(dir, "init", "-q", "--bare", "-b", "main", join(home, "repo"));
  git(join(home, "repo"), "config", "iva.updateBranch", "main");

  const result = run({ IVA_TEST_FLIP: "0.4.11-beta.1-abcdef012345" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(config(join(home, "repo"), "iva.updateBranch"), "beta");
  assert.equal(config(join(home, "repo"), "iva.beta"), "true");
  assert.equal(
    readFileSync(handoff, "utf8"),
    `${home}/current/bin/iva.mjs update\n`,
  );
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
  assert.match(result.stdout, /beta/u);
  assert.match(result.stdout, /was main/u);
  assert.match(
    readFileSync(join(home, "data/active.json"), "utf8"),
    /0\.4\.11-beta\.1/u,
  );
});

test("beta.sh on a checkout: the checkout's git gets the setting, and a missing Iva is refused", (t) => {
  const { home, handoff, run } = fixture(t);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin/iva.mjs"), STUB);
  writeFileSync(join(home, "package.json"), '{"version":"0.4.11-beta.1"}\n');
  git(home, "init", "-q", "-b", "main");
  git(home, "config", "iva.updateBranch", "main");

  const result = run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(config(home, "iva.updateBranch"), "beta");
  assert.equal(config(home, "iva.beta"), "true");
  assert.equal(readFileSync(handoff, "utf8"), `${home}/bin/iva.mjs update\n`);

  rmSync(home, { recursive: true, force: true });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/u);
});

/** Установка 0.4.8 на версионной раскладке; current — по желанию (оборванное переключение). */
function versioned(fx: ReturnType<typeof fixture>, current = true) {
  const version = join(fx.home, "versions", "0.4.8-0123456789ab");
  mkdirSync(join(version, "bin"), { recursive: true });
  mkdirSync(join(fx.home, "data"));
  writeFileSync(join(version, "bin/iva.mjs"), STUB);
  if (current) symlinkSync(version, join(fx.home, "current"));
  writeFileSync(
    join(fx.home, "data/active.json"),
    '{"version":"0.4.8-0123456789ab"}\n',
  );
  git(fx.dir, "init", "-q", "--bare", "-b", "main", join(fx.home, "repo"));
  return version;
}

// Круг 2 (Sol 6): установка без current (оборванное переключение) — та же, что находит
// repair.sh: новейшая версия на диске.
test("beta.sh finds a versioned installation without current, like repair.sh", (t) => {
  const fx = fixture(t);
  const version = versioned(fx, false);
  const result = fx.run({ IVA_TEST_FLIP: "0.4.11-beta.1-abcdef012345" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(fx.handoff, "utf8"),
    `${version}/bin/iva.mjs update\n`,
  );
});

// Круг 2 (Sol 7): старый обновлятор без сети отвечает 0 и ничего не ставит — активная
// версия прежняя и это не бета-сборка: одна строка и ненулевой код.
test("beta.sh says the update did not go through when the active version stayed 0.4.8", (t) => {
  const fx = fixture(t);
  versioned(fx);
  const result = fx.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /did not go through.*iva update/u,
  );
});

// QA: ветка, на которой сидела установка (release/0.4.0 после iva rollback), названа.
test("beta.sh names the branch the installation was on", (t) => {
  const fx = fixture(t);
  versioned(fx);
  git(join(fx.home, "repo"), "config", "iva.updateBranch", "release/0.4.0");
  const result = fx.run({ IVA_TEST_FLIP: "0.4.11-beta.1-abcdef012345" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /was release\/0\.4\.0/u);
});
