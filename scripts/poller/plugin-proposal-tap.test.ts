/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Тап «Установить» глазами моста: что забирается, что запускается и что слышит владелец.
// Кто тапнул и где — граница control.ts (control.test.ts); сюда доходит только владелец.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pluginTreeDigest } from "#lib/plugin-reader.ts";
import {
  findProposal,
  PROPOSAL_TTL_MS,
  proposalFolder,
  proposalsDir,
  takenDir,
} from "../lib/plugin-proposal.ts";

process.env.TELEGRAM_BOT_TOKEN ??= "424242:test-token";
const { handlePluginProposalTap } = await import("./plugin-proposal-tap.ts");

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const homes: string[] = [];
after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

async function world() {
  const data = mkdtempSync(join(tmpdir(), "iva-plugin-tap-"));
  homes.push(data);
  const dir = proposalsDir(data);
  const staging = join(dir, ".staging-relay");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "plugin.json"), '{"name":"relay"}');
  writeFileSync(join(staging, "mcp.json"), "{}");
  const digest12 = (await pluginTreeDigest(staging)).slice(0, 12);
  const folder = join(dir, proposalFolder("relay", digest12));
  renameSync(staging, folder);
  utimesSync(folder, new Date(NOW), new Date(NOW));
  const launches: Array<[string, readonly string[]]> = [];
  const replies: Array<[number, string]> = [];
  let launchResult = { ok: true, msg: "" };
  const deps = {
    dataDir: data,
    now: () => NOW,
    translate: (english: string) => english,
    replyImpl: (chat: number, text: string) => {
      replies.push([chat, text]);
      return Promise.resolve();
    },
    launch: (unit: string, args: readonly string[]) => {
      launches.push([unit, args]);
      return Promise.resolve(launchResult);
    },
  };
  return {
    dir,
    folder,
    digest12,
    launches,
    replies,
    deps,
    failLaunch: (msg: string) => {
      launchResult = { ok: false, msg };
    },
    succeedLaunch: () => {
      launchResult = { ok: true, msg: "" };
    },
  };
}

test("a tap on a fresh proposal takes the copy and starts the installer in its own unit", async () => {
  const w = await world();

  await handlePluginProposalTap({ digest12: w.digest12, chatId: 42 }, w.deps);

  assert.deepEqual(w.launches, [
    ["iva-plugin-install", ["plugin", "install-proposal", w.digest12]],
  ]);
  assert.deepEqual(w.replies, [], "the installer reports the result itself");
  assert.ok(existsSync(takenDir(w.dir, w.digest12)));
  assert.equal(findProposal(w.dir, w.digest12), null);
});

test("two taps in a row: one installer, the second tap hears the proposal is out of date", async () => {
  const w = await world();

  await handlePluginProposalTap({ digest12: w.digest12, chatId: 42 }, w.deps);
  await handlePluginProposalTap({ digest12: w.digest12, chatId: 42 }, w.deps);

  assert.equal(w.launches.length, 1);
  assert.deepEqual(w.replies, [
    [42, "Plugin relay was not installed: the proposal is out of date"],
  ]);
});

test("a tap with no proposal behind it installs nothing", async () => {
  const w = await world();

  await handlePluginProposalTap(
    { digest12: "ffffffffffff", chatId: 42 },
    w.deps,
  );

  assert.deepEqual(w.launches, []);
  assert.deepEqual(w.replies, [
    [42, "Plugin ffffffffffff was not installed: the proposal is out of date"],
  ]);
});

test("files swapped after propose: the tree hash does not match and nothing starts", async () => {
  const w = await world();
  writeFileSync(join(w.folder, "mcp.json"), '{"mcpServers":{"x":{}}}');

  await handlePluginProposalTap({ digest12: w.digest12, chatId: 42 }, w.deps);

  assert.deepEqual(w.launches, []);
  assert.match(w.replies[0][1], /relay was not installed: .*out of date/u);
  assert.equal(existsSync(takenDir(w.dir, w.digest12)), false);
});

test("a proposal older than a day is out of date", async () => {
  const w = await world();

  await handlePluginProposalTap(
    { digest12: w.digest12, chatId: 42 },
    { ...w.deps, now: () => NOW + PROPOSAL_TTL_MS + 1 },
  );

  assert.deepEqual(w.launches, []);
  assert.match(w.replies[0][1], /out of date/u);
});

test("an installer that does not start says why and puts the proposal back for another tap", async () => {
  const w = await world();
  w.failLaunch("Failed to connect to bus");

  await handlePluginProposalTap({ digest12: w.digest12, chatId: 42 }, w.deps);

  assert.deepEqual(w.replies, [
    [42, "Plugin relay was not installed: Failed to connect to bus"],
  ]);
  assert.equal(findProposal(w.dir, w.digest12), "relay");
  assert.equal(existsSync(takenDir(w.dir, w.digest12)), false);

  w.succeedLaunch();
  await handlePluginProposalTap({ digest12: w.digest12, chatId: 42 }, w.deps);
  assert.equal(w.launches.length, 2);
});

test("a failed installer start does not extend the proposal: a tap at +20 h puts it back, a tap at +40 h finds it out of date", async () => {
  const w = await world();
  const HOUR = 60 * 60 * 1000;
  w.failLaunch("Failed to connect to bus");

  await handlePluginProposalTap(
    { digest12: w.digest12, chatId: 42 },
    { ...w.deps, now: () => NOW + 20 * HOUR },
  );
  assert.equal(findProposal(w.dir, w.digest12), "relay", "put back");

  w.succeedLaunch();
  await handlePluginProposalTap(
    { digest12: w.digest12, chatId: 42 },
    { ...w.deps, now: () => NOW + 40 * HOUR },
  );

  assert.equal(w.launches.length, 1, "the second tap starts nothing");
  assert.match(
    w.replies[1]?.[1] ?? "",
    /relay was not installed: .*out of date/u,
  );
});
