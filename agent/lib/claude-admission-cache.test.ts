/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pinMessageBreakpoint, type NativeBlock } from "./claude-admission.ts";

const MARKER = { type: "ephemeral", ttl: "1h" };
const ASSISTANT = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "signed", signature: "sig" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__iva__probe",
      input: {},
    },
  ],
};
const RESULT = {
  type: "tool_result",
  tool_use_id: "toolu_1",
  content: "real output",
};
const QUESTION = { type: "text", text: "the real question" };

type Message = {
  readonly role: string;
  readonly content: unknown;
};

function wire(messages: readonly Message[]): Buffer {
  return Buffer.from(JSON.stringify({ model: "claude-fable-5-1", messages }));
}

function marked(block: Record<string, unknown>): Record<string, unknown> {
  return { ...block, cache_control: MARKER };
}

function marks(payload: Buffer): [number, number][] {
  const body = JSON.parse(payload.toString("utf8")) as {
    messages: { content: unknown }[];
  };
  return body.messages.flatMap((message, messageIndex) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block, blockIndex) =>
          typeof block === "object" &&
          block !== null &&
          "cache_control" in block
            ? [[messageIndex, blockIndex] as [number, number]]
            : [],
        )
      : [],
  );
}

function withoutMessageMarkers(payload: Buffer): unknown {
  const body = JSON.parse(payload.toString("utf8")) as {
    messages: { content: unknown }[];
  };
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block === "object" && block !== null)
        delete (block as Record<string, unknown>).cache_control;
    }
  }
  return body;
}

const examples: readonly {
  readonly name: string;
  readonly queried: NativeBlock[];
  readonly messages: Message[];
  readonly expected: [number, number];
}[] = [
  {
    name: "изменённый tool_result возвращает метку на assistant",
    queried: [RESULT],
    messages: [
      ASSISTANT,
      {
        role: "user",
        content: [
          {
            ...RESULT,
            content: "real output\n<system-reminder>account</system-reminder>",
          },
        ],
      },
      {
        role: "system",
        content: [marked({ type: "text", text: "Today's date is fixed." })],
      },
    ],
    expected: [0, 1],
  },
  {
    name: "добавленный хвост оставляет ведущий user-блок стабильным",
    queried: [QUESTION],
    messages: [
      ASSISTANT,
      {
        role: "user",
        content: [QUESTION, marked({ type: "text", text: "Session context" })],
      },
    ],
    expected: [1, 0],
  },
  {
    name: "добавленный префикс возвращает метку на assistant",
    queried: [QUESTION],
    messages: [
      ASSISTANT,
      {
        role: "user",
        content: [{ type: "text", text: "New preamble" }, marked(QUESTION)],
      },
    ],
    expected: [0, 1],
  },
  {
    name: "изменённый текст после tool_result сохраняет сам tool_result",
    queried: [RESULT, QUESTION],
    messages: [
      ASSISTANT,
      {
        role: "user",
        content: [
          RESULT,
          marked({
            ...QUESTION,
            text: "the real question\n<system-reminder>x</system-reminder>",
          }),
        ],
      },
    ],
    expected: [1, 0],
  },
  {
    name: "отдельный хвост после точного кадра сохраняет весь кадр",
    queried: [RESULT],
    messages: [
      ASSISTANT,
      { role: "user", content: [RESULT] },
      {
        role: "system",
        content: [marked({ type: "text", text: "Today's date is fixed." })],
      },
    ],
    expected: [1, 0],
  },
];

for (const example of examples) {
  test(example.name, () => {
    const input = wire(example.messages);
    const output = pinMessageBreakpoint(input, example.queried);

    assert.deepEqual(marks(output), [example.expected]);
    assert.deepEqual(
      withoutMessageMarkers(output),
      withoutMessageMarkers(input),
    );
  });
}

test("параллельные tool_result с изменённым последним закрепляются на assistant", () => {
  const results = Array.from({ length: 4 }, (_, index) => ({
    type: "tool_result",
    tool_use_id: `toolu_${String(index)}`,
    content: `output ${String(index)}`,
  }));
  const assistant = {
    role: "assistant",
    content: results.map((_, index) => ({
      type: "tool_use",
      id: `toolu_${String(index)}`,
      name: `probe_${String(index)}`,
      input: {},
    })),
  };
  const input = wire([
    assistant,
    {
      role: "user",
      content: [
        ...results.slice(0, -1),
        marked({
          ...results.at(-1),
          content: "output 3\n<system-reminder>native note</system-reminder>",
        }),
      ],
    },
  ]);

  const output = pinMessageBreakpoint(input, results);

  assert.deepEqual(marks(output), [[0, 3]]);
  assert.deepEqual(withoutMessageMarkers(output), withoutMessageMarkers(input));
});

