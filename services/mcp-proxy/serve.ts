/**
 * Точка входа юнита `iva-mcp-<name>-<server>.service`:
 *
 *   node services/mcp-proxy/serve.ts --plugin <name> --server <server>
 *        --port <n> --token-file <path>
 *
 * Один процесс — один MCP-сервер плагина. Каталог данных берётся из
 * `ASSISTANT_DATA_DIR`, как у всех остальных юнитов Ивы.
 *
 * Ребёнок ушёл — уходим и мы, ненулевым кодом: держать открытый порт без сервера за
 * ним значит отвечать агенту ошибками вместо тулов. Поднимет пару обратно systemd
 * (`Restart=on-failure`), и это единственный владелец жизненного цикла.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "#lib/data-dir.ts";
import { startMcpProxy } from "./proxy.ts";

/**
 * Запущен ли этот файл как процесс. Обе стороны разрешаются по-настоящему: под
 * `current` путь юнита — симлинк, и сравнение строк соврало бы.
 */
function startedAsProcess(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(invoked) === real(fileURLToPath(moduleUrl));
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? "" : (argv[index + 1] ?? "");
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} <value> is required`);
  return value;
}

export async function main(argv: readonly string[]): Promise<number> {
  const plugin = option(argv, "plugin");
  const server = option(argv, "server");
  const port = Number(option(argv, "port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be a port number");
  const tokenFile = option(argv, "token-file");
  const token = readFileSync(tokenFile, "utf8").trim();
  // `ASSISTANT_DATA_DIR` ставит юнит, и без него прокси не угадывает: не тот каталог
  // данных — не тот плагин и не тот env.
  const dataDir = resolveDataDir(process.cwd(), process.env.ASSISTANT_DATA_DIR);

  const proxy = await startMcpProxy({
    plugin,
    server,
    port,
    token,
    dataDir,
  });
  console.log(
    `mcp proxy for ${plugin}/${server} on 127.0.0.1:${proxy.port} (data: ${dataDir})`,
  );
  const stop = async (signal: string): Promise<void> => {
    console.log(`stopping on ${signal}`);
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  const why = await proxy.childGone;
  console.error(why);
  await proxy.close();
  return 1;
}

// Запускается только как процесс: тест поднимает ядро (`proxy.ts`) напрямую.
if (startedAsProcess(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
