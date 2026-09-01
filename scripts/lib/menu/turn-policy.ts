// Экран обработки новых сообщений. Настройка читается каналом перед каждой отправкой,
// поэтому переключение действует сразу и не требует рестарта.
import { readSettings, writeSettings } from "#lib/settings.ts";

const PARENT = "r";

type TurnPolicy = "queue" | "steer";
type Button = { text: string; callback_data: string };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
  show: (state: MenuState, screen: string) => Promise<void>;
};

function currentPolicy(): TurnPolicy {
  return readSettings().turnPolicy === "steer" ? "steer" : "queue";
}

function isTurnPolicy(value: unknown): value is TurnPolicy {
  return value === "queue" || value === "steer";
}

export default {
  parent: PARENT,
  render(_state: MenuState, ctx: MenuContext) {
    const current = currentPolicy();
    const T = ctx.tr;
    const option = (value: TurnPolicy, english: string, russian: string) =>
      ctx.btn(
        `${current === value ? "✓" : "○"} ${T(english, russian)}`,
        `iva_menu:turn:set:${value}`,
      );
    return {
      text: T(
        "🔀 New messages\n\nQueue waits for the current reply.\nInterrupt sends the message into the active reply.",
        "🔀 Новые сообщения\n\nОчередь ждёт текущий ответ.\nПеребивать направляет сообщение в активный ответ.",
      ),
      rows: [
        [
          option("queue", "Queue", "Очередь"),
          option("steer", "Interrupt", "Перебивать"),
        ],
        ctx.backRow(PARENT),
      ],
    };
  },
  async on(
    verb: string,
    args: string[],
    state: MenuState,
    ctx: MenuContext,
  ): Promise<void> {
    if (verb !== "set" || args.length !== 1 || !isTurnPolicy(args[0])) return;
    writeSettings({ turnPolicy: args[0] });
    await ctx.show(state, "turn");
  },
};
