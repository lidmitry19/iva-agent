/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// КАК ВОСПРОИЗВЕСТИ: fast-check печатает seed и path; они идут в параметры fc.assert.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { pinMessageBreakpoint, type NativeBlock } from "./claude-admission.ts";

const MARKER = { type: "ephemeral", ttl: "1h" };

type Message = {
  readonly role: string;
  content: NativeBlock[];
};

type Body = { readonly model: string; readonly messages: Message[] };

function stripMessageMarkers(body: Body): Body {
  return {
    ...body,
    messages: body.messages.map((message) => ({
      ...message,
      content: message.content.map((block) => {
        const plain = { ...block };
        delete plain.cache_control;
        return plain;
      }),
    })),
  };
}

function markLocation(body: Body): [number, number] {
  const locations = body.messages.flatMap((message, messageIndex) =>
    message.content.flatMap((block, blockIndex) =>
      "cache_control" in block
        ? [[messageIndex, blockIndex] as [number, number]]
        : [],
    ),
  );
  const [location] = locations;
  assert.ok(location !== undefined);
  return location;
}

const STEP = fc.record({
  value: fc.string({ minLength: 1, maxLength: 40 }),
  thinking: fc.boolean(),
});

test("история N шагов меняет только позицию метки и даёт следующий стабильный префикс", () => {
  fc.assert(
    fc.property(fc.array(STEP, { minLength: 1, maxLength: 12 }), (steps) => {
      const messages: Message[] = [];
      for (const [index, step] of steps.entries()) {
        const id = `toolu_${String(index)}`;
        messages.push({
          role: "assistant",
          content: [
            ...(step.thinking
              ? [{ type: "thinking", thinking: `thought ${String(index)}` }]
              : []),
            {
              type: "tool_use",
              id,
              name: "mcp__iva__probe",
              input: { value: step.value },
            },
          ],
        });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: step.value,
            },
          ],
        });
      }

      const latestUser = messages.at(-1);
      assert.ok(latestUser !== undefined);
      const queried = structuredClone(latestUser.content);
      latestUser.content = [
        {
          ...latestUser.content[0],
          content: `${String(latestUser.content[0]?.content)}\n<system-reminder>volatile</system-reminder>`,
        },
      ];
      messages.push({
        role: "system",
        content: [
          {
            type: "text",
            text: "volatile date",
            cache_control: MARKER,
          },
        ],
      });
      const inputBody: Body = { model: "claude-fable-5-1", messages };
      const input = Buffer.from(JSON.stringify(inputBody));

      const output = pinMessageBreakpoint(input, queried);
      const outputBody = JSON.parse(output.toString("utf8")) as Body;
      const [messageIndex] = markLocation(outputBody);

      assert.deepEqual(
        stripMessageMarkers(outputBody),
        stripMessageMarkers(inputBody),
        "ни один блок, кроме cache_control, не меняется",
      );
      const nextMessages = structuredClone(messages.slice(0, -1));
      nextMessages[nextMessages.length - 1] = {
        ...nextMessages.at(-1),
        content: queried,
      } as Message;
      nextMessages.push({
        role: "assistant",
        content: [{ type: "text", text: "next answer" }],
      });
      assert.deepEqual(
        stripMessageMarkers({
          model: inputBody.model,
          messages: outputBody.messages.slice(0, messageIndex + 1),
        }).messages,
        nextMessages.slice(0, messageIndex + 1),
        "префикс через закреплённую метку повторяется следующим запросом",
      );
    }),
    { numRuns: 300, seed: 2_026_092_8 },
  );
});
