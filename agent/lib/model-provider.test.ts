/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Выбор провайдера обязан быть ОДНИМ решением: имя, модель и reasoning уезжают дальше
// вместе или не уезжают вовсе. Здесь проверяется и сам резолвер, и то, что рантайм с
// учётом расхода берут из него одну и ту же правду (issue #161 родился как раз из двух
// независимых чтений одного MODEL_PROVIDER).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  MODEL_PROVIDERS,
  MODEL_PROVIDER_NAMES,
  invalidModelProviderMessage,
  resolveModelProvider,
} from "./model-provider.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// Запускает node в корне репозитория: агент стартует так же — целым процессом, а не вызовом.
function runInRepo(script: string, env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: ROOT,
      encoding: "utf8",
      // agent/** импортирует соседей как "./x.js" — см. scripts/lib/ts-esm-hooks.ts.
      env: { ...process.env, ...env },
    },
  );
}

test("model provider selection defaults to Ollama", () => {
  assert.deepEqual(resolveModelProvider({}), {
    name: "ollama",
    model: "deepseek-v4-pro",
    visionModel: "gemma4:31b",
    compatibleReasoning: true,
  });
});

test("model provider selection preserves each supported provider identity", () => {
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "ollama-model",
    }),
    {
      name: "ollama",
      model: "ollama-model",
      visionModel: "gemma4:31b",
      compatibleReasoning: true,
    },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/opencode-model",
    }),
    {
      name: "opencode",
      model: "opencode-model",
      visionModel: "minimax-m3",
      compatibleReasoning: true,
    },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_MODEL: "vendor/router-model",
    }),
    {
      name: "openrouter",
      model: "vendor/router-model",
      visionModel: "google/gemini-2.5-flash",
      compatibleReasoning: false,
    },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "codex-model",
    }),
    {
      name: "codex",
      model: "codex-model",
      // Подписка мультимодальна: картинку смотрит та же текстовая модель.
      visionModel: "codex-model",
      compatibleReasoning: false,
    },
  );
});

test("every supported provider keeps its own default model", () => {
  assert.deepEqual(
    MODEL_PROVIDER_NAMES.map(
      (name) => resolveModelProvider({ MODEL_PROVIDER: name }).model,
    ),
    ["deepseek-v4-pro", "deepseek-v4-pro", "gpt-5.5", "openai/gpt-5.1"],
  );
});

// ─── Vision-модель ────────────────────────────────────────────────────────────────────
// Вторая модель того же провайдера: текстовая сплошь и рядом слепая, поэтому фото уходит
// своей. Правило чтения переменной у обеих моделей одно — здесь проверяется, что оно
// действительно одно, и что провайдеры не читают переменные друг друга.

test("every supported provider keeps its own default vision model", () => {
  assert.deepEqual(
    MODEL_PROVIDER_NAMES.map(
      (name) => resolveModelProvider({ MODEL_PROVIDER: name }).visionModel,
    ),
    // codex — без своей переменной: у него это дефолтная текстовая модель подписки.
    ["gemma4:31b", "minimax-m3", "gpt-5.5", "google/gemini-2.5-flash"],
  );
});

test("a configured vision variable replaces the provider default", () => {
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "ollama",
      OLLAMA_VISION_MODEL: "llava:34b",
    }).visionModel,
    "llava:34b",
  );
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_VISION_MODEL: "vendor/eyes",
    }).visionModel,
    "vendor/eyes",
  );
  // Префикс мастера срезается и у vision — эндпоинт Go ждёт bare-ID и здесь тоже.
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_VISION_MODEL: "  opencode-go/qwen3.7-plus  ",
    }).visionModel,
    "qwen3.7-plus",
  );
});

test("a blank vision variable means the provider default, not an empty model name", () => {
  for (const raw of ["", " ", "\t\n", "\u00a0", "opencode-go/"]) {
    assert.equal(
      resolveModelProvider({
        MODEL_PROVIDER: "opencode",
        OPENCODE_VISION_MODEL: raw,
      }).visionModel,
      "minimax-m3",
      JSON.stringify(raw),
    );
  }
});

