import assert from "node:assert/strict";
import test from "node:test";

import { isExternalUsageLimit } from "./provider-limit.ts";

void test("provider usage limits are terminal and distinct from session limits", () => {
  assert.equal(
    isExternalUsageLimit(Object.assign(new Error("5-hour usage limit reached"), {
      code: "usage_limit_reached",
    })),
    true,
  );
  assert.equal(isExternalUsageLimit(new Error("usage limit reached")), true);
  assert.equal(
    isExternalUsageLimit(Object.assign(new Error("session limit"), {
      code: "BACKGROUND_SESSION_LIMIT_UPGRADE_REQUIRED",
    })),
    false,
  );
  assert.equal(isExternalUsageLimit(new Error("network unavailable")), false);
});