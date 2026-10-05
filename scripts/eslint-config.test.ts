/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const EXPECTED_IGNORES = [
  ".output/",
  "node_modules/",
  "patches/",
  "assets/",
  "vault-template/",
  ".eve/",
  "services/telegram-userbot/",
  "data/",
  ".scratch/",
  ".worktrees/",
  ".claude/",
  "**/wt/",
  "**/.workflow-data/",
  "**/.iva-update/",
  "**/.iva-build/",
  "**/.output.iva-backup-*/",
  "**/.output.iva-install-backup-*/",
  "**/.output.iva-build-backup-*/",
];

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireNamedConfig(
  configs: unknown[],
  name: string,
): Record<string, unknown> {
  return requireRecord(
    configs.find((candidate) => isRecord(candidate) && candidate.name === name),
    `${name} config`,
  );
}

test("TypeScript config enforces type-only imports", () => {
  const configUrl = new URL("../tsconfig.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(configUrl, "utf8"));
  const config = requireRecord(parsed, "TypeScript config");
  const compilerOptions = requireRecord(
    config.compilerOptions,
    "TypeScript compiler options",
  );

  assert.equal(compilerOptions.verbatimModuleSyntax, true);
});

test("ESLint config preserves the migration lint policy", async () => {
  const configUrl = new URL("../eslint.config.ts", import.meta.url);
  const imported: unknown = await import(configUrl.href);
  const module = requireRecord(imported, "ESLint config module");

  assert.ok(
    Array.isArray(module.default),
    "default export must be a flat config",
  );
  const configs: unknown[] = module.default;

  const globalConfig = requireRecord(
    configs.find(
      (candidate) => isRecord(candidate) && Array.isArray(candidate.ignores),
    ),
    "global ignore config",
  );
  assert.deepEqual(globalConfig.ignores, EXPECTED_IGNORES);

  const javascriptConfig = requireNamedConfig(configs, "iva/javascript");
  assert.deepEqual(javascriptConfig.files, ["**/*.mjs"]);
  const javascriptLanguage = requireRecord(
    javascriptConfig.languageOptions,
    "JavaScript language options",
  );
  assert.equal(javascriptLanguage.ecmaVersion, "latest");
  assert.equal(javascriptLanguage.sourceType, "module");
  assert.equal(
    requireRecord(javascriptLanguage.globals, "Node globals").process,
    false,
  );

  const typescriptConfig = requireNamedConfig(configs, "iva/typescript");
  assert.deepEqual(typescriptConfig.files, ["**/*.{ts,mts}"]);
  const typescriptLanguage = requireRecord(
    typescriptConfig.languageOptions,
    "TypeScript language options",
  );
  const parserOptions = requireRecord(
    typescriptLanguage.parserOptions,
    "TypeScript parser options",
  );
  assert.equal(parserOptions.projectService, true);
  assert.equal(
    parserOptions.tsconfigRootDir,
    dirname(fileURLToPath(configUrl)),
  );

  const rules = requireRecord(typescriptConfig.rules, "TypeScript rules");
  assert.deepEqual(rules["no-restricted-syntax"], [
    "error",
    {
      selector: "TSEnumDeclaration",
      message:
        "Enums require TypeScript transformation and cannot run under Node.js type stripping.",
    },
    {
      selector: "TSModuleDeclaration",
      message:
        "Namespaces require TypeScript transformation and cannot run under Node.js type stripping.",
    },
    {
      selector: "TSParameterProperty",
      message:
        "Parameter properties require TypeScript transformation and cannot run under Node.js type stripping.",
    },
  ]);

  const prettierConfig = requireNamedConfig(configs, "config-prettier");
  assert.equal(requireRecord(prettierConfig.rules, "Prettier rules").curly, 0);
});

test("ESLint sees only canonical project trees", async () => {
  const eslint = new ESLint({
    cwd: ROOT,
    flags: ["unstable_native_nodejs_ts_config"],
  });

  for (const path of [
    "nested/wt/checkout/sentinel.test.ts",
    "nested/.workflow-data/sentinel.test.ts",
    "nested/.iva-update/checkout/sentinel.test.ts",
    "nested/.iva-build/checkout/sentinel.test.ts",
    "nested/.output.iva-backup-1/sentinel.test.ts",
    "nested/.output.iva-install-backup-1/sentinel.test.ts",
    "nested/.output.iva-build-backup-1/sentinel.test.ts",
  ]) {
    assert.equal(await eslint.isPathIgnored(join(ROOT, path)), true, path);
  }

  for (const path of [
    "scripts/wt-source/sentinel.ts",
    "scripts/.workflow-data-source/sentinel.ts",
    "scripts/.iva-update-source/sentinel.ts",
    "scripts/.iva-build-source/sentinel.ts",
    "scripts/.output-source/sentinel.ts",
    "scripts/.output.iva-source/sentinel.ts",
  ]) {
    assert.equal(await eslint.isPathIgnored(join(ROOT, path)), false, path);
  }
});