// Vision-модель codex не настраивается: подписка мультимодальна, картинка идёт той же
// моделью и тем же токеном. Любая *_VISION_MODEL в .env для него — чужая строка.
test("codex takes its vision model from the text model and ignores every vision variable", () => {
  const selection = resolveModelProvider({
    MODEL_PROVIDER: "codex",
    CODEX_MODEL: "gpt-5.5-codex",
    CODEX_VISION_MODEL: "nope",
    OLLAMA_VISION_MODEL: "nope",
    OPENCODE_VISION_MODEL: "nope",
    OPENROUTER_VISION_MODEL: "nope",
  });
  assert.equal(selection.visionModel, "gpt-5.5-codex");
  assert.equal(selection.visionModel, selection.model);
});

// Тот же раскол, что и с текстовой моделью: чужая переменная не смеет доехать до запроса.
test("a vision variable of another provider never reaches the selection", () => {
  const noise = {
    OLLAMA_VISION_MODEL: "ollama-eyes",
    OPENCODE_VISION_MODEL: "opencode-eyes",
    OPENROUTER_VISION_MODEL: "openrouter-eyes",
  };
  assert.equal(
    resolveModelProvider({ MODEL_PROVIDER: "opencode", ...noise }).visionModel,
    "opencode-eyes",
  );
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OLLAMA_VISION_MODEL: "ollama-eyes",
    }).visionModel,
    "minimax-m3",
  );
  assert.equal(
    resolveModelProvider({ MODEL_PROVIDER: "codex", ...noise }).visionModel,
    "gpt-5.5",
  );
});

// Текстовая и vision-модель настраиваются независимо: смена одной не трогает другую.
test("the text model and the vision model are configured independently", () => {
  const selection = resolveModelProvider({
    MODEL_PROVIDER: "ollama",
    OLLAMA_MODEL: "glm-5.2",
    OLLAMA_VISION_MODEL: "gemma4:31b",
  });
  assert.equal(selection.model, "glm-5.2");
  assert.equal(selection.visionModel, "gemma4:31b");
  assert.equal(
    resolveModelProvider({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "glm-5.2" })
      .visionModel,
    "gemma4:31b",
  );
});

// Префикс "opencode-go/" — внутренний UI-идентификатор мастера; эндпоинт Go ждёт bare-ID.
// Слаг openrouter тоже содержит "/", и срезать у него ничего нельзя.
test("only OpenCode loses the wizard prefix from a configured model", () => {
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/glm-5.2",
    }).model,
    "glm-5.2",
  );
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_MODEL: "opencode-go/glm-5.2",
    }).model,
    "opencode-go/glm-5.2",
  );
});

test("model provider selection rejects values that would split runtime identity", () => {
  assert.deepEqual(
    [...MODEL_PROVIDER_NAMES],
    ["ollama", "opencode", "codex", "openrouter"],
  );
  const garbage = [
    "ollmaa", // опечатка из issue #161
    " ollama", // ведущий пробел из ручного .env
    "ollama ", // хвостовой пробел
    "ollama\n", // перевод строки, доехавший из копипасты
    " ollama", // неразрывный пробел
    "ollama​", // zero-width space — глазом не отличить от валидного
    "OLLAMA", // другой регистр
    "Ollama",
    "", // MODEL_PROVIDER= без значения
    "оllama", // кириллическая «о» в первом символе
    "ollama,opencode", // попытка задать двух сразу
    "__proto__", // мусор, который на прототипе объекта «нашёлся» бы
    "constructor",
    "toString",
  ];
  for (const value of garbage) {
    assert.throws(
      () => resolveModelProvider({ MODEL_PROVIDER: value }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, invalidModelProviderMessage(value));
        return true;
      },
      value,
    );
  }
});

// Отказ читает человек в journalctl или в выводе `iva doctor`: он обязан увидеть и то,
// что задал сам, и все имена, из которых можно выбрать, и чем это чинится.
test("the refusal names the bad value, every accepted name and the fix", () => {
  const message = invalidModelProviderMessage("ollmaa");
  assert.equal(
    message,
    'Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config',
  );
  for (const name of MODEL_PROVIDER_NAMES)
    assert.match(message, new RegExp(name));
});

