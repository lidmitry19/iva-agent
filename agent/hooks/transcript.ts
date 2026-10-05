import { defineHook } from "eve/hooks";
// Двусторонний транскрипт: финальный ответ Iva дозаписывается в ТОТ ЖЕ дневной файл
// vault, что и реплики юзера (agent/lib/telegram-inbound.ts).
import { appendDaily } from "../lib/vault-daily.js";

export default defineHook({
  events: {
    // message.completed несёт видимый текст одного завершённого шага ассистента.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы; пропускаем,
    // пишем только финальные реплики Iva.
    "message.completed": (event) => {
      if (event.data.finishReason === "tool-calls") return;
      const text = (event.data.message ?? "").trim();
      // QUIET — ответ планового хода Watch или Brief «писать не о чем»: в чат он не уходит
      // и в дневной файл не пишется (ADR-0020).
      if (!text || text === "QUIET") return;
      appendDaily("[iva]", text);
    },
  },
});
