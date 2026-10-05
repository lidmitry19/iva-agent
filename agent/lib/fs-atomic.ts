// Два примитива, на которых держится ADR-0002 («данные пользователя не теряются»):
// запись через уникальный tmp + rename — читатель никогда не видит половину файла, и
// lock-каталог с token-specific owner entry — параллельные писатели (агент, мост,
// спавнер расписаний) сериализуются, а release удаляет только имя своего токена.
//
// Оба примитива есть в sync- и async-варианте, потому что это разные семантики, а не
// удобство: sync-держатель крутится на Atomics.wait и обязан быть sync (write_card,
// run-status вызываются из синхронного кода), а async-держатель обязан отпускать
// event loop — иначе два конкурирующих хода в одном процессе (инструмент tasks,
// спавнер расписаний) сами себя загнали бы в дедлок до таймаута.
//
// Политика (сколько ждать, когда считать лок протухшим, каким режимом создавать файл)
// принадлежит вызывающему: у карточки вольта, статуса хода и резервации расписания
// разные цены ожидания. Здесь только механизм.
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const ATOMIC_WRITE_DURABILITY = "EATOMIC_WRITE_DURABILITY";
export const ATOMIC_WRITE_PARENT_CHANGED = "EATOMIC_WRITE_PARENT_CHANGED";

export type AtomicWriteStep =
  | "mkdir"
  | "realpath-directory"
  | "stat-directory"
  | "stat-parent-snapshot"
  | "verify-parent"
  | "linearize-directory-proof"
  | "open-temp"
  | "chmod-temp"
  | "write-temp"
  | "sync-temp"
  | "close-temp"
  | "rename"
  | "open-directory"
  | "sync-directory"
  | "close-directory";

export type AtomicWriteOptions = {
  /** Права создаваемого файла; по умолчанию — обычный umask-дефолт Node (0o666). */
  mode?: number;
  /** Тестовый шов: вызывается после каждого завершённого шага протокола. */
  afterStep?: (step: AtomicWriteStep, path: string) => void;
};

export type FileLock = {
  /** Путь lock-каталога (не защищаемого им файла). */
  path: string;
  /** Токен владения: release удаляет только owner-entry с этим токеном. */
  token: string;
};

