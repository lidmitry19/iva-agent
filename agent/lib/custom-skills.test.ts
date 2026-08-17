/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Якоря контракта резолвера пользовательских скиллов. Свойства на случайных деревьях —
// в custom-skills.property.test.ts.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  customSkillsDir,
  readCustomSkills,
  readLiveSkills,
} from "./custom-skills.ts";
import { readPlugin } from "./plugin-reader.ts";
import {
  pluginsStateFile,
  writePluginsState,
  type PluginEntry,
} from "./plugin-store.ts";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-custom-skills-"));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string | Uint8Array) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Читает каталог, собирая строки лога вместо console.error. */
async function read(dir: string) {
  const log: string[] = [];
  const skills = await readCustomSkills(dir, (line) => log.push(line));
  return { skills, log };
}

test("a package skill carries its SKILL.md and its sibling files", async () => {
  const dir = world();
  write(
    dir,
    "research/SKILL.md",
    "---\ndescription: Research a topic before answering.\n---\n\nGather evidence first.\n",
  );
  write(dir, "research/references/checklist.md", "# Checklist\n\n- sources\n");
  write(dir, "research/scripts/run.py", "print('hi')\n");

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["research"]);
  const skill = skills.research;
  assert.equal(skill.description, "Research a topic before answering.");
  assert.match(skill.markdown, /Gather evidence first\./u);
  assert.deepEqual(Object.keys(skill.files ?? {}).sort(), [
    "references/checklist.md",
    "scripts/run.py",
  ]);
  assert.equal(
    Buffer.from(skill.files?.["references/checklist.md"] ?? []).toString(
      "utf8",
    ),
    "# Checklist\n\n- sources\n",
  );
  assert.deepEqual(log, []);
});

test("SKILL.md itself never lands in files: eve generates it", async () => {
  const dir = world();
  write(dir, "solo/SKILL.md", "---\ndescription: Solo.\n---\n\nBody.\n");

  const { skills } = await read(dir);
  assert.equal(skills.solo.files, undefined);
});

test("package siblings keep their bytes and their POSIX path", async () => {
  const dir = world();
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  write(
    dir,
    "assets/SKILL.md",
    "---\ndescription: Assets.\n---\n\nUse them.\n",
  );
  write(dir, "assets/deep/nested/logo.bin", bytes);

  const { skills } = await read(dir);
  assert.deepEqual(Object.keys(skills.assets.files ?? {}), [
    "deep/nested/logo.bin",
  ]);
  assert.deepEqual(
    Buffer.from(skills.assets.files?.["deep/nested/logo.bin"] ?? []),
    Buffer.from(bytes),
  );
});

test("a flat .md skill is named after the file", async () => {
  const dir = world();
  write(dir, "forecast.md", "# Forecast\n\nCall the weather tool first.\n");

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["forecast"]);
  assert.equal(
    skills.forecast.markdown,
    "# Forecast\n\nCall the weather tool first.\n",
  );
  assert.equal(skills.forecast.files, undefined);
  assert.deepEqual(log, []);
});

test("both forms live in one directory", async () => {
  const dir = world();
  write(dir, "flat.md", "Flat one.\n");
  write(
    dir,
    "packaged/SKILL.md",
    "---\ndescription: Packaged.\n---\n\nBody.\n",
  );

  const { skills } = await read(dir);
  assert.deepEqual(Object.keys(skills).sort(), ["flat", "packaged"]);
});

test("description: frontmatter wins, then the first meaningful line, then the fallback", async () => {
  const dir = world();
  write(
    dir,
    "declared.md",
    "---\ndescription: Declared plainly.\n---\n\n# Title\n",
  );
  write(
    dir,
    "titled.md",
    "```\ncode fence first\n```\n\n> ## Reads the fence-free line\n",
  );
  write(dir, "blank.md", "\n\n");
  write(dir, "long.md", `${"a".repeat(400)}\n`);

  const { skills } = await read(dir);
  assert.equal(skills.declared.description, "Declared plainly.");
  assert.equal(skills.titled.description, "Reads the fence-free line");
  assert.equal(skills.blank.description, "Instructions for the blank skill.");
  assert.equal(skills.long.description.length, 300);
  assert.ok(skills.long.description.endsWith("…"));
});