test("runtime configuration and usage share the resolved provider identity", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-provider-usage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = runInRepo(
    `
    await import("./scripts/lib/ts-esm-hooks.ts");
    const provider = await import("./agent/provider.ts");
    const usage = (await import("./agent/hooks/usage.ts")).default;
    usage.events["step.completed"](
      { data: { stepIndex: 1, turnId: "turn_1", usage: { inputTokens: 2, outputTokens: 3 } } },
      { session: { id: "session_1" }, channel: { kind: "test" } },
    );
    console.log(JSON.stringify({
      name: provider.providerName,
      model: provider.providerConfig.textModel,
      vision: provider.providerConfig.visionModel,
      effort: provider.compatibleThinkingEffort,
    }));
  `,
    {
      ASSISTANT_DATA_DIR: dataDir,
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/test-model",
      THINKING_EFFORT: "high",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    name: "opencode",
    model: "test-model",
    // Vision-переменной в env прогона нет — приезжает дефолт провайдера, а не текстовая
    // модель и не пустая строка.
    vision: "minimax-m3",
    effort: "high",
  });
  const usage: unknown = JSON.parse(
    readFileSync(join(dataDir, "usage.jsonl"), "utf8"),
  );
  assert.equal(isRecord(usage), true);
  if (!isRecord(usage)) return;
  assert.equal(usage.provider, "opencode");
  assert.equal(usage.model, "test-model");
});

// Переменная из .env обязана доехать до тела запроса, а не остаться в резолвере: картинку
// шлёт agent/vision.ts, читая providerConfig целым процессом — так же, как стартует агент.
test("a configured vision model reaches the runtime configuration of the process", () => {
  const cases: {
    env: Record<string, string>;
    expected: { vision: string };
  }[] = [
    {
      env: {
        MODEL_PROVIDER: "opencode",
        OPENCODE_MODEL: "glm-5.2",
        OPENCODE_VISION_MODEL: "opencode-go/qwen3.7-plus",
      },
      expected: { vision: "qwen3.7-plus" },
    },
    {
      // codex: своей переменной нет, чужая молчит, картинку смотрит текстовая модель.
      env: {
        MODEL_PROVIDER: "codex",
        CODEX_MODEL: "gpt-5.5",
        OLLAMA_VISION_MODEL: "nope",
      },
      expected: { vision: "gpt-5.5" },
    },
  ];
  for (const { env, expected } of cases) {
    const result = runInRepo(
      `
      await import("./scripts/lib/ts-esm-hooks.ts");
      const provider = await import("./agent/provider.ts");
      console.log(JSON.stringify({
        vision: provider.providerConfig.visionModel,
      }));
    `,
      env,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout.trim()),
      expected,
      env.MODEL_PROVIDER,
    );
  }
});

// Обе точки входа рантайма читают MODEL_PROVIDER на загрузке модуля — падать они обязаны
// обе, иначе учёт расхода пережил бы отказ конфигурации и писал бы под чужим именем.
test("runtime startup rejects an invalid provider before choosing a config", () => {
  for (const module of ["./agent/provider.ts", "./agent/hooks/usage.ts"]) {
    const result = runInRepo(
      `await import("./scripts/lib/ts-esm-hooks.ts"); await import(${JSON.stringify(module)});`,
      { MODEL_PROVIDER: "ollmaa" },
    );

    assert.notEqual(result.status, 0, module);
    assert.match(
      result.stderr,
      /Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config/,
      module,
    );
  }
});

test("runtime startup rejects an invalid context window", () => {
  const cases = [
    ["ollama", "OLLAMA_CONTEXT_WINDOW"],
    ["opencode", "OPENCODE_CONTEXT_WINDOW"],
    ["openrouter", "OPENROUTER_CONTEXT_WINDOW"],
    ["codex", "CODEX_CONTEXT_WINDOW"],
  ] as const;
  for (const [provider, variable] of cases) {
    for (const value of ["NaN", "0", "-7", "1.5"]) {
      const result = runInRepo(
        `await import("./scripts/lib/ts-esm-hooks.ts"); await import("./agent/provider.ts");`,
        { MODEL_PROVIDER: provider, [variable]: value },
      );

      assert.notEqual(result.status, 0, `${provider}:${value}`);
      assert.match(result.stderr, new RegExp(variable), `${provider}:${value}`);
    }
  }
});

