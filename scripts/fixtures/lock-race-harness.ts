// Контрпример (а) TLC к модели замка (T95, раунд 1: 6b8a8978) на настоящем коде fs-atomic. Запуск:
// node --experimental-test-module-mocks scripts/fixtures/lock-race-harness.ts <dir>
// Порядок из трассы: папка упавшего претендента протухла; уборщик (этот процесс)
// проверил её; перед его rmdir другой уборщик снёс её, и живой претендент создал
// свою; rmdir уборщика сносит уже её. Печатает JSON: кто держал лок и когда.
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
  "openSync",
  "realpathSync",
  "readdirSync",
  "renameSync",
  "rmSync",
  "statSync",
  "utimesSync",
  "writeFileSync",
] as const;

const lock = join(process.argv[2] ?? ".", "state.lock");
let cleanerRmdir: (() => void) | undefined;
let victimMkdir: (() => void) | undefined;
let victimDirRemoved = false;
mock.module("node:fs", {
  namedExports: {
    ...Object.fromEntries(used.map((name) => [name, real[name]])),
    mkdirSync: (...args: Parameters<typeof realFs.mkdirSync>) => {
      const made = real.mkdirSync(...args);
      if (args[0] !== lock) return made;
      const hook = victimMkdir;
      victimMkdir = undefined;
      hook?.();
      return made;
    },
    rmdirSync: (path: realFs.PathLike) => {
      const hook = cleanerRmdir;
      cleanerRmdir = undefined;
      if (hook) hook();
      else real.rmdirSync(path);
    },
  },
});
const { acquireFileLockSync, releaseFileLock } =
  await import("../../agent/lib/fs-atomic.ts");

real.mkdirSync(lock); // претендент упал между mkdir и owner-файлом
const old = new Date(Date.now() - 60_000);
real.utimesSync(lock, old, old);

let victim: ReturnType<typeof acquireFileLockSync> = null;
cleanerRmdir = () => {
  real.rmdirSync(lock); // другой уборщик успел раньше
  victimMkdir = () => {
    // Претендент в окне mkdir → owner-файл; rmdir уборщика сносит его папку.
    real.rmdirSync(lock);
    victimDirRemoved = true;
  };
  victim = acquireFileLockSync(lock, { staleMs: 15_000, timeoutMs: 1_000 });
};
const cleaner = acquireFileLockSync(lock, { staleMs: 15_000, timeoutMs: 0 });
const owners = real.readdirSync(lock);
console.log(
  JSON.stringify({
    victimDirRemoved,
    victimHeld: victim !== null,
    cleanerHeld: cleaner !== null,
    owners: owners.length,
  }),
);
if (victim) releaseFileLock(victim);
if (cleaner) releaseFileLock(cleaner);
