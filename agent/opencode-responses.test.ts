import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, streamText } from "ai";

const dataDir = mkdtempSync(join(tmpdir(), "iva-go-responses-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
process.env.MODEL_PROVIDER = "opencode";
process.env.OPENCODE_API_KEY = "test-only";
process.env.OPENCODE_MODEL = "muse-spark-1.3-contributor";
process.env.OPENCODE_PROTOCOL = "responses";
process.env.OPENCODE_VISION_MODEL = "muse-spark-1.3-contributor";
process.env.OPENCODE_VISION_PROTOCOL = "responses";
process.env.THINKING_EFFORT = "high";
const go = await import("./provider.ts");
const { sdkUsageTokens } = await import("./lib/usage-tap.ts");
const blind = () => Promise.resolve(false);
const output = [
  {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  },
];
const result = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "muse-spark-1.3-contributor",
  output,
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

void test("Go Responses: actual SDK factory carries identity, tools and usage without Codex options", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const requests: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  globalThis.fetch = (input, init) => {
    requests.push({
      url:
        input instanceof Request
          ? input.url
          : input instanceof Request
            ? input.url
            : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "",
      ) as Record<string, unknown>,
    });
    return Promise.resolve(Response.json(result));
  };
  assert.equal(go.compatibleThinkingEffort, undefined);
  for (let i = 0; i < 2; i++) {
    const generated = await generateText({
      model: go.makeTextModel({
        sessionId: "conversation-1",
        chatModelSeesImages: blind,
      }),
      prompt: "ping",
      maxRetries: 0,
    });
    assert.equal(generated.text, "ok");
    assert.deepEqual(sdkUsageTokens(generated.usage), {
      in: 10,
      out: 2,
      cacheRead: 3,
      cacheWrite: 0,
    });
  }
  await go
    .makeTextModel({ sessionId: "conversation-1", chatModelSeesImages: blind })
    .doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      tools: [
        {
          type: "function",
          name: "ping",
          description: "check",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  for (const request of requests) {
    assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
    assert.equal(request.headers.get("authorization"), "Bearer test-only");
    assert.equal(request.headers.get("x-opencode-session"), "conversation-1");
    assert.equal(request.headers.get("user-agent"), go.IVA_USER_AGENT);
    assert.equal(request.body.model, "muse-spark-1.3-contributor");
    assert.equal(request.body.reasoning, undefined);
    assert.equal(request.body.prompt_cache_key, undefined);
  }
  const tool = (
    requests.at(-1)?.body.tools as { type: string; name: string }[]
  )[0];
  assert.equal(tool.type, "function");
  assert.equal(tool.name, "ping");
});

void test("Go Responses stream returns text and usage; absent session retains process identity", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const ids: string[] = [];
  globalThis.fetch = (_input, init) => {
    ids.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
    const events = [
      {
        type: "response.created",
        response: { ...result, output: [], status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...output[0], status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "ok",
      },
      { type: "response.output_item.done", output_index: 0, item: output[0] },
      { type: "response.completed", response: result },
    ];
    return Promise.resolve(
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  for (let i = 0; i < 2; i++) {
    const response = streamText({
      model: go.makeTextModel({ chatModelSeesImages: blind }),
      prompt: "ping",
      maxRetries: 0,
    });
    assert.equal(await response.text, "ok");
    assert.equal((await response.usage).inputTokens, 10);
  }
  assert.match(ids[0], /^iva-/);
  assert.equal(ids[0], ids[1]);
});

void test("Go vision fallback uses the explicitly selected Responses wire", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (input, init) => {
    assert.equal(
      input instanceof Request ? input.url : input.toString(),
      "https://opencode.ai/zen/go/v1/responses",
    );
    body = JSON.parse(
      typeof init?.body === "string" ? init.body : "",
    ) as Record<string, unknown>;
    return Promise.resolve(Response.json(result));
  };
  const { describeImage } = await import("./vision.ts");
  assert.equal(
    await describeImage(new Uint8Array([1, 2, 3]).buffer, "image/png"),
    "ok",
  );
  assert.match(JSON.stringify(body?.input), /input_image/);
  const usage = JSON.parse(
    readFileSync(join(dataDir, "usage.jsonl"), "utf8").trim(),
  ) as { provider: string; model: string };
  assert.equal(usage.provider, "opencode");
  assert.equal(usage.model, "muse-spark-1.3-contributor");
});

void test("Go Responses protocol refusal is surfaced without chat fallback", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const urls: string[] = [];
  globalThis.fetch = (input) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(
      Response.json(
        { error: { message: "Model does not support this protocol" } },
        { status: 400 },
      ),
    );
  };
  await assert.rejects(
    generateText({
      model: go.makeTextModel({ chatModelSeesImages: blind }),
      prompt: "ping",
      maxRetries: 0,
    }),
    /Model does not support this protocol/,
  );
  assert.deepEqual(urls, ["https://opencode.ai/zen/go/v1/responses"]);
});

void test("Go missing key never borrows OPENAI_API_KEY from another account", async (t) => {
  const previous = {
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.OPENCODE_API_KEY;
  process.env.OPENAI_API_KEY = "test-another-provider";
  const specifier = "./provider.ts?go=missing-key";
  const missing = (await import(specifier)) as typeof go;
  assert.throws(
    () => missing.makeTextModel({ chatModelSeesImages: blind }),
    /requires OPENCODE_API_KEY/,
  );
});
