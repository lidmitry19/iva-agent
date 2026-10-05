import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  OPENCODE_PROTOCOLS,
  resolveOpenCodeProtocol,
} from "@iva/opencode-protocol";
import { resolveModelProvider } from "./model-provider.ts";

void test("Go protocol defaults preserve older installations and remain explicit", () => {
  assert.equal(resolveOpenCodeProtocol(undefined), "chat-completions");
  for (const protocol of OPENCODE_PROTOCOLS) {
    assert.equal(resolveOpenCodeProtocol(protocol), protocol);
    assert.equal(
      resolveModelProvider({
        MODEL_PROVIDER: "opencode",
        OPENCODE_PROTOCOL: protocol,
      }).compatibleReasoning,
      protocol === "chat-completions",
    );
  }
});

void test("property: only exact documented protocols pass; neighbours ignore the setting", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      if ((OPENCODE_PROTOCOLS as readonly string[]).includes(raw))
        assert.equal(resolveOpenCodeProtocol(raw), raw);
      else {
        assert.throws(
          () => resolveOpenCodeProtocol(raw),
          /Invalid OPENCODE_PROTOCOL/,
        );
        assert.throws(
          () =>
            resolveModelProvider({
              MODEL_PROVIDER: "opencode",
              OPENCODE_PROTOCOL: raw,
            }),
          /Invalid OPENCODE_PROTOCOL/,
        );
      }
      assert.equal(
        resolveModelProvider({
          MODEL_PROVIDER: "ollama",
          OPENCODE_PROTOCOL: raw,
        }).name,
        "ollama",
      );
    }),
    { seed: 20261002, numRuns: 100 },
  );
});

void test("invalid vision protocol names its own repair setting", () => {
  assert.throws(
    () => resolveOpenCodeProtocol("messages", "OPENCODE_VISION_PROTOCOL"),
    /Invalid OPENCODE_VISION_PROTOCOL.*\/messages is unsupported/,
  );
});
