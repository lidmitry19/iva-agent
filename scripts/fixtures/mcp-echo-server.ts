/**
 * Крошечный stdio MCP-сервер на самом SDK: то, что MCP proxy держит на другом
 * конце в `services/mcp-proxy/proxy.test.ts`.
 *
 * Единственный тул `echo` возвращает своё окружение и аргументы. Он и есть проверка
 * изоляции: тест смотрит, что пришло сюда из env прокси, а что нет — вместо того
 * чтобы верить чтению кода.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Returns the environment and arguments of this process." },
  () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          env: process.env,
          argv: process.argv.slice(2),
          cwd: process.cwd(),
        }),
      },
    ],
  }),
);

// `--exit-after-ms <n>` — сервер, который уходит сам: так тест видит, что делает
// прокси, когда его сервер умер, не убивая процесс снаружи.
const after = process.argv.indexOf("--exit-after-ms");
if (after !== -1)
  setTimeout(() => process.exit(3), Number(process.argv[after + 1]));

await server.connect(new StdioServerTransport());
