import assert from "node:assert/strict";
import test from "node:test";
import { createCliMain, dispatchCli, type CliCommand } from "./main.ts";

class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const exit = (code: number): never => {
  throw new ExitSignal(code);
};

void test("dispatch passes the untouched argument tail to the selected command", async () => {
  const seen: string[][] = [];
  const commands: Record<string, CliCommand> = {
    selected: (args) => {
      seen.push([...args]);
      return "done";
    },
  };

  const result = await dispatchCli(["selected", "--flag", "value"], commands, {
    bad: assert.fail,
    help: assert.fail,
    exit,
  });

  assert.equal(result, "done");
  assert.deepEqual(seen, [["--flag", "value"]]);
});

void test("missing and unknown commands preserve help, diagnostics, and exit codes", () => {
  for (const { argv, expected } of [
    { argv: [] as string[], expected: ["help", "exit:0"] },
    {
      argv: ["unknown", "tail"],
      expected: ["bad:Unknown command: unknown", "help", "exit:1"],
    },
  ]) {
    const events: string[] = [];
    assert.throws(
      () =>
        dispatchCli(
          argv,
          {},
          {
            bad: (message) => events.push(`bad:${message}`),
            help: () => events.push("help"),
            exit: (code): never => {
              events.push(`exit:${code}`);
              throw new ExitSignal(code);
            },
          },
        ),
      ExitSignal,
    );
    assert.deepEqual(events, expected);
  }
});

void test("command help flags show help without executing the command", () => {
  for (const flag of ["--help", "-h"]) {
    const events: string[] = [];
    const commands: Record<string, CliCommand> = {
      rollback: () => events.push("command"),
    };

    assert.throws(
      () =>
        dispatchCli(["rollback", flag], commands, {
          bad: assert.fail,
          help: () => events.push("help"),
          exit: (code): never => {
            events.push(`exit:${code}`);
            throw new ExitSignal(code);
          },
        }),
      (error: unknown) => error instanceof ExitSignal && error.code === 0,
    );
    assert.deepEqual(events, ["help", "exit:0"]);
  }
});

void test("sync throws escape before Promise.resolve while async rejections use the legacy catch", async () => {
  const marker = Symbol("sync failure");
  const syncCommands: Record<string, CliCommand> = {
    sync: () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- preserve arbitrary legacy JavaScript failures
      throw marker;
    },
  };
  try {
    void dispatchCli(["sync"], syncCommands, {
      bad: assert.fail,
      help: assert.fail,
      exit,
    });
    assert.fail("expected synchronous failure");
  } catch (error) {
    assert.equal(error, marker);
  }

  const events: string[] = [];
  const asyncCommands: Record<string, CliCommand> = {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve a non-Error JavaScript rejection
    async: () => Promise.reject({ message: "async failure" }),
  };
  await assert.rejects(
    dispatchCli(["async"], asyncCommands, {
      bad: (message) => events.push(`bad:${message}`),
      help: assert.fail,
      exit: (code): never => {
        events.push(`exit:${code}`);
        throw new ExitSignal(code);
      },
    }),
    ExitSignal,
  );
  assert.deepEqual(events, ["bad:async failure", "exit:1"]);
});

void test("a Symbol-valued rejection message keeps the legacy logger interpolation failure", async () => {
  const commands: Record<string, CliCommand> = {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve the legacy Symbol message boundary
    async: () => Promise.reject({ message: Symbol("message") }),
  };
  let exited = false;

  await assert.rejects(
    dispatchCli(["async"], commands, {
      bad: (message) => {
        void `${message}`;
      },
      help: assert.fail,
      exit: (): never => {
        exited = true;
        throw new ExitSignal(1);
      },
    }),
    TypeError,
  );
  assert.equal(exited, false);
});

void test("main composition exposes the exact legacy command key set without executing a command", () => {
  const cli = createCliMain("/tmp/iva-main-test");

  assert.deepEqual(Object.keys(cli.commands), [
    "update",
    "rollback",
    "userbot",
    "config",
    "login",
    "doctor",
    "plugin",
    "trace",
    "status",
    "restart",
    "reset",
    "usage",
    "notify",
    "remind",
    "post",
    "start",
    "stop",
    "logs",
    "uninstall",
    "version",
    "tree",
    "help",
    "--help",
    "-h",
    "_install-units",
    "_activate-units",
    "_await-healthy",
  ]);
});
