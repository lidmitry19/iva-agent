// Ошибка utimes при живом owner-файле (T95, раунд 4): сердцебиение не гаснет, пишет одну
// строку stderr и после ошибки снова освежает каталог. Запуск:
// node --experimental-test-module-mocks scripts/fixtures/lock-heartbeat-utimes.ts <dir> <code>...
// Печатает JSON по каждому коду: сколько касаний упало, сколько прошло после, возраст
// каталога, взял ли лок претендент, строки stderr про сердцебиение.
import * as realFs from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";

const real = { ...realFs };
const used = [
  "closeSync",
  "fchmodSync",
  "fstatSync",
  "fsyncSync",
  "lstatSync",
  "mkdirSync",
  "openSync",
  "realpathSync",
  "readdirSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "writeFileSync",
] as const;

let inject: string | undefined;
let touches = 0;
mock.module("node:fs", {
  namedExports: {
    ...Object.fromEntries(used.map((name) => [name, real[name]])),
    utimesSync: (...args: Parameters<typeof realFs.utimesSync>) => {
      touches += 1;
      if (inject) {
        const error = new Error(`${inject}: injected`) as NodeJS.ErrnoException;
        error.code = inject;
        throw error;
      }
      return real.utimesSync(...args);
    },
  },
});
const { acquireFileLock, releaseFileLock } =
  await import("../../agent/lib/fs-atomic.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stderr: string[] = [];
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk: unknown) => {
  stderr.push(String(chunk));
  return true;
};

const [dir = ".", ...codes] = process.argv.slice(2);
const result: Record<string, unknown> = {};
for (const code of codes) {
  const lock = join(dir, `${code}.lock`);
  const held = await acquireFileLock(lock, { staleMs: 300 });
  if (!held) throw new Error(`no lock for ${code}`);
  const before = stderr.length;
  inject = code;
  const first = touches;
  await sleep(450);
  const failed = touches - first;
  inject = undefined;
  const second = touches;
  await sleep(350);
  const after = touches - second;
  const age = Date.now() - real.statSync(lock).mtimeMs;
  const contender = await acquireFileLock(lock, {
    staleMs: 300,
    timeoutMs: 50,
  });
  if (contender) releaseFileLock(contender);
  releaseFileLock(held);
  result[code] = {
    failed,
    after,
    age,
    contenderHeld: contender !== null,
    lines: stderr.slice(before).filter((line) => line.includes("heartbeat")),
  };
}
process.stderr.write = write;
console.log(JSON.stringify(result));