test("runtime validates only the selected provider context window", () => {
  const result = runInRepo(
    `
      await import("./scripts/lib/ts-esm-hooks.ts");
      const provider = await import("./agent/provider.ts");
      console.log(provider.providerConfig.contextWindow);
    `,
    {
      MODEL_PROVIDER: "ollama",
      OLLAMA_CONTEXT_WINDOW: "65536",
      CODEX_CONTEXT_WINDOW: "NaN",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "65536");
});

// ─── Свойства (fast-check) ────────────────────────────────────────────────────────────
// Якоря выше перечисляют конкретные значения контракта; здесь генераторы ходят по всему
// входному пространству — именно там и нашлась опечатка issue #161.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает в отчёте строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь их вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
const NAMES: readonly string[] = MODEL_PROVIDER_NAMES;
const RUNS = { numRuns: 500 };

// Пробельные обрамления, которых человек в .env не видит.
const invisible = fc.constantFrom("", " ", "\t", "\n", "\r", " ", "​");

// Регистр-мутации валидного имени: OLLAMA, Ollama, oLLaMa — рантайм принимает одно.
const caseMutated = fc
  .constantFrom(...NAMES)
  .chain((name) =>
    fc
      .array(fc.boolean(), { minLength: name.length, maxLength: name.length })
      .map((flags) =>
        [...name]
          .map((char, index) => (flags[index] ? char.toUpperCase() : char))
          .join(""),
      ),
  );

const padded = fc
  .tuple(invisible, fc.constantFrom(...MODEL_PROVIDER_NAMES), invisible)
  .map(([left, name, right]) => `${left}${name}${right}`);

const notAProviderName = fc
  .oneof(
    fc.string(),
    fc.string({ unit: "grapheme" }),
    fc.string({ unit: "binary" }),
    padded,
    caseMutated,
    // Ключи прототипа: на них ловится проверка через `in`/индексирование вместо списка.
    fc.constantFrom(
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ),
    fc.constantFrom(...MODEL_PROVIDER_NAMES).map((name) => `${name},${name}`),
  )
  .filter((value) => !NAMES.includes(value));

test("property: every value outside the list is refused, with the list in the refusal", () => {
  fc.assert(
    fc.property(notAProviderName, (value) => {
      assert.throws(
        () => resolveModelProvider({ MODEL_PROVIDER: value }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === invalidModelProviderMessage(value),
      );
      // Перечень в отказе — канонический порядок целиком, а не «одно из».
      assert.ok(
        invalidModelProviderMessage(value).includes(
          "ollama, opencode, codex, openrouter",
        ),
      );
    }),
    RUNS,
  );
});

test("property: a valid name never picks up another provider's model", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      // Значение без обрамляющих пробелов: их отдельное свойство ниже.
      fc.string({ minLength: 1 }).filter((s) => s === s.trim()),
      (name, suffix) => {
        // У каждого провайдера своя помеченная модель: чужая в ответе видна сразу.
        const env: Record<string, string> = { MODEL_PROVIDER: name };
        for (const other of MODEL_PROVIDER_NAMES)
          env[MODEL_PROVIDERS[other].modelVar] = `${other}::${suffix}`;

        const selection = resolveModelProvider(env);
        assert.equal(selection.name, name);
        assert.equal(selection.model, `${name}::${suffix}`);
        assert.equal(selection.model.length > 0, true);
        assert.equal(
          selection.compatibleReasoning,
          name === "ollama" || name === "opencode",
        );
      },
    ),
    RUNS,
  );
});

test("property: an unset model variable falls back to that provider's own default", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      // Чужие переменные заполнены, своя — нет: дефолт обязан прийти из своей строки.
      fc.string({ minLength: 1 }),
      (name, noise) => {
        const env: Record<string, string> = { MODEL_PROVIDER: name };
        for (const other of MODEL_PROVIDER_NAMES)
          if (other !== name) env[MODEL_PROVIDERS[other].modelVar] = noise;

        const selection = resolveModelProvider(env);
        assert.equal(selection.model, MODEL_PROVIDERS[name].defaultModel);
        assert.equal(selection.model.length > 0, true);
      },
    ),
    RUNS,
  );
});

test("property: OpenCode drops the wizard prefix and nobody else touches the value", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }).filter((s) => s === s.trim()),
      (model) => {
        assert.equal(
          resolveModelProvider({
            MODEL_PROVIDER: "opencode",
            OPENCODE_MODEL: `opencode-go/${model}`,
          }).model,
          model,
        );
        for (const name of MODEL_PROVIDER_NAMES) {
          if (name === "opencode") continue;
          const tagged = `opencode-go/${model}`;
          assert.equal(
            resolveModelProvider({
              MODEL_PROVIDER: name,
              [MODEL_PROVIDERS[name].modelVar]: tagged,
            }).model,
            tagged,
          );
        }
      },
    ),
    RUNS,
  );
});

// Пустое и пробельное значение — это «не задано». Раньше рантайм отдавал пустую строку
// провайдеру, а два экрана показывали разное; теперь ответ один — дефолт провайдера.
test("property: a blank or padded model variable always means the provider default", () => {
  const blank = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0"), { maxLength: 6 })
    .map((chars) => chars.join(""));
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      blank,
      (name, padding) => {
        const selection = resolveModelProvider({
          MODEL_PROVIDER: name,
          [MODEL_PROVIDERS[name].modelVar]: padding,
        });
        assert.equal(selection.model, MODEL_PROVIDERS[name].defaultModel);
      },
    ),
    RUNS,
  );
  // Тот же случай у OpenCode приходит голым префиксом мастера.
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "  opencode-go/  ",
    }).model,
    MODEL_PROVIDERS.opencode.defaultModel,
  );
});

// Значение с обрамляющими пробелами доезжает до провайдера обрезанным, а не как есть.
test("property: padding around a real model is trimmed, not passed through", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      fc.string({ minLength: 1 }).filter((s) => s === s.trim() && s !== ""),
      fc.constantFrom("", " ", "  ", "\t", "\n"),
      (name, model, pad) => {
        const selection = resolveModelProvider({
          MODEL_PROVIDER: name,
          [MODEL_PROVIDERS[name].modelVar]: `${pad}${model}${pad}`,
        });
        assert.equal(selection.model, model);
      },
    ),
    RUNS,
  );
});

// Vision-модель читается тем же правилом, что и текстовая, — значит и свойства у неё те же.
// Отдельно проверяется, что своя переменная не тянет за собой чужие: у codex её нет вовсе,
// и подставить туда соседнюю строку .env нельзя ни при каком входе.
test("property: a blank or padded vision variable always means the provider default", () => {
  const blank = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0"), { maxLength: 6 })
    .map((chars) => chars.join(""));
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      blank,
      (name, padding) => {
        const variable = MODEL_PROVIDERS[name].visionModelVar;
        const selection = resolveModelProvider({
          MODEL_PROVIDER: name,
          ...(variable === null ? {} : { [variable]: padding }),
        });
        assert.equal(
          selection.visionModel,
          // codex без переменной отвечает своей текстовой моделью.
          MODEL_PROVIDERS[name].defaultVisionModel ?? selection.model,
        );
        assert.equal(selection.visionModel.length > 0, true);
      },
    ),
    RUNS,
  );
});

test("property: a configured vision model arrives trimmed and never from a neighbour", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      fc.string({ minLength: 1 }).filter((s) => s === s.trim()),
      fc.constantFrom("", " ", "  ", "\t", "\n"),
      (name, model, pad) => {
        // Все четыре vision-переменные помечены своим провайдером: чужая видна сразу.
        const env: Record<string, string> = { MODEL_PROVIDER: name };
        for (const other of MODEL_PROVIDER_NAMES) {
          const variable = MODEL_PROVIDERS[other].visionModelVar;
          if (variable !== null)
            env[variable] = `${pad}${other}::${model}${pad}`;
        }

        const selection = resolveModelProvider(env);
        const variable = MODEL_PROVIDERS[name].visionModelVar;
        assert.equal(
          selection.visionModel,
          variable === null ? selection.model : `${name}::${model}`,
        );
        // И текстовая модель от vision-переменных не съезжает.
        assert.equal(selection.model, MODEL_PROVIDERS[name].defaultModel);
      },
    ),
    RUNS,
  );
});

test("property: only OpenCode strips the wizard prefix from the vision model too", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...MODEL_PROVIDER_NAMES),
      fc.string({ minLength: 1 }).filter((s) => s === s.trim()),
      (name, model) => {
        const variable = MODEL_PROVIDERS[name].visionModelVar;
        if (variable === null) return;
        const tagged = `opencode-go/${model}`;
        assert.equal(
          resolveModelProvider({
            MODEL_PROVIDER: name,
            [variable]: tagged,
          }).visionModel,
          name === "opencode" ? model : tagged,
        );
      },
    ),
    RUNS,
  );
});
