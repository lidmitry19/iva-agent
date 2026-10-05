/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Перевод промпта eve в кадры stream-json и обратно проверяется генератором, а не примерами:
// история приходит из чужих рук (плагины, вложения, компакция, чужой ход субагента), и
// «не бывает такого» тут ничего не значит. Генератор даёт истории произвольной формы:
// system в начале, пустые куски, подряд идущие user-сообщения, картинки base64, вызовы
// инструментов с повторяющимися id и результаты инструментов всех видов.
//
// Seed печатается: без него падение PBT не воспроизвести. Прогонов 200 (IVA_CLAUDE_PBT_RUNS),
// seed можно задать IVA_CLAUDE_PBT_SEED.
import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import test from "node:test";
import fc from "fast-check";
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import type { NativeMessage } from "./claude-admission.ts";
import {
  CLAUDE_TOOL_PREFIX,
  claudeHistory,
  claudeSessionCwd,
  claudeSessionCwdEnabled,
  readCompletion,
  type ClaudeFrame,
} from "./claude-cli.ts";

const SEED = Number(process.env.IVA_CLAUDE_PBT_SEED ?? 20_261_002);
const RUNS = Number(process.env.IVA_CLAUDE_PBT_RUNS ?? 200);
const SETTINGS = { seed: SEED, numRuns: RUNS };

test(`рабочая папка CLI: один путь на сессию, свой у каждой (seed ${SEED})`, () => {
  const root = "/tmp/iva-root";
  fc.assert(
    fc.property(
      fc.string({ unit: "binary" }),
      fc.string({ unit: "binary" }),
      (first, second) => {
        const path = claudeSessionCwd(first, root);
        assert.equal(
          claudeSessionCwd(first, root),
          path,
          "путь детерминирован",
        );
        assert.match(basename(path), /^[0-9a-f]{32}$/u, "в пути только хэш");
        assert.equal(
          dirname(path),
          dirname(claudeSessionCwd(second, root)),
          "все сессии в одной папке",
        );
        assert.equal(dirname(dirname(path)), root);
        if (first !== second)
          assert.notEqual(claudeSessionCwd(second, root), path);
      },
    ),
    SETTINGS,
  );
});

test(`выключатель CLAUDE_SESSION_CWD: выключают только слова «нет» (seed ${SEED})`, () => {
  const off = ["0", "false", "no", "off"];
  assert.equal(claudeSessionCwdEnabled({}), true, "по умолчанию включено");
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.constantFrom(...off),
        fc.constantFrom(...off).map((word) => ` ${word.toUpperCase()} `),
      ),
      (value) => {
        const word = value.trim().toLowerCase();
        assert.equal(
          claudeSessionCwdEnabled({ CLAUDE_SESSION_CWD: value }),
          !off.includes(word),
        );
      },
    ),
    SETTINGS,
  );
});