test("a missing directory is the quiet empty case", async () => {
  const { skills, log } = await read(join(world(), "nothing-here"));
  assert.deepEqual(skills, {});
  assert.deepEqual(log, []);
});

test("an empty directory yields an empty map", async () => {
  const { skills, log } = await read(world());
  assert.deepEqual(skills, {});
  assert.deepEqual(log, []);
});

test("an unreadable directory is reported once, not thrown", async () => {
  const dir = world();
  const locked = join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const { skills, log } = await read(locked);
    assert.deepEqual(skills, {});
    assert.equal(log.length, 1);
    assert.match(log[0], /^\[skills\] custom skills unreadable: /u);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("a package without SKILL.md is skipped, the neighbours are not", async () => {
  const dir = world();
  write(dir, "broken/readme.md", "no skill here\n");
  write(dir, "good/SKILL.md", "---\ndescription: Good.\n---\n\nBody.\n");
  mkdirSync(join(dir, "empty-dir"));

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["good"]);
  assert.deepEqual(log.sort(), [
    "[skills] custom skill broken skipped: no SKILL.md",
    "[skills] custom skill empty-dir skipped: no SKILL.md",
  ]);
});

test("an unreadable SKILL.md is skipped, the neighbours are not", async () => {
  const dir = world();
  write(dir, "locked/SKILL.md", "---\ndescription: Locked.\n---\n\nBody.\n");
  write(dir, "open/SKILL.md", "---\ndescription: Open.\n---\n\nBody.\n");
  chmodSync(join(dir, "locked/SKILL.md"), 0o000);
  try {
    const { skills, log } = await read(dir);
    assert.deepEqual(Object.keys(skills), ["open"]);
    assert.equal(log.length, 1);
    assert.match(log[0], /^\[skills\] custom skill locked skipped: /u);
  } finally {
    chmodSync(join(dir, "locked/SKILL.md"), 0o600);
  }
});

test("an unreadable sibling file drops the file, not the skill", async () => {
  const dir = world();
  write(dir, "half/SKILL.md", "---\ndescription: Half.\n---\n\nBody.\n");
  write(dir, "half/references/open.md", "readable\n");
  write(dir, "half/references/locked.md", "secret\n");
  chmodSync(join(dir, "half/references/locked.md"), 0o000);
  try {
    const { skills, log } = await read(dir);
    assert.deepEqual(Object.keys(skills.half.files ?? {}), [
      "references/open.md",
    ]);
    assert.equal(log.length, 1);
    assert.match(
      log[0],
      /^\[skills\] custom skill half file references\/locked\.md skipped: /u,
    );
  } finally {
    chmodSync(join(dir, "half/references/locked.md"), 0o600);
  }
});

test("names eve would refuse are skipped: unicode, spaces, leading dot", async () => {
  const dir = world();
  write(dir, "привет.md", "Cyrillic name.\n");
  write(dir, "two words.md", "Spaced name.\n");
  write(dir, ".hidden.md", "Dotted name.\n");
  write(dir, "плохой/SKILL.md", "---\ndescription: Bad.\n---\n\nBody.\n");
  write(dir, "fine.md", "Fine.\n");

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["fine"]);
  assert.equal(log.length, 4);
  for (const line of log)
    assert.match(line, /skipped: name must match \^\[A-Za-z0-9\]/u);
});

test("files that are not .md are ignored without noise", async () => {
  const dir = world();
  write(dir, ".DS_Store", "junk\n");
  write(dir, "notes.txt", "not a skill\n");
  write(dir, "real.md", "Real.\n");

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["real"]);
  assert.deepEqual(log, []);
});

test("a package beats a flat file of the same name", async () => {
  const dir = world();
  write(
    dir,
    "twin/SKILL.md",
    "---\ndescription: From the package.\n---\n\nBody.\n",
  );
  write(dir, "twin.md", "From the flat file.\n");

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["twin"]);
  assert.equal(skills.twin.description, "From the package.");
  assert.deepEqual(log, [
    "[skills] custom skill twin skipped: twin.md loses to twin",
  ]);
});