export type FileLockOptions = {
  /** Сколько ждать освобождения, прежде чем сдаться. */
  timeoutMs?: number;
  /**
   * Возраст лока, после которого он считается брошенным упавшим процессом. Один путь —
   * один staleMs: период сердцебиения держателя берётся из его staleMs, протухание —
   * из staleMs претендента.
   */
  staleMs?: number;
  /** Пауза между попытками захвата. */
  retryMs?: number;
  /** Права inode владельца внутри lock-каталога. */
  mode?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_RETRY_MS = 25;

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;

const errorSyscall = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "syscall" in error
    ? typeof error.syscall === "string"
      ? error.syscall
      : undefined
    : undefined;

// Уникален на процесс И на вызов: два параллельных writeFileAtomic не разделят один
// tmp-путь, а значит не затрут запись друг друга и не выдернут tmp из-под чужого
// rename (ENOENT). Флаг "wx" ниже страхует это на уровне ФС.
const tmpPathFor = (file: string): string =>
  `${file}.tmp-${process.pid}-${randomUUID()}`;

type DirectoryIdentity = {
  path: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type ParentSnapshot = DirectoryIdentity & {
  requestedPath: string;
  targetPath: string;
};

type PublishedError = Error & {
  code: string;
  file: string;
  published: boolean;
};

function durabilityError(
  file: string,
  cause: unknown,
  snapshot: ParentSnapshot,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Atomic write published ${snapshot.targetPath}, but directory durability could not be confirmed for ${file}: ${detail}`,
    { cause },
  ) as PublishedError;
  error.code = ATOMIC_WRITE_DURABILITY;
  error.file = file;
  error.published = true;
  return error;
}

function parentChangedError(
  file: string,
  snapshot: ParentSnapshot,
  published: boolean,
  cause?: unknown,
): Error {
  const phase = published
    ? `after publishing ${snapshot.targetPath}`
    : "before rename";
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const error = new Error(
    `Atomic write parent changed ${phase} for ${file}${detail}`,
    cause === undefined ? undefined : { cause },
  ) as PublishedError;
  error.code = ATOMIC_WRITE_PARENT_CHANGED;
  error.file = file;
  error.published = published;
  return error;
}

function isParentChangedError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === ATOMIC_WRITE_PARENT_CHANGED
  );
}

function closeSyncQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    /* preserve the protocol failure that triggered cleanup */
  }
}

function createdDirectoriesToSync(
  parent: string,
  firstCreated: string | undefined,
): string[] {
  if (firstCreated === undefined) return [parent];
  const paths = [parent];
  const existingParent = dirname(firstCreated);
  let current = dirname(parent);
  while (!paths.includes(current)) {
    paths.push(current);
    if (current === existingParent) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return paths;
}

// Успешный вызов обязан закрыть и хвост прошлого упавшего mkdir. Файловая система
// не говорит, был ли уже видимый каталог когда-либо fsync-нут, поэтому без журнала
// единственная stateless-граница — корень. Идём изнутри наружу: сначала запись файла,
// затем каждая запись каталога в его родителе.
function ancestorDirectories(parent: string): [string, ...string[]] {
  let current = parent;
  const paths: [string, ...string[]] = [current];
  for (;;) {
    const next = dirname(current);
    if (next === current) return paths;
    current = next;
    paths.push(current);
  }
}

// Each cached proof belongs to directory entries, not just inodes. For an entry at
// index i, a rename/recreation changes both the child's ctime and its container's
// metadata at i + 1. Either side alone can change without changing that entry: this
// writer changes index 0, while unrelated siblings change only the container.
// We check once before publishing and again afterwards. A cache-hit write linearizes
// at the first successful direct-parent stat in the post-publish inspection: its file
// and parent entry are already durable there. The remaining stats confirm that point
// retrospectively. `linearize-directory-proof` reports that confirmation. An external
// mutation after the first stat is a later operation; the unchanged cached proof makes
// the next write detect it instead of blessing unconfirmed metadata.
const confirmedDirectoryChains = new Map<string, DirectoryIdentity[]>();

function sameDirectoryEntryProofs(
  previous: DirectoryIdentity[] | undefined,
  current: DirectoryIdentity[],
): boolean {
  return (
    previous !== undefined &&
    previous.length === current.length &&
    previous.every((identity, index) => {
      const candidate = current[index];
      if (
        candidate === undefined ||
        identity.path !== candidate.path ||
        identity.dev !== candidate.dev ||
        identity.ino !== candidate.ino
      )
        return false;
      const previousContainer = previous[index + 1];
      const currentContainer = current[index + 1];
      if (previousContainer === undefined || currentContainer === undefined)
        return true;
      const childChanged = identity.ctimeNs !== candidate.ctimeNs;
      const containerChanged =
        previousContainer.mtimeNs !== currentContainer.mtimeNs ||
        previousContainer.ctimeNs !== currentContainer.ctimeNs;
      return !childChanged || !containerChanged;
    })
  );
}

function sameIdentity(
  expected: Pick<DirectoryIdentity, "dev" | "ino">,
  current: Pick<DirectoryIdentity, "dev" | "ino">,
): boolean {
  return expected.dev === current.dev && expected.ino === current.ino;
}

function inspectDirectoryChainSync(
  paths: string[],
  afterStep: AtomicWriteOptions["afterStep"],
): DirectoryIdentity[] {
  return paths.map((path) => {
    const stats = statSync(path, { bigint: true });
    afterStep?.("stat-directory", path);
    return {
      path,
      dev: stats.dev,
      ino: stats.ino,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
    };
  });
}

async function inspectDirectoryChain(
  paths: string[],
  afterStep: AtomicWriteOptions["afterStep"],
): Promise<DirectoryIdentity[]> {
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    const stats = await stat(path, { bigint: true });
    afterStep?.("stat-directory", path);
    identities.push({
      path,
      dev: stats.dev,
      ino: stats.ino,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
    });
  }
  return identities;
}

function syncCreatedDirectoriesSync(
  parent: string,
  firstCreated: string | undefined,
): void {
  if (firstCreated === undefined) return;
  for (const directory of createdDirectoriesToSync(parent, firstCreated)) {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

async function syncCreatedDirectories(
  parent: string,
  firstCreated: string | undefined,
): Promise<void> {
  if (firstCreated === undefined) return;
  for (const directory of createdDirectoriesToSync(parent, firstCreated)) {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function verifyParentMappingSync(
  file: string,
  snapshot: ParentSnapshot,
  published: boolean,
  afterStep: AtomicWriteOptions["afterStep"],
): void {
  let mapped: string;
  try {
    mapped = realpathSync(snapshot.requestedPath);
  } catch (cause) {
    throw parentChangedError(file, snapshot, published, cause);
  }

  let current: Pick<DirectoryIdentity, "dev" | "ino">;
  try {
    const stats = statSync(snapshot.path, { bigint: true });
    current = { dev: stats.dev, ino: stats.ino };
  } catch (cause) {
    throw parentChangedError(file, snapshot, published, cause);
  }
  if (mapped !== snapshot.path || !sameIdentity(snapshot, current))
    throw parentChangedError(file, snapshot, published);
  afterStep?.("verify-parent", snapshot.path);
}

async function verifyParentMapping(
  file: string,
  snapshot: ParentSnapshot,
  published: boolean,
  afterStep: AtomicWriteOptions["afterStep"],
): Promise<void> {
  let mapped: string;
  try {
    mapped = await realpath(snapshot.requestedPath);
  } catch (cause) {
    throw parentChangedError(file, snapshot, published, cause);
  }

  let current: Pick<DirectoryIdentity, "dev" | "ino">;
  try {
    const stats = await stat(snapshot.path, { bigint: true });
    current = { dev: stats.dev, ino: stats.ino };
  } catch (cause) {
    throw parentChangedError(file, snapshot, published, cause);
  }
  if (mapped !== snapshot.path || !sameIdentity(snapshot, current))
    throw parentChangedError(file, snapshot, published);
  afterStep?.("verify-parent", snapshot.path);
}

/** Атомарная замена файла: читатель видит либо старое содержимое целиком, либо новое. */
export function writeFileAtomicSync(
  file: string,
  data: string,
  { mode, afterStep }: AtomicWriteOptions = {},
): void {
  const requestedParent = dirname(file);
  let tmp: string | undefined;
  let tempFd: number | undefined;
  let parentFd: number | undefined;
  let directoryFd: number | undefined;
  let published = false;
  let snapshot: ParentSnapshot | undefined;
  try {
    mkdirSync(requestedParent, { recursive: true });
    afterStep?.("mkdir", requestedParent);
    const canonicalParent = realpathSync(requestedParent);
    afterStep?.("realpath-directory", canonicalParent);
    const directoryChain = ancestorDirectories(canonicalParent);
    const previousProofs = confirmedDirectoryChains.get(directoryChain[0]);
    confirmedDirectoryChains.delete(directoryChain[0]);
    let identities = inspectDirectoryChainSync(directoryChain, afterStep);
    const proofsConfirmedBeforePublish = sameDirectoryEntryProofs(
      previousProofs,
      identities,
    );
    const parentIdentity = identities[0];
    snapshot = {
      ...parentIdentity,
      requestedPath: requestedParent,
      targetPath: join(canonicalParent, basename(file)),
    };
    parentFd = openSync(snapshot.path, "r");
    afterStep?.("open-directory", snapshot.path);
    const openedParent = fstatSync(parentFd, { bigint: true });
    afterStep?.("stat-parent-snapshot", snapshot.path);
    if (!sameIdentity(snapshot, openedParent))
      throw parentChangedError(file, snapshot, false);
    tmp = tmpPathFor(snapshot.targetPath);
    tempFd = openSync(tmp, "wx", mode);
    afterStep?.("open-temp", tmp);
    if (mode !== undefined) {
      fchmodSync(tempFd, mode);
      afterStep?.("chmod-temp", tmp);
    }
    writeFileSync(tempFd, data, { encoding: "utf8" });
    afterStep?.("write-temp", tmp);
    fsyncSync(tempFd);
    afterStep?.("sync-temp", tmp);
    closeSync(tempFd);
    tempFd = undefined;
    afterStep?.("close-temp", tmp);
    verifyParentMappingSync(file, snapshot, false, afterStep);
    renameSync(tmp, snapshot.targetPath);
    published = true;
    afterStep?.("rename", snapshot.targetPath);

    fsyncSync(parentFd);
    afterStep?.("sync-directory", snapshot.path);
    closeSync(parentFd);
    parentFd = undefined;
    afterStep?.("close-directory", snapshot.path);
    identities = inspectDirectoryChainSync(directoryChain, afterStep);
    const proofsConfirmed =
      proofsConfirmedBeforePublish &&
      sameDirectoryEntryProofs(previousProofs, identities);
    if (proofsConfirmed)
      afterStep?.("linearize-directory-proof", snapshot.path);
    for (const identity of proofsConfirmed ? [] : identities.slice(1)) {
      const directory = identity.path;
      directoryFd = openSync(directory, "r");
      afterStep?.("open-directory", directory);
      const openedDirectory = fstatSync(directoryFd, { bigint: true });
      afterStep?.("stat-parent-snapshot", directory);
      if (!sameIdentity(identity, openedDirectory))
        throw parentChangedError(file, snapshot, true);
      fsyncSync(directoryFd);
      afterStep?.("sync-directory", directory);
      closeSync(directoryFd);
      directoryFd = undefined;
      afterStep?.("close-directory", directory);
    }
    verifyParentMappingSync(file, snapshot, true, afterStep);
    confirmedDirectoryChains.set(
      directoryChain[0],
      proofsConfirmed && previousProofs !== undefined
        ? previousProofs
        : identities,
    );
  } catch (cause) {
    closeSyncQuietly(directoryFd);
    closeSyncQuietly(parentFd);
    closeSyncQuietly(tempFd);
    if (!published && tmp !== undefined) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* cleanup never touches the published target */
      }
    }
    if (isParentChangedError(cause)) throw cause;
    if (published && snapshot !== undefined)
      throw durabilityError(file, cause, snapshot);
    throw cause;
  }
}

/** То же, что writeFileAtomicSync, но не блокирует event loop. */
export async function writeFileAtomic(
  file: string,
  data: string,
  { mode, afterStep }: AtomicWriteOptions = {},
): Promise<void> {
  const requestedParent = dirname(file);
  let tmp: string | undefined;
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  let parentHandle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let snapshot: ParentSnapshot | undefined;
  try {
    await mkdir(requestedParent, { recursive: true });
    afterStep?.("mkdir", requestedParent);
    const canonicalParent = await realpath(requestedParent);
    afterStep?.("realpath-directory", canonicalParent);
    const directoryChain = ancestorDirectories(canonicalParent);
    const previousProofs = confirmedDirectoryChains.get(directoryChain[0]);
    confirmedDirectoryChains.delete(directoryChain[0]);
    let identities = await inspectDirectoryChain(directoryChain, afterStep);
    const proofsConfirmedBeforePublish = sameDirectoryEntryProofs(
      previousProofs,
      identities,
    );
    const parentIdentity = identities[0];
    snapshot = {
      ...parentIdentity,
      requestedPath: requestedParent,
      targetPath: join(canonicalParent, basename(file)),
    };
    parentHandle = await open(snapshot.path, "r");
    afterStep?.("open-directory", snapshot.path);
    const openedParent = await parentHandle.stat({ bigint: true });
    afterStep?.("stat-parent-snapshot", snapshot.path);
    if (!sameIdentity(snapshot, openedParent))
      throw parentChangedError(file, snapshot, false);
    tmp = tmpPathFor(snapshot.targetPath);
    tempHandle = await open(tmp, "wx", mode);
    afterStep?.("open-temp", tmp);
    if (mode !== undefined) {
      await tempHandle.chmod(mode);
      afterStep?.("chmod-temp", tmp);
    }
    await tempHandle.writeFile(data, { encoding: "utf8" });
    afterStep?.("write-temp", tmp);
    await tempHandle.sync();
    afterStep?.("sync-temp", tmp);
    await tempHandle.close();
    tempHandle = undefined;
    afterStep?.("close-temp", tmp);
    await verifyParentMapping(file, snapshot, false, afterStep);
    await rename(tmp, snapshot.targetPath);
    published = true;
    afterStep?.("rename", snapshot.targetPath);

    await parentHandle.sync();
    afterStep?.("sync-directory", snapshot.path);
    await parentHandle.close();
    parentHandle = undefined;
    afterStep?.("close-directory", snapshot.path);
    identities = await inspectDirectoryChain(directoryChain, afterStep);
    const proofsConfirmed =
      proofsConfirmedBeforePublish &&
      sameDirectoryEntryProofs(previousProofs, identities);
    if (proofsConfirmed)
      afterStep?.("linearize-directory-proof", snapshot.path);
    for (const identity of proofsConfirmed ? [] : identities.slice(1)) {
      const directory = identity.path;
      directoryHandle = await open(directory, "r");
      afterStep?.("open-directory", directory);
      const openedDirectory = await directoryHandle.stat({ bigint: true });
      afterStep?.("stat-parent-snapshot", directory);
      if (!sameIdentity(identity, openedDirectory))
        throw parentChangedError(file, snapshot, true);
      await directoryHandle.sync();
      afterStep?.("sync-directory", directory);
      await directoryHandle.close();
      directoryHandle = undefined;
      afterStep?.("close-directory", directory);
    }
    await verifyParentMapping(file, snapshot, true, afterStep);
    confirmedDirectoryChains.set(
      directoryChain[0],
      proofsConfirmed && previousProofs !== undefined
        ? previousProofs
        : identities,
    );
  } catch (cause) {
    await directoryHandle?.close().catch(() => {});
    await parentHandle?.close().catch(() => {});
    await tempHandle?.close().catch(() => {});
    if (!published && tmp !== undefined)
      await rm(tmp, { force: true }).catch(() => {});
    if (isParentChangedError(cause)) throw cause;
    if (published && snapshot !== undefined)
      throw durabilityError(file, cause, snapshot);
    throw cause;
  }
}

type Attempt = FileLock | "busy" | "retry";

const LOCK_OWNER_PREFIX = ".owner-";
const LOCK_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const lockOwnerName = (token: string): string => `${LOCK_OWNER_PREFIX}${token}`;
const lockOwnerPath = (path: string, token: string): string =>
  join(path, lockOwnerName(token));

function tokenFromOwnerName(name: string): string | undefined {
  if (!name.startsWith(LOCK_OWNER_PREFIX)) return undefined;
  const token = name.slice(LOCK_OWNER_PREFIX.length);
  return LOCK_TOKEN.test(token) ? token : undefined;
}

function removeOwnedLockName(path: string, token: string): void {
  if (!LOCK_TOKEN.test(token)) return;
  try {
    rmSync(lockOwnerPath(path, token), { force: true });
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

function removeEmptyLockDirectory(path: string): Attempt {
  try {
    rmdirSync(path);
    return "retry";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "retry";
    if (code === "ENOTEMPTY" || code === "EEXIST") return "busy";
    throw error;
  }
}

function inspectOccupiedLock(path: string, staleMs: number): Attempt {
  let lockStats: ReturnType<typeof lstatSync>;
  try {
    lockStats = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "retry";
    throw error;
  }

  const stale = Date.now() - Number(lockStats.mtimeMs) > staleMs;
  if (!lockStats.isDirectory()) {
    // v1 lock-files and hostile foreign types are opaque. Removing a stale v1
    // path cannot be identity-bound, so automatic takeover would risk deleting
    // a fresh v1 successor between lstat and rm.
    return "busy";
  }

  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(path, "r");
    const directory = fstatSync(directoryFd, { bigint: true });
    if (!directory.isDirectory() || !sameIdentity(lockStats, directory))
      return "retry";

    const names = readdirSync(path);
    const owners = names
      .map(tokenFromOwnerName)
      .filter((token): token is string => token !== undefined);

    if (!stale) return "busy";

    // Cleanup may use path-based Node APIs only after proving that the path still
    // names the opened directory. If it changed earlier, touch neither version.
    const currentDirectory = lstatSync(path, { bigint: true });
    if (
      !currentDirectory.isDirectory() ||
      !sameIdentity(directory, currentDirectory)
    )
      return "retry";
    if (Date.now() - Number(currentDirectory.mtimeMs) <= staleMs) return "busy";

    if (names.length === 1 && owners.length === 1) {
      removeOwnedLockName(path, owners[0]);
      return removeEmptyLockDirectory(path);
    }

    // An empty directory is the mkdir→owner-entry crash window. Multiple token
    // entries can exist only during a contender race. Each cleanup name is bound
    // to one token, so a replaced directory with another owner stays non-empty.
    for (const token of owners) removeOwnedLockName(path, token);
    return removeEmptyLockDirectory(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "retry";
    throw error;
  } finally {
    closeSyncQuietly(directoryFd);
  }
}

// Одна попытка захвата. "busy" — лок держит кто-то живой (стоит подождать),
// "retry" — лок протух или исчез между попытками, повторяем немедленно.
function attemptLock(
  path: string,
  staleMs: number,
  mode: number | undefined,
): Attempt {
  const token = randomUUID();
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    return inspectOccupiedLock(path, staleMs);
  }

  const ownerPath = lockOwnerPath(path, token);
  let fd: number | undefined;
  let directoryFd: number | undefined;
  try {
    const createdDirectory = lstatSync(path, { bigint: true });
    if (!createdDirectory.isDirectory()) return "retry";
    directoryFd = openSync(path, "r");
    const directory = fstatSync(directoryFd, { bigint: true });
    if (!sameIdentity(createdDirectory, directory)) {
      closeSync(directoryFd);
      directoryFd = undefined;
      return "retry";
    }
    fd = openSync(ownerPath, "wx", mode);
    closeSync(fd);
    fd = undefined;
    const currentDirectory = lstatSync(path, { bigint: true });
    const canonicalOwner = lstatSync(ownerPath, { bigint: true });
    const names = readdirSync(path);
    if (
      !sameIdentity(directory, currentDirectory) ||
      !canonicalOwner.isFile() ||
      names.length !== 1 ||
      names[0] !== lockOwnerName(token)
    ) {
      closeSync(directoryFd);
      directoryFd = undefined;
      removeOwnedLockName(path, token);
      removeEmptyLockDirectory(path);
      return "retry";
    }
    closeSync(directoryFd);
    directoryFd = undefined;
    return { path, token };
  } catch (error) {
    closeSyncQuietly(fd);
    closeSyncQuietly(directoryFd);
    try {
      removeOwnedLockName(path, token);
      removeEmptyLockDirectory(path);
    } catch {
      /* keep the acquisition failure */
    }
    const code = errorCode(error);
    if (
      code === "ENOENT" ||
      code === "EEXIST" ||
      code === "ENOTDIR" ||
      code === "EISDIR" ||
      code === "ERR_FS_EISDIR" ||
      (code === "EINVAL" && errorSyscall(error) === "open")
    )
      return "retry";
    throw error;
  }
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Захват лока без освобождения event loop. Возвращает держателя или null, если
 * таймаут истёк: что значит «не досталось» — ошибка или работа без лока — решает
 * вызывающий, у которого есть слова для своего пользователя. Сердцебиения нет:
 * секция под этим локом синхронная и обязана быть много короче staleMs, иначе лок
 * живого держателя сочтут брошенным и заберут (specs/FileLock-sync-slow.cfg).
 */
export function acquireFileLockSync(
  path: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    retryMs = DEFAULT_RETRY_MS,
    mode,
  }: FileLockOptions = {},
): FileLock | null {
  checkStaleMs(path, staleMs);
  // Свежая установка: каталога данных может ещё не быть — лок не должен падать ENOENT.
  const parent = dirname(path);
  const firstCreated = mkdirSync(parent, { recursive: true });
  syncCreatedDirectoriesSync(parent, firstCreated);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = attemptLock(path, staleMs, mode);
    if (typeof attempt !== "string") return attempt;
    // Дедлайн проверяется и на пути "retry": мигающий чужой лок иначе зациклил бы
    // захват навсегда.
    if (Date.now() > deadline) return null;
    if (attempt === "busy") Atomics.wait(waitBuffer, 0, 0, retryMs);
  }
}

/**
 * То же, что acquireFileLockSync, но ждёт, отпуская event loop, и держатель бьётся:
 * раз в staleMs/3 обновляет mtime каталога лока. Контракт: секция под локом конечна и
 * много короче LOCK_MAX_HOLD_MS; сердцебиение держит лок, пока event loop держателя
 * свободен хотя бы раз в 2/3 staleMs (между двумя срабатываниями таймера). Остановленный
 * процесс (SIGSTOP, сон VM, долгий GC) могут обокрасть, как и раньше.
 */
export async function acquireFileLock(
  path: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    retryMs = DEFAULT_RETRY_MS,
    mode,
  }: FileLockOptions = {},
): Promise<FileLock | null> {
  checkStaleMs(path, staleMs);
  const parent = dirname(path);
  const firstCreated = await mkdir(parent, { recursive: true });
  await syncCreatedDirectories(parent, firstCreated);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = attemptLock(path, staleMs, mode);
    if (typeof attempt !== "string") return startHeartbeat(attempt, staleMs);
    if (Date.now() > deadline) return null;
    if (attempt === "busy")
      await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/** Предохранитель: после стольких мс удержания сердцебиение гаснет, лок протухает. */
export const LOCK_MAX_HOLD_MS = 600_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const heartbeats = new Map<string, () => void>();

function checkStaleMs(path: string, staleMs: number): void {
  // staleMs ≤ 0 делал любой лок брошенным сразу (два писателя), < 3 — период 1 мс.
  if (!Number.isFinite(staleMs) || staleMs <= 0)
    throw new TypeError(
      `file lock ${path}: staleMs ${staleMs} is not positive`,
    );
}

function startHeartbeat(lock: FileLock, staleMs: number): FileLock {
  // Не чаще 100 мс: staleMs в единицы мс — тестовый, горячий цикл ему не положен.
  const period = Math.min(Math.max(staleMs / 3, 100), MAX_TIMER_MS);
  const say = (what: string) =>
    process.stderr.write(`file lock ${lock.path}: heartbeat ${what}\n`);
  let warned = false;
  const stop = () => {
    clearInterval(beat);
    clearTimeout(fuse);
    heartbeats.delete(lock.token);
  };
  const beat = setInterval(() => {
    try {
      lstatSync(lockOwnerPath(lock.path, lock.token));
      // Между lstat и utimes каталог могут сменить: касание преемника безвредно.
      utimesSync(lock.path, new Date(), new Date());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      if (code === "ENOENT" || code === "ENOTDIR") return stop();
      // Прочие ошибки (EACCES, EIO…) — попытка на следующем тике, одна строка stderr.
      // Постоянный отказ защиту не сохраняет: каталог стареет, через staleMs его заберут.
      if (!warned) say(`${code}, still running`);
      warned = true;
    }
  }, period);
  // Предохранитель — свой таймер: срабатывает и при периоде дольше предела.
  const fuse = setTimeout(() => {
    stop();
    say(`off: held longer than ${LOCK_MAX_HOLD_MS} ms, the lock will expire`);
  }, LOCK_MAX_HOLD_MS);
  beat.unref();
  fuse.unref();
  heartbeats.set(lock.token, stop);
  return lock;
}

/**
 * Снятие лока. Owner-entry содержит токен владельца, а rmdir сработает только для
 * пустого каталога. Поэтому поздний release не удалит owner-entry преемника и его
 * каталог с owner-entry. Пустой каталог претендента, ещё не записавшего owner-entry,
 * путевой rmdir снести может: претендент это видит и повторяет попытку (контракт 3
 * в specs/FileLock.tla).
 */
export function releaseFileLock({ path, token }: FileLock): void {
  heartbeats.get(token)?.();
  try {
    removeOwnedLockName(path, token);
    removeEmptyLockDirectory(path);
  } catch {
    /* лока уже нет */
  }
}
