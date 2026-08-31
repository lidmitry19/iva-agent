import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

void test("every IVA systemd ExecStart target exists and Bitrix uses the package CLI", () => {
  for (const name of readdirSync(join(ROOT, "deploy")).filter((x) => x.endsWith(".service"))) {
    const source = readFileSync(join(ROOT, "deploy", name), "utf8");
    const exec = source.split("\n").filter((line) => line.startsWith("ExecStart=")).join("\n");
    for (const match of exec.matchAll(/(?:scripts\/[^\s]+|bin\/iva\.mjs)/gu)) {
      assert.equal(existsSync(join(ROOT, match[0])), true, `${name}: ${match[0]}`);
    }
  }
  const bitrix = readFileSync(join(ROOT, "deploy", "iva-bitrix-sync.service"), "utf8");
  assert.match(bitrix, /bin\/iva\.mjs bitrix sync --daily/u);
  assert.doesNotMatch(bitrix.split("\n").find((line: string) => line.startsWith("ExecStart=")) ?? "", /scripts\/bitrix-sync\.ts/u);
});
