/* eslint-disable @typescript-eslint/no-floating-promises -- Node registers top-level tests synchronously. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  git,
  recoveryFixture as fixture,
  wrappedRecoveryTransaction as wrappedTransaction,
} from "../fixtures/update-recovery.ts";

function gitHex(cwd: string, ...args: string[]): string {
  return Buffer.from(execFileSync("git", args, { cwd })).toString("hex");
}

test("guard creation cleans ambiguous writes and deceptive delete outcomes", async (t) => {
  const cases = [
    {
      name: "write reports failure after creating the ref",
      cleanupFault: "",
      verificationFault: "",
      writeFault: true,
    },
    {
      name: "first cleanup delete fails",
      cleanupFault:
        "  printf '%s\\n' 'injected guard cleanup failure' >&2\n" +
        "  exit 92\n",
      verificationFault: "",
      writeFault: false,
    },
    {
      name: "first cleanup delete reports false success",
      cleanupFault: "  exit 0\n",
      verificationFault: "",
      writeFault: false,
    },
    {
      name: "cleanup verification fails silently",
      cleanupFault: "  exit 0\n",
      verificationFault: "  exit 92\n",
      writeFault: false,
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fx = fixture();
      t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
      const guardFault = join(fx.temp, "guard-fault");
      const cleanupFault = join(fx.temp, "cleanup-fault");
      const before = gitHex(
        fx.local,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      );
      const tx = wrappedTransaction(
        fx,
        (entry.writeFault
          ? `if [ "$1" = update-ref ] && [ "$#" -eq 3 ] && [ ! -f ${JSON.stringify(guardFault)} ]; then\n` +
            '  __REAL_GIT__ "$@"\n' +
            `  : > ${JSON.stringify(guardFault)}\n` +
            "  printf '%s\\n' 'injected guard write failure' >&2\n" +
            "  exit 91\n" +
            "fi\n"
          : `if [ "$1" = rev-parse ] && [ "$2" = --verify ] && printf '%s' "$3" | grep -q '^refs/iva/update-recovery/' && [ ! -f ${JSON.stringify(guardFault)} ]; then\n` +
            `  : > ${JSON.stringify(guardFault)}\n` +
            "  printf '%s\\n' 'injected guard verification failure' >&2\n" +
            "  exit 91\n" +
            "fi\n") +
          (entry.cleanupFault
            ? `if [ "$1" = update-ref ] && [ "$2" = -d ] && [ ! -f ${JSON.stringify(cleanupFault)} ]; then\n` +
              `  : > ${JSON.stringify(cleanupFault)}\n` +
              entry.cleanupFault +
              "fi\n"
            : "") +
          (entry.verificationFault
            ? `if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = --quiet ] && [ ! -f ${JSON.stringify(cleanupFault)}.verify ]; then\n` +
              `  : > ${JSON.stringify(cleanupFault)}.verify\n` +
              entry.verificationFault +
              "fi\n"
            : ""),
      );

      await assert.rejects(() => tx.protect(), /injected guard/u);
      await tx.rollback();

      assert.equal(
        git(
          fx.local,
          "for-each-ref",
          "--format=%(refname)",
          "refs/iva/update-recovery",
        ),
        "",
      );
      assert.equal(
        gitHex(
          fx.local,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ),
        before,
      );
    });
  }
});

test("guard cleanup never deletes a recovery ref that changed ownership", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const head = git(fx.local, "rev-parse", "HEAD");
  const tree = git(fx.local, "rev-parse", "HEAD^{tree}");
  const foreign = git(
    fx.local,
    "commit-tree",
    tree,
    "-p",
    head,
    "-m",
    "foreign recovery owner",
  );
  const fault = join(fx.temp, "guard-ownership-fault");
  const tx = wrappedTransaction(
    fx,
    `if [ "$1" = rev-parse ] && [ "$2" = --verify ] && printf '%s' "$3" | grep -q '^refs/iva/update-recovery/' && [ ! -f ${JSON.stringify(fault)} ]; then\n` +
      `  ref=$(__REAL_GIT__ for-each-ref --format='%(refname)' refs/iva/update-recovery)\n` +
      `  __REAL_GIT__ update-ref "$ref" ${JSON.stringify(foreign)} ${JSON.stringify(head)}\n` +
      `  : > ${JSON.stringify(fault)}\n` +
      "  printf '%s\\n' 'injected guard ownership change' >&2\n" +
      "  exit 93\n" +
      "fi\n",
  );

  await assert.rejects(
    () => tx.protect(),
    /recovery guard verification and cleanup failed/u,
  );

  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    foreign,
  );
});
