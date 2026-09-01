import assert from "node:assert/strict";
import test from "node:test";

import { assertTargetKeepsLocalHistory } from "./version-update-command.ts";

type Relation = "head-contains-target" | "target-contains-head" | "diverged";

function gitFor(relation: Relation) {
  return (_root: string, args: readonly string[]) => {
    assert.deepEqual(args.slice(0, 2), ["merge-base", "--is-ancestor"]);
    const left = args[2];
    const right = args[3];
    const ancestor =
      (relation === "target-contains-head" &&
        left === "HEAD" &&
        right === "target") ||
      (relation === "head-contains-target" &&
        left === "target" &&
        right === "HEAD");
    return Promise.resolve({
      code: ancestor ? 0 : 1,
      stdout: "",
      stderr: "",
    });
  };
}

void test("official target may advance or already be integrated", async () => {
  await assertTargetKeepsLocalHistory(
    "/repo",
    "target",
    gitFor("target-contains-head"),
  );
  await assertTargetKeepsLocalHistory(
    "/repo",
    "target",
    gitFor("head-contains-target"),
  );
});

void test("a divergent official target cannot discard custom integration commits", async () => {
  await assert.rejects(
    assertTargetKeepsLocalHistory("/repo", "target", gitFor("diverged")),
    /merge the official release into the custom branch/u,
  );
});
