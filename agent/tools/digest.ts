import { defineTool } from "eve/tools";
import { z } from "zod";
import { buildMorningDigest } from "../lib/digest.js";

export default defineTool({
  description: "Собирает проверенный текущим запуском утренний дайджест. Не использует кэш Bitrix и не меняет задачи.",
  inputSchema: z.object({}),
  async execute() { return await buildMorningDigest(); },
});