test("перевод промпта в кадры и обратно держится на любых историях", () => {
  console.error(`[claude-cli property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(promptArbitrary(), (prompt) => {
      const before = structuredClone(prompt);
      const { system, frames } = claudeHistory(prompt);
      assert.equal(system, systemOf(prompt));
      assert.equal(frames.length > 0, true, "история не пустая");
      assertFrameShape(frames);
      assertTextPreserved(prompt, frames);
      assertImages(prompt, frames);
      assertToolCalls(prompt, frames);
      assert.deepEqual(prompt, before, "промпт не меняется разбором");
      assert.deepEqual(
        claudeHistory(structuredClone(prompt)).frames,
        frames,
        "разбор детерминирован",
      );
    }),
    SETTINGS,
  );
});

test("обратный перевод: кадры ассистента дают тот же шаг модели", () => {
  console.error(`[claude-cli property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(nativeMessageArbitrary(), (generated) => {
      const completion = readCompletion([generated.message]);
      assert.equal(completion.text, generated.text);
      // Пустой шаг не оставляет в промпте кадра ассистента: замыкать нечего.
      fc.pre(completion.text.length > 0 || completion.calls.length > 0);
      assert.deepEqual(
        completion.calls.map((call) => [call.id, call.name]),
        generated.calls,
      );
      for (const [index, call] of completion.calls.entries())
        assert.deepEqual(
          JSON.parse(call.input),
          generated.inputs[index],
          "аргументы вызова переживают JSON-строку",
        );
      // Круг замкнулся: блоки модели → шаг eve → ассистентский кадр → тот же шаг.
      const prompt: LanguageModelV4Prompt = [
        {
          role: "assistant",
          content: [
            ...(completion.text.length > 0
              ? [{ type: "text" as const, text: completion.text }]
              : []),
            ...completion.calls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        },
        { role: "user", content: [{ type: "text", text: "дальше" }] },
      ];
      const frames = claudeHistory(prompt).frames;
      const back = readCompletion([frames[0].message]);
      assert.equal(back.text, completion.text);
      assert.deepEqual(back.calls, completion.calls);
    }),
    SETTINGS,
  );
});

// Модель пишет имя инструмента как придётся: без префикса Iva, с чужим префиксом MCP, в другом
// регистре, с `-` вместо `_`. Инструмент набора узнаётся только по точному имени и по имени с
// префиксом `mcp__iva__`: угадывание превращало `Bash` от Claude в `bash` Ивы и исполняло его.
// Неузнанное имя (и свои инструменты CLI) уходит в eve как есть: на него eve отвечает модели
// tool-error со списком доступных, а шаг не падает.
const IVA_TOOL = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,19}$/u)
  .filter((name) => !/^mcp[_-]{2}/iu.test(name));
const SERVER = fc.oneof(
  fc.constantFrom("iva", "claude_ai_iva", "IVA", "plugin_iva_iva"),
  fc.stringMatching(/^[a-z0-9]{1,10}$/u),
);

function callOf(wire: string, inventory: readonly string[]) {
  return readCompletion(
    [{ content: [{ type: "tool_use", id: "toolu_x", name: wire, input: {} }] }],
    undefined,
    inventory,
  ).calls;
}

/** Написание имени: регистр и `-`/`_` меняются по генератору. */
function respelled(name: string, edits: readonly string[]): string {
  return [...name]
    .map((char, at) => {
      const edit = edits[at];
      if (edit === "upper") return char.toUpperCase();
      if (edit === "lower") return char.toLowerCase();
      if (edit === "swap")
        return char === "-" ? "_" : char === "_" ? "-" : char;
      return char;
    })
    .join("");
}

