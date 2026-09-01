/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

type ErrorClassifierModule = {
  classifyModelCallError(error: unknown): string;
};

function isErrorClassifierModule(
  value: unknown,
): value is ErrorClassifierModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "classifyModelCallError" in value &&
    typeof value.classifyModelCallError === "function"
  );
}

const errorModule: unknown = await import(
  pathToFileURL(
    join(
      process.cwd(),
      "node_modules/eve/dist/src/harness/model-call-error.js",
    ),
  ).href
);
assert.ok(isErrorClassifierModule(errorModule));

test("deterministic AI SDK prompt and tool errors terminate the Eve session", () => {
  for (const name of [
    "AI_InvalidPromptError",
    "AI_InvalidArgumentError",
    "AI_TypeValidationError",
    "AI_NoSuchToolError",
    "AI_InvalidToolInputError",
    "AI_UnsupportedFunctionalityError",
  ]) {
    const error = Object.assign(new Error("deterministic request error"), {
      name,
    });
    assert.equal(errorModule.classifyModelCallError(error), "terminal", name);
  }
});

test("deterministic classification follows nested causes", () => {
  const cause = Object.assign(new Error("unknown tool"), {
    name: "AI_NoSuchToolError",
  });
  assert.equal(
    errorModule.classifyModelCallError(
      new Error("model call failed", { cause }),
    ),
    "terminal",
  );
});

test("retryable errors with deterministic-name prefixes remain retryable", () => {
  const error = Object.assign(new Error("prompt timed out"), {
    name: "AI_InvalidPromptTimeoutError",
    isRetryable: true,
  });
  assert.equal(errorModule.classifyModelCallError(error), "retry");
});