test("первый шаг закрепляет метку на ведущем блоке точного user-кадра", () => {
  const input = wire([
    {
      role: "user",
      content: [
        QUESTION,
        marked({ type: "text", text: "volatile annotation" }),
      ],
    },
  ]);

  assert.deepEqual(marks(pinMessageBreakpoint(input, [QUESTION])), [[0, 0]]);
});

test("неразбираемое тело и тело без messages уходят тем же Buffer", () => {
  const invalid = Buffer.from("not json");
  const noMessages = Buffer.from('{ "model": "m" }');

  assert.strictEqual(pinMessageBreakpoint(invalid, [QUESTION]), invalid);
  assert.strictEqual(pinMessageBreakpoint(noMessages, [QUESTION]), noMessages);
});

test("ноль или несколько message-меток не меняют ни байта", () => {
  const none = wire([ASSISTANT, { role: "user", content: [QUESTION] }]);
  const many = wire([
    {
      role: "assistant",
      content: [marked({ type: "text", text: "one" })],
    },
    {
      role: "user",
      content: [marked({ type: "text", text: "two" })],
    },
  ]);

  assert.strictEqual(pinMessageBreakpoint(none, [QUESTION]), none);
  assert.strictEqual(pinMessageBreakpoint(many, [QUESTION]), many);
});

test("строковый content не кандидат и не роняет реле", () => {
  const input = wire([
    { role: "assistant", content: "old answer" },
    {
      role: "user",
      content: [marked({ type: "text", text: "volatile" })],
    },
  ]);

  assert.strictEqual(pinMessageBreakpoint(input, [QUESTION]), input);
});

test("thinking пропускается, а метки top-level system и tools не меняются", () => {
  const input = Buffer.from(
    JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "stable" },
            { type: "redacted_thinking", data: "sealed" },
          ],
        },
        {
          role: "user",
          content: [marked({ type: "text", text: "volatile" })],
        },
      ],
      system: [marked({ type: "text", text: "system" })],
      tools: [
        {
          name: "probe",
          input_schema: marked({ type: "object", properties: {} }),
        },
      ],
    }),
  );

  const output = pinMessageBreakpoint(input, [QUESTION]);
  const body = JSON.parse(output.toString("utf8")) as {
    messages: { content: Record<string, unknown>[] }[];
    system: Record<string, unknown>[];
    tools: { input_schema: Record<string, unknown> }[];
  };

  assert.deepEqual(marks(output), [[0, 0]]);
  assert.deepEqual(body.system[0]?.cache_control, MARKER);
  assert.deepEqual(body.tools[0]?.input_schema.cache_control, MARKER);
});

const FIXTURES = fileURLToPath(
  new URL("../../scripts/fixtures/claude-cache/", import.meta.url),
);

for (const [name, expected] of [
  ["req-01.json", [2, 0]],
  ["req-02.json", [4, 0]],
  ["req-03.json", [6, 0]],
] as const) {
  test(`обезличенный wire ${name} закрепляется на последнем assistant`, () => {
    const input = readFileSync(join(FIXTURES, name));
    const body = JSON.parse(input.toString("utf8")) as {
      messages: { role: string; content: unknown }[];
    };
    let newestUser: { role: string; content: unknown } | undefined;
    for (const message of body.messages)
      if (message.role === "user") newestUser = message;
    assert.ok(newestUser !== undefined && Array.isArray(newestUser.content));
    const sent = newestUser.content.at(-1) as NativeBlock;
    const queried = {
      ...sent,
      content:
        typeof sent.content === "string"
          ? sent.content.split("\n\n<system-reminder>", 1)[0]
          : sent.content,
    };

    const output = pinMessageBreakpoint(input, [queried]);

    assert.deepEqual(marks(output), [expected]);
    assert.deepEqual(
      withoutMessageMarkers(output),
      withoutMessageMarkers(input),
    );
  });
}

test("первый обезличенный wire без стабильного ведущего блока уходит как есть", () => {
  const input = readFileSync(join(FIXTURES, "req-00.json"));
  const body = JSON.parse(input.toString("utf8")) as {
    messages: { content: NativeBlock[] }[];
  };
  const queried = body.messages[0]?.content[1];
  assert.ok(queried !== undefined);

  assert.strictEqual(pinMessageBreakpoint(input, [queried]), input);
});