test("a symlinked package is read through the link", async () => {
  const dir = world();
  const elsewhere = world();
  write(
    elsewhere,
    "linked/SKILL.md",
    "---\ndescription: Linked.\n---\n\nBody.\n",
  );
  symlinkSync(join(elsewhere, "linked"), join(dir, "linked"), "dir");
  symlinkSync(join(elsewhere, "gone"), join(dir, "dangling.md"));

  const { skills, log } = await read(dir);
  assert.deepEqual(Object.keys(skills), ["linked"]);
  assert.deepEqual(log, []);
});

test("customSkillsDir follows ASSISTANT_DATA_DIR", () => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  try {
    process.env.ASSISTANT_DATA_DIR = "/srv/iva/data";
    assert.equal(customSkillsDir(), "/srv/iva/data/custom/agent/skills");
    process.env.ASSISTANT_DATA_DIR = "data";
    assert.equal(
      customSkillsDir(),
      join(process.cwd(), "data/custom/agent/skills"),
    );
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
});

// --- Живые скиллы: свой Custom layer плюс включённые плагины (ADR-0009) ---------

function pluginEntry(name: string, enabled = true): PluginEntry {
  return {
    name,
    source: `./${name}`,
    ref: "",
    sha: "",
    digest: "",
    enabled,
    trusted: false,
    installedAt: "2026-08-17T10:00:00.000Z",
  };
}

/** Временный data-каталог: плагины в сторе, состояние в plugins.json. */
async function liveWorld(
  plugins: readonly PluginEntry[],
  plant: (data: string) => void,
): Promise<string> {
  const data = world();
  plant(data);
  if (plugins.length)
    await writePluginsState(data, { marketplaces: [], plugins });
  return data;
}

/** Читает живые скиллы так, как их прочитает ход: через ASSISTANT_DATA_DIR. */
async function live(data: string) {
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  const log: string[] = [];
  try {
    return { skills: await readLiveSkills((line) => log.push(line)), log };
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
}

test("a skill of an enabled plugin is visible on the next turn, with no build", async () => {
  const data = await liveWorld([pluginEntry("trace")], (dir) => {
    write(
      dir,
      "custom/plugins/trace/skills/viewer/SKILL.md",
      "---\nname: viewer\ndescription: Show one turn.\n---\n\nOpen the trace.\n",
    );
    write(
      dir,
      "custom/plugins/trace/skills/viewer/references/format.md",
      "# format\n",
    );
    write(
      dir,
      "custom/agent/skills/own.md",
      "---\ndescription: Mine.\n---\n\nBody.\n",
    );
  });

  const { skills, log } = await live(data);
  assert.deepEqual(Object.keys(skills).sort(), ["own", "viewer"]);
  assert.equal(skills.viewer.description, "Show one turn.");
  assert.deepEqual(Object.keys(skills.viewer.files ?? {}), [
    "references/format.md",
  ]);
  assert.deepEqual(log, []);
});

test("a disabled plugin contributes nothing", async () => {
  const data = await liveWorld([pluginEntry("trace", false)], (dir) => {
    write(
      dir,
      "custom/plugins/trace/skills/viewer/SKILL.md",
      "---\nname: viewer\ndescription: Show one turn.\n---\n\nBody.\n",
    );
  });

  const { skills, log } = await live(data);
  assert.deepEqual(Object.keys(skills), []);
  assert.deepEqual(log, []);
});

test("two plugins claiming one skill name: the first keeps it, the loss is logged", async () => {
  const data = await liveWorld(
    [pluginEntry("alpha"), pluginEntry("beta")],
    (dir) => {
      for (const plugin of ["alpha", "beta"])
        write(
          dir,
          `custom/plugins/${plugin}/skills/viewer/SKILL.md`,
          `---\nname: viewer\ndescription: From ${plugin}.\n---\n\nBody.\n`,
        );
    },
  );

  const { skills, log } = await live(data);
  assert.deepEqual(Object.keys(skills), ["viewer"]);
  assert.equal(skills.viewer.description, "From alpha.");
  assert.deepEqual(log, [
    "[skills] plugin skill viewer from beta skipped: alpha already provides it",
  ]);
});

test("the owner's own skill wins over a plugin skill of the same name", async () => {
  const data = await liveWorld([pluginEntry("trace")], (dir) => {
    write(
      dir,
      "custom/plugins/trace/skills/viewer/SKILL.md",
      "---\nname: viewer\ndescription: From the plugin.\n---\n\nBody.\n",
    );
    write(
      dir,
      "custom/agent/skills/viewer/SKILL.md",
      "---\ndescription: Mine.\n---\n\nBody.\n",
    );
  });

  const { skills, log } = await live(data);
  assert.equal(skills.viewer.description, "Mine.");
  assert.deepEqual(log, [
    "[skills] plugin skill viewer from trace shadowed by data/custom/agent/skills",
  ]);
});

test("a plugin skill without frontmatter is not served, exactly as the reader says", async () => {
  const data = await liveWorld([pluginEntry("trace")], (dir) => {
    // Тот же скилл, что отверг бы `iva plugin add`: без frontmatter он не скилл
    // по спеке Agent Skills, и агенту его видеть нельзя — иначе гейт коллизий на
    // установке проверяет один набор, а ход грузит другой.
    write(
      dir,
      "custom/plugins/trace/skills/loose/SKILL.md",
      "Just a body, no frontmatter.\n",
    );
    write(
      dir,
      "custom/plugins/trace/skills/named/SKILL.md",
      "---\nname: named\ndescription: Proper.\n---\n\nBody.\n",
    );
    write(
      dir,
      "custom/plugins/trace/skills/привет/SKILL.md",
      "---\nname: hi\ndescription: Unicode name.\n---\n\nBody.\n",
    );
    write(
      dir,
      "custom/plugins/trace/plugin.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "trace",
      }),
    );
  });

  const { skills, log } = await live(data);
  assert.deepEqual(Object.keys(skills), ["named"]);
  const fromReader = await readPlugin(join(data, "custom/plugins/trace"));
  assert.deepEqual(
    fromReader.skills.map((skill) => skill.name),
    Object.keys(skills),
    "the reader and the live resolver must list the same skills",
  );
  assert.deepEqual(log, [
    "[skills] plugin trace: skills/loose: skipped: SKILL.md has no frontmatter",
    "[skills] plugin trace: skills/привет: skipped: name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$",
  ]);
});