test(`только точное имя и имя с префиксом mcp__iva__ — тот же вызов (seed ${SEED})`, () => {
  console.error(`[claude-cli property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(
      fc.uniqueArray(IVA_TOOL, { minLength: 1, maxLength: 6 }),
      fc.nat(),
      fc.option(SERVER, { nil: undefined }),
      fc.array(fc.constantFrom("keep", "upper", "lower", "swap"), {
        minLength: 20,
        maxLength: 20,
      }),
      fc.boolean(),
      (inventory, pick, server, edits, dashedPrefix) => {
        const name = inventory[pick % inventory.length] ?? "";
        for (const exact of [name, CLAUDE_TOOL_PREFIX + name])
          assert.deepEqual(
            callOf(exact, inventory).map((call) => call.name),
            [name],
            `${exact} → ${name}`,
          );
        const glue = dashedPrefix ? "--" : "__";
        const body = respelled(name, edits);
        const wire =
          server === undefined ? body : `mcp${glue}${server}${glue}${body}`;
        const bare = wire.startsWith(CLAUDE_TOOL_PREFIX)
          ? wire.slice(CLAUDE_TOOL_PREFIX.length)
          : wire;
        assert.deepEqual(
          callOf(wire, inventory).map((call) => call.name),
          [bare],
          `${wire} уходит как есть, без угадывания`,
        );
      },
    ),
    SETTINGS,
  );
});

// Ф10: свои инструменты CLI не исполняются, даже когда у Ивы есть инструмент с тем же именем
// в другом регистре или под чужим сервером MCP.
test(`Bash, Grep, Glob от Claude — не инструменты набора с bash, grep, glob (seed ${SEED})`, () => {
  const inventory = ["bash", "grep", "glob", "write_card", "memory_search"];
  for (const wire of [
    "Bash",
    "Grep",
    "Glob",
    "BASH",
    "mcp__other__bash",
    "mcp__claude_ai_iva__bash",
    "mcp--iva--bash",
    "mcp__iva__Bash",
  ])
    assert.equal(
      inventory.includes(callOf(wire, inventory)[0]?.name ?? ""),
      false,
      `${wire} не исполняется инструментом Ивы`,
    );
  fc.assert(
    fc.property(
      fc.constantFrom("bash", "grep", "glob"),
      fc.array(fc.constantFrom("keep", "upper", "lower"), {
        minLength: 4,
        maxLength: 4,
      }),
      fc.option(SERVER, { nil: undefined }),
      (name, edits, server) => {
        const body = respelled(name, edits);
        const wire = server === undefined ? body : `mcp__${server}__${body}`;
        fc.pre(wire !== name && wire !== CLAUDE_TOOL_PREFIX + name);
        assert.equal(
          inventory.includes(callOf(wire, inventory)[0]?.name ?? ""),
          false,
          `${wire} не исполняется инструментом Ивы`,
        );
      },
    ),
    SETTINGS,
  );
});

test(`имя, совпавшее с несколькими инструментами набора, не угадывается (seed ${SEED})`, () => {
  fc.assert(
    fc.property(IVA_TOOL, (name) => {
      const lower = name.toLowerCase().replaceAll("-", "_");
      const inventory = [lower, lower.replaceAll("_", "-").toUpperCase()];
      fc.pre(new Set(inventory).size === 2);
      const wire = `${CLAUDE_TOOL_PREFIX}${lower.toUpperCase()}`;
      fc.pre(!inventory.includes(wire.slice(CLAUDE_TOOL_PREFIX.length)));
      assert.deepEqual(
        callOf(wire, inventory).map((call) => call.name),
        [lower.toUpperCase()],
      );
    }),
    SETTINGS,
  );
});

test(`любая строка имени не роняет разбор ответа (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ unit: "binary", maxLength: 80 }),
        fc.constantFrom(
          "",
          "Bash",
          "Read",
          "mcp__",
          "mcp____",
          CLAUDE_TOOL_PREFIX,
        ),
        IVA_TOOL.map((name) => `mcp__other__${name}`),
      ),
      fc.uniqueArray(IVA_TOOL, { maxLength: 6 }),
      (wire, inventory) => {
        const [call] = callOf(wire, inventory);
        assert.ok(call !== undefined);
        const bare = wire.startsWith(CLAUDE_TOOL_PREFIX)
          ? wire.slice(CLAUDE_TOOL_PREFIX.length)
          : wire;
        assert.ok(
          inventory.includes(call.name) || call.name === bare,
          "имя — инструмент набора или то, что прислала модель",
        );
      },
    ),
    SETTINGS,
  );
});

// Неузнанное имя вызова возвращается в историю следующего запроса. Anthropic принимает только
// `^[A-Za-z0-9_-]{1,64}$`: иначе отказ на каждом следующем шаге сессии. Имя набора не меняется —
// иначе кэш промпта не прочитает историю.
test(`имя вызова в истории всегда годится для провода (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ unit: "binary", maxLength: 100 }),
        fc.constantFrom("", "bad name!", "поиск", "a".repeat(90), "Bash"),
        IVA_TOOL,
      ),
      fc.stringMatching(/^toolu_[A-Za-z0-9]{1,8}$/u),
      (name, id) => {
        const { frames } = claudeHistory([
          { role: "user", content: [{ type: "text", text: "привет" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: id,
                toolName: name,
                input: "{}",
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: id,
                toolName: name,
                output: { type: "error-text", value: "нет такого" },
              },
            ],
          },
        ]);
        const blocks = frames.flatMap((frame) => frame.message.content);
        const call = blocks.find((block) => block.type === "tool_use");
        const result = blocks.find((block) => block.type === "tool_result");
        const wire = String(call?.name);
        assert.match(
          wire,
          /^[A-Za-z0-9_-]{1,64}$/u,
          `${JSON.stringify(name)} → ${wire}`,
        );
        assert.ok(wire.startsWith(CLAUDE_TOOL_PREFIX));
        if (/^[A-Za-z0-9_-]{1,54}$/u.test(name))
          assert.equal(
            wire,
            CLAUDE_TOOL_PREFIX + name,
            "имя набора не меняется",
          );
        if (name === "") assert.equal(wire, `${CLAUDE_TOOL_PREFIX}unknown`);
        assert.equal(
          result?.tool_use_id,
          id,
          "результат остаётся парой вызова",
        );
      },
    ),
    SETTINGS,
  );
});

test("история без вопроса в конце отвергается, а не уезжает как есть", () => {
  console.error(`[claude-cli property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(
      // Пустой ответ ассистента не создаёт кадра, и история остаётся кончающейся вопросом.
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.array(userMessageArbitrary(), { maxLength: 3 }),
      (assistantText, history) => {
        const prompt: LanguageModelV4Prompt = [
          ...history,
          {
            role: "assistant",
            content: [{ type: "text", text: assistantText }],
          },
        ];
        assert.throws(() => claudeHistory(prompt), /non-empty user/u);
      },
    ),
    SETTINGS,
  );
});

// #236: кэш промпта читает историю, только если запрос шага N+1 начинается с запроса шага N
// байт в байт. Шаг внутри хода дописывает вызов и результат, граница хода — ответ модели,
// строку времени и новый ввод. Пустой ответ модели кадра не даёт, и тогда время и ввод
// приклеиваются к последнему user-кадру: для него префикс — это префикс списка блоков.
test("кадры шага продолжают кадры прошлого шага байт в байт", () => {
  console.error(`[claude-cli property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(
      turnHistoryArbitrary(),
      extensionArbitrary(),
      (history, next) => {
        const before = claudeHistory(history).frames;
        const after = claudeHistory([...history, ...next]).frames;
        for (const frames of [before, after]) {
          assertFrameShape(frames);
          const ids = frames
            .filter((frame) => frame.type === "assistant")
            .map((frame) => frame.message.id);
          for (const id of ids)
            assert.equal(typeof id, "string", "у кадра ассистента есть id");
          assert.equal(
            new Set(ids).size,
            ids.length,
            "id кадров ассистента разные",
          );
        }
        const last = before.length - 1;
        for (const [index, frame] of before.entries()) {
          const same = withoutQuery(after[index]);
          if (index < last) {
            assert.deepEqual(
              same,
              withoutQuery(frame),
              `кадр ${index} не изменился`,
            );
            continue;
          }
          assert.equal(same.type, frame.type);
          assert.equal(same.message.id, frame.message.id);
          assert.deepEqual(
            same.message.content.slice(0, frame.message.content.length),
            frame.message.content,
            "последний кадр только дописан",
          );
        }
      },
    ),
    SETTINGS,
  );
});

function withoutQuery(frame: ClaudeFrame): ClaudeFrame {
  return { type: frame.type, message: frame.message };
}

// ─── Генераторы ─────────────────────────────────────────────────────────────────────────

const imageArbitrary = fc.oneof(
  fc.uint8Array({ maxLength: 24 }).map((bytes): LanguageModelV4FilePart => ({
    type: "file",
    mediaType: "image/png",
    data: { type: "data", data: bytes },
  })),
  fc.base64String({ maxLength: 24 }).map((text): LanguageModelV4FilePart => ({
    type: "file",
    mediaType: "image/jpeg",
    data: { type: "data", data: text },
  })),
);

const toolCallArbitrary = fc
  .record({
    toolCallId: fc.oneof(
      fc.constant("toolu_same"),
      fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/u),
    ),
    toolName: fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/u),
    input: fc.jsonValue(),
  })
  .map((call) => ({
    type: "tool-call" as const,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: JSON.stringify(call.input ?? {}),
  }));

const toolResultOutputArbitrary: fc.Arbitrary<LanguageModelV4ToolResultOutput> =
  fc.oneof(
    fc
      .string({ maxLength: 12 })
      .map((value) => ({ type: "text", value }) as const),
    fc
      .string({ maxLength: 12 })
      .map((value) => ({ type: "error-text", value }) as const),
    fc.jsonValue().map((value) => ({ type: "json", value }) as const),
    fc.jsonValue().map((value) => ({ type: "error-json", value }) as const),
    fc
      .string({ maxLength: 8 })
      .map((reason) => ({ type: "execution-denied", reason }) as const),
    fc.constant({ type: "content", value: [] as never[] }),
  );

function userMessageArbitrary(): fc.Arbitrary<LanguageModelV4Message> {
  return fc
    .array(
      fc.oneof(
        fc
          .string({ maxLength: 12 })
          .map((text) => ({ type: "text" as const, text })),
        imageArbitrary,
      ),
      { maxLength: 3 },
    )
    .map((content) => ({ role: "user" as const, content }));
}

function assistantMessageArbitrary(): fc.Arbitrary<LanguageModelV4Message> {
  return fc
    .array(
      fc.oneof(
        fc
          .string({ maxLength: 12 })
          .map((text) => ({ type: "text" as const, text })),
        fc
          .string({ maxLength: 6 })
          .map((text) => ({ type: "reasoning" as const, text })),
        toolCallArbitrary,
      ),
      { maxLength: 3 },
    )
    .map((content) => ({ role: "assistant" as const, content }));
}

function toolMessageArbitrary(): fc.Arbitrary<LanguageModelV4Message> {
  return fc
    .array(
      fc.record({
        toolCallId: fc.oneof(
          fc.constant("toolu_same"),
          fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/u),
        ),
        toolName: fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/u),
        output: toolResultOutputArbitrary,
      }),
      { maxLength: 3, minLength: 1 },
    )
    .map((parts) => ({
      role: "tool" as const,
      content: parts.map((part) => ({ type: "tool-result" as const, ...part })),
    }));
}

/** История eve: системные сообщения, произвольные ходы и обязательный вопрос в конце. */
function promptArbitrary(): fc.Arbitrary<LanguageModelV4Prompt> {
  const middle = fc.oneof(
    userMessageArbitrary(),
    assistantMessageArbitrary(),
    toolMessageArbitrary(),
  );
  return fc
    .record({
      system: fc.array(fc.string({ maxLength: 16 }), { maxLength: 2 }),
      middle: fc.array(middle, { maxLength: 4 }),
      last: fc
        .array(
          fc.oneof(
            // Непустой: пустой текст не создаёт кадр вовсе, и «последний кадр user»
            // проверялся бы на истории, которой в кадрах нет.
            fc
              .string({ minLength: 1, maxLength: 12 })
              .map((text) => ({ type: "text" as const, text })),
            imageArbitrary,
          ),
          { minLength: 1, maxLength: 2 },
        )
        .map((content) => ({ role: "user" as const, content })),
    })
    .map(({ system, middle, last }) => [
      ...system.map((content) => ({ role: "system" as const, content })),
      ...middle,
      last,
    ]);
}

const turnTextArbitrary = fc.string({ maxLength: 12 });
const callIdArbitrary = fc.stringMatching(/^toolu_[A-Za-z0-9]{1,6}$/u);

/** Шаг модели внутри хода: текст (или ничего) и вызов, затем результат вызова. */
function toolStepArbitrary(): fc.Arbitrary<LanguageModelV4Message[]> {
  return fc
    .record({
      text: turnTextArbitrary,
      id: callIdArbitrary,
      name: fc.constantFrom("weather", "remind"),
      value: fc.string({ maxLength: 12 }),
    })
    .map(({ text, id, name, value }) => [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text },
          {
            type: "tool-call" as const,
            toolCallId: id,
            toolName: name,
            input: "{}",
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: id,
            toolName: name,
            output: { type: "text" as const, value },
          },
        ],
      },
    ]);
}

/** История хода: system, ввод владельца и шаги с вызовами. */
function turnHistoryArbitrary(): fc.Arbitrary<LanguageModelV4Prompt> {
  return fc
    .record({
      system: fc.string({ maxLength: 16 }),
      input: fc.string({ minLength: 1, maxLength: 12 }),
      steps: fc.array(toolStepArbitrary(), { maxLength: 4 }),
    })
    .map(({ system, input, steps }) => [
      { role: "system" as const, content: system },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: input }],
      },
      ...steps.flat(),
    ]);
}

/** Следующий запрос: ещё один шаг хода или граница хода (ответ, время, новый ввод). */
function extensionArbitrary(): fc.Arbitrary<LanguageModelV4Message[]> {
  const boundary = fc
    .record({
      // Пустой ответ на границе хода порождается явно: это тот случай, где время и ввод
      // приклеиваются к последнему кадру прошлого шага.
      answer: fc.oneof(fc.constant(""), turnTextArbitrary),
      time: fc.string({ minLength: 1, maxLength: 12 }),
      input: fc.string({ minLength: 1, maxLength: 12 }),
    })
    .map(({ answer, time, input }): LanguageModelV4Message[] => [
      { role: "assistant", content: [{ type: "text", text: answer }] },
      { role: "user", content: [{ type: "text", text: time }] },
      { role: "user", content: [{ type: "text", text: input }] },
    ]);
  return fc.oneof(toolStepArbitrary(), boundary);
}

/** Сообщение модели (нативный ответ), каким его собирает реле: блоки, текст, вызовы. */
function nativeMessageArbitrary(): fc.Arbitrary<{
  message: NativeMessage;
  calls: [string, string][];
  inputs: unknown[];
  text: string;
}> {
  const blockArbitrary = fc.oneof(
    fc.string({ maxLength: 14 }).map((text) => ({
      block: { type: "text", text },
      text,
      call: undefined,
    })),
    fc
      .record({
        id: fc.oneof(
          fc.constant("toolu_same"),
          fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/u),
        ),
        name: fc.constantFrom("weather", "remind"),
        input: fc.jsonValue(),
      })
      .map((call) => ({
        block: {
          type: "tool_use",
          id: call.id,
          name: CLAUDE_TOOL_PREFIX + call.name,
          input: call.input,
        },
        text: "",
        call,
      })),
  );
  return fc.array(blockArbitrary, { maxLength: 5 }).chain((blocks) => {
    const text = blocks.map((entry) => entry.text).join("");
    const calls = blocks
      .filter((entry) => entry.call !== undefined)
      .map((entry) => [entry.call.id, entry.call.name] as [string, string]);
    const inputs = blocks
      .filter((entry) => entry.call !== undefined)
      .map((entry) => entry.call.input);
    const message: NativeMessage = {
      content: blocks.map((entry) => entry.block),
      stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    return fc.constant({
      message,
      calls,
      inputs,
      text,
    });
  });
}

// ─── Проверки кадров ────────────────────────────────────────────────────────────────────

type PartOf<Role extends "user" | "assistant" | "tool"> = Extract<
  LanguageModelV4Message,
  { role: Role }
>["content"][number];

/** Части всех сообщений одной роли: роль проверяется здесь, дальше союз типов закрыт. */
function partsOf<Role extends "user" | "assistant" | "tool">(
  prompt: LanguageModelV4Prompt,
  role: Role,
): PartOf<Role>[] {
  const parts: PartOf<Role>[] = [];
  for (const message of prompt)
    if (message.role === role)
      parts.push(...(message.content as PartOf<Role>[]));
  return parts;
}

function systemOf(prompt: LanguageModelV4Prompt): string {
  const system: string[] = [];
  for (const message of prompt)
    if (message.role === "system") system.push(message.content);
  return system.join("\n\n");
}

/** Текст промпта в исходном порядке: роли не переставляют содержимое хода. */
function promptText(prompt: LanguageModelV4Prompt): string {
  const texts: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") continue;
    for (const part of message.content)
      if (part.type === "text") texts.push((part as { text: string }).text);
  }
  return texts.join("");
}

function assertFrameShape(frames: readonly ClaudeFrame[]): void {
  const last = frames.at(-1)!;
  assert.equal(last.type, "user");
  assert.equal(last.message.content.length > 0, true, "последний кадр не пуст");
  assert.equal(
    last.shouldQuery,
    undefined,
    "последний кадр запрашивает модель",
  );
  for (const [index, frame] of frames.entries()) {
    if (frame.type === "assistant") {
      assert.equal(
        frame.shouldQuery,
        undefined,
        "у кадров ассистента нет признака",
      );
      assert.notEqual(
        frames[index - 1]?.type,
        "assistant",
        "кадры ассистента склеены",
      );
      continue;
    }
    if (index < frames.length - 1)
      assert.equal(frame.shouldQuery, false, "история не запрашивает модель");
    assert.notEqual(frames[index - 1]?.type, "user", "user-кадры склеены");
  }
  for (const frame of frames)
    assert.equal(frame.message.content.length > 0, true, "пустых кадров нет");
}

function framesText(frames: readonly ClaudeFrame[]): string {
  return frames
    .flatMap((frame) => frame.message.content)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");
}

function assertTextPreserved(
  prompt: LanguageModelV4Prompt,
  frames: readonly ClaudeFrame[],
): void {
  assert.equal(
    framesText(frames),
    promptText(prompt),
    "текст хода не теряется",
  );
}

function assertImages(
  prompt: LanguageModelV4Prompt,
  frames: readonly ClaudeFrame[],
): void {
  const sent = [
    ...partsOf(prompt, "user"),
    ...partsOf(prompt, "assistant"),
  ].filter((part): part is LanguageModelV4FilePart => part.type === "file");
  const images = frames
    .flatMap((frame) => frame.message.content)
    .filter((block) => block.type === "image");
  assert.equal(images.length, sent.length, "каждая картинка уехала");
  for (const [index, part] of sent.entries()) {
    assert.equal(part.data.type, "data");
    const data = part.data;
    const expected =
      typeof data.data === "string"
        ? data.data
        : Buffer.from(data.data).toString("base64");
    const source = images[index].source as {
      type: string;
      media_type: string;
      data: string;
    };
    assert.equal(source.type, "base64", "картинки едут только base64");
    assert.equal(source.data, expected, "байты картинки не портятся");
    assert.equal(source.media_type, part.mediaType);
  }
}

function assertToolCalls(
  prompt: LanguageModelV4Prompt,
  frames: readonly ClaudeFrame[],
): void {
  const blocks = frames.flatMap((frame) => frame.message.content);
  const sentCalls = partsOf(prompt, "assistant").filter(
    (part) => part.type === "tool-call",
  );
  const calls = blocks.filter((block) => block.type === "tool_use");
  assert.equal(calls.length, sentCalls.length, "каждый вызов уехал");
  for (const [index, part] of sentCalls.entries()) {
    const call = part as {
      toolCallId: string;
      toolName: string;
      input: string;
    };
    const block = calls[index];
    assert.equal(block.id, call.toolCallId, "id вызова сохраняется");
    assert.equal(block.name, CLAUDE_TOOL_PREFIX + call.toolName);
    assert.deepEqual(
      block.input,
      JSON.parse(call.input),
      "аргументы разобраны",
    );
  }
  const sentResults = partsOf(prompt, "tool").filter(
    (part) => part.type === "tool-result",
  );
  const results = blocks.filter((block) => block.type === "tool_result");
  assert.equal(results.length, sentResults.length, "каждый результат уехал");
  for (const [index, part] of sentResults.entries()) {
    const result = part as {
      toolCallId: string;
      output: LanguageModelV4ToolResultOutput;
    };
    const block = results[index];
    assert.equal(block.tool_use_id, result.toolCallId);
    const error =
      result.output.type === "error-text" ||
      result.output.type === "error-json" ||
      result.output.type === "execution-denied";
    assert.equal(
      block.is_error === true,
      error,
      "ошибка инструмента названа ошибкой",
    );
  }
}