test("a plugin skills directory keeps the package form only", async () => {
  const data = await liveWorld([pluginEntry("trace")], (dir) => {
    write(
      dir,
      "custom/plugins/trace/skills/good/SKILL.md",
      "---\nname: good\ndescription: Good.\n---\n\nBody.\n",
    );
    write(
      dir,
      "custom/plugins/trace/skills/flat.md",
      "---\ndescription: Flat.\n---\n",
    );
    write(dir, "custom/plugins/trace/skills/empty/notes.md", "no skill here\n");
  });

  const { skills, log } = await live(data);
  assert.deepEqual(Object.keys(skills), ["good"]);
  assert.deepEqual(log, [
    "[skills] plugin trace: skills/empty: skipped: no SKILL.md",
  ]);
});

test("no plugins.json at all leaves the own custom layer untouched", async () => {
  const data = await liveWorld([], (dir) => {
    write(
      dir,
      "custom/agent/skills/own.md",
      "---\ndescription: Mine.\n---\n\nBody.\n",
    );
  });

  const { skills, log } = await live(data);
  assert.deepEqual(Object.keys(skills), ["own"]);
  assert.deepEqual(log, []);
});

test("a damaged plugins.json costs no skills, says so once, and is never touched", async () => {
  const data = world();
  write(data, "custom/plugins.json", "{ broken");
  write(
    data,
    "custom/agent/skills/own.md",
    "---\ndescription: Mine.\n---\n\nBody.\n",
  );
  write(
    data,
    "custom/plugins/trace/skills/viewer/SKILL.md",
    "---\nname: viewer\ndescription: From the plugin.\n---\n\nBody.\n",
  );

  const first = await live(data);
  assert.deepEqual(Object.keys(first.skills), ["own"]);
  assert.equal(first.log.length, 1);
  assert.match(first.log[0], /not valid JSON/u);

  // Второй ход: файл на месте, байт в байт, и второй строки в логе нет.
  const second = await live(data);
  assert.deepEqual(Object.keys(second.skills), ["own"]);
  assert.deepEqual(second.log, []);
  assert.equal(readFileSync(pluginsStateFile(data), "utf8"), "{ broken");
  assert.deepEqual(readdirSync(join(data, "custom")).sort(), [
    "agent",
    "plugins",
    "plugins.json",
  ]);
});
