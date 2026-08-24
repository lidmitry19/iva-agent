<p align="right"><b>EN</b> · <a href="./README.ru.md">RU</a></p>

<div align="center">

<img src="assets/iva-header.webp" alt="Iva — self-hosted Telegram AI assistant with layered memory" width="100%">

[![Release](https://img.shields.io/github/v/release/smixs/iva-agent?color=brightgreen)](https://github.com/smixs/iva-agent/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![built on eve](https://img.shields.io/badge/built%20on-eve-000000?logo=vercel&logoColor=white)](https://eve.dev/docs/introduction)
[![Node 24](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Last release](https://img.shields.io/github/release-date/smixs/iva-agent?label=last%20release&color=informational)](https://github.com/smixs/iva-agent/releases)

[Site](https://iva-agent.com) · [Use cases](#why-people-run-iva) · [Features](#features) · [Install](#install) · [Memory](#the-memory-tree) · [What's new](#whats-new) · [Docs](#documentation)

</div>

---

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. You talk, it files: voice notes, photos, forwarded posts and decisions become plain-markdown cards it actually remembers. Everything runs on your own server, with your keys and your data.

**One command installs it:**

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

## Why people run Iva

- "What did we agree with client X about the last shipment?" — found in seconds, months later.
- A five-minute voice note from the car → a task list, a draft email, a meeting card.
- "Make a quote from this price list, cut the discount by 2.5%, send it to the client" — a finished Google Doc, link in the chat.

The rest — for business owners, specialists, executives and everyday life: **[Use cases](docs/use-cases.md)**.

## How it works

<img src="assets/iva-flow.webp" alt="How Iva works: voice, text, photos and PDFs fly from Telegram into the willow-tree agent, wired to memory, nightly rollup, cron, reminders, search, web, workspace and docs" width="100%">

The bridge long-polls Telegram, so no public HTTPS, domain or webhook is needed. Iva runs as two systemd user services, two systemd watchdog timers and five in-process eve schedules — operations live in [docs/deploy.md](docs/deploy.md).

**Wondering what you'd actually use an agent for?** → [25+ real scenarios — business, work, everyday life](docs/use-cases.md).

<img src="assets/iva-use-cases.webp" alt="What people ask Iva: eight everyday requests, from a voice note turned into tasks to research with sources and a bedtime story that continues tomorrow" width="100%">

## Features

<details>
<summary><b>Voice, vision, memory, personal CRM, Google Workspace, skills — expand the full list</b></summary>

- **Voice** — voice, audio and video notes transcribed with Deepgram nova-3; auto-detects ru/uz/en.
- **Vision** — photos described by your provider's own vision model; no extra key, no extra bill.
- **Rich replies** — tables, checklists, collapsible blocks and formulas render natively in Telegram via Bot API 10.1 rich messages; plain formatting keeps its proven path, with a graceful fallback.
- **Quiet update checks** — once a day Iva checks for a newer stable release without spending model tokens. If one exists, Telegram offers **Update** or **Later** once; otherwise it says nothing.
- **Layered memory** — remembers across months, long after the chat window has scrolled away.
- **Personal CRM** — who your people are, what you agreed, when to follow up.
- **Search by meaning** — BM25 plus link-graph rerank, any language; optional vector mode with one key.
- **Decision cards** — what you chose, when and why; old versions stay in a dated History.
- **Tasks & reminders** — priorities, due dates and a morning digest.
- **Web search** — four pluggable providers: Tavily, Exa, Parallel or Brave.
- **Google Workspace** — Gmail, Calendar, Drive, Sheets, Docs and Tasks from chat via the `gws` CLI; installed for you, with a guided key setup right in the conversation.
- **Skills & MCP** — drop one file to add a procedure or connect an MCP server; keys stay in `.env`.
- **Personal Telegram — userbot (beta)** — read and send from your _own_ account, not just the bot; connect by chat (QR, no terminal). Rough and buggy — opt-in, **at your own risk**. A server-side anti-ban guardrail (FloodWait compliance + randomized pacing + circuit-breaker) is enforced, not just advised. [Details](docs/userbot.md).
- **Safe to forward** — forwarded text, captions and voice transcripts pass an injection screen before the model reads them. A flagged message or transcript reaches the model tagged as data rather than as an instruction; for media captions the screen runs but the tag does not travel with it yet.
- **Token accounting** — every model step is logged; `/usage` reports it for free.

</details>

## The Memory Tree

<img src="assets/iva-memory-tree.webp" alt="How Iva remembers: a leaf is a day, branches are weeks and months, tree rings are years around CORE.md" width="100%">

| Layer       | What lives there                                                                                    | Path                                                 |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 🍃 Leaves   | the word-for-word transcript of each day, Iva's replies included                                    | `daily/YYYY-MM-DD.md`                                |
| 🌿 Branches | summaries folded upward: day → week → month → year                                                  | `summaries/daily/`, `weekly/`, `monthly/`, `yearly/` |
| 🪵 Trunk    | `CORE.md` (≤1200 chars, in every prompt) + typed cards: contacts, projects, decisions, ideas, notes | `CORE.md`, `cards/`                                  |

- Every message lands verbatim in a daily markdown log — nothing is paraphrased on arrival.
- A nightly rollup at 04:00 distills day → week → month → year into schema-validated cards; facts that change get rewritten, not piled up.
- One core file, `CORE.md` (≤1,200 chars), rides in every prompt — Iva knows you before it searches anything.

Full architecture and search internals: [docs/memory.md](docs/memory.md).

## A secretary inside Telegram

<img src="assets/iva-userbot.webp" alt="Your secretary inside Telegram: the userbot reads group chats from your own account, collects summaries and replies as you, guarded by a server-enforced anti-ban guardrail" width="100%">

The bot is half of Telegram. The other half is your personal account: connect the userbot (beta, opt-in) and Iva works from it like a secretary — reads the group chats you never keep up with, folds them into summaries, catches the messages that actually need you, and replies as you.

- **All of Telegram** — groups, channels, unreads, search and the full history of your personal account.
- **Onboarding in chat** — tell the bot to connect your Telegram, scan a QR. No terminal.
- **Anti-ban guardrail on the server** — FloodWait compliance, a randomized delay after every send, and a circuit-breaker that pauses sending after three FloodWaits in 24 hours. It is enforced in the proxy rather than asked for in a prompt, and it wraps the three outbound calls that actually get accounts flagged: messages, files, forwards. Joins, invites, contact imports and reactions are not wrapped — those limits live in the skill file, which is a prompt.
- **Read-only mode** — one `.env` switch and Iva can read and search but physically cannot send.

> [!WARNING]
> Automating a personal account is against Telegram's ToS and can get the account limited or banned. The userbot is opt-in, beta, and used at your own risk — reading is far safer than sending. Details: [docs/userbot.md](docs/userbot.md).

## Security & privacy

<img src="assets/iva-security-gate.webp" alt="Untrusted input from Telegram and the web passes the security gate: corrupted messages drop into the reject tray, only clean context reaches the vault" width="100%">

Web pages, search results, voice transcripts, captions and the vision model's description of a picture reach the model only through a prompt-injection sanitizer. On a forwarded text message the same gate annotates the turn with a warning instead of filtering the text, and document bodies, userbot-read chats and `agent-browser` output are not screened at all. Everything that leaves through the Outbox passes a secret-redaction gate, and the user allowlist fails closed — an empty list answers nobody. Your memory is a private git repo you own; the honest boundary is that the model and transcription are cloud APIs you choose and pay for. Gate internals and the full boundary: [docs/security.md](docs/security.md).

## Install

One command on any Ubuntu/Debian box — a fresh VPS or your own machine:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. Run the installer and answer its questions.
3. Message your bot. The wizard picks your Telegram ID out of that message, finishes setup, and Iva confirms right in the chat that it's live.

Brand-new VPS, still logged in as root? Run `bash <(curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/bootstrap.sh)` first: it creates your sudo user (with lingering enabled), updates the box, and turns on a firewall, fail2ban and SSH hardening. It asks three things — a login, its password, and the timezone — and no SSH key. Then log in as that user with that password and run the installer above. Details: [docs/install.md](docs/install.md).

Install as a normal user, not as root — Iva's shell tool runs as whoever installed it. Headless installs take `--skip-setup` or `--non-interactive`. Prefer to read before you run? Fetch it with `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh -o install.sh`, read it, then `bash install.sh`. Wizard walkthrough and an SSH primer for first-time VPS owners: [docs/install.md](docs/install.md).

### The first minute

Three messages, and you can watch the memory work:

1. Send a voice note about your day — anything, out loud. Then look in `daily/` inside your vault on the server: your words are sitting there in plain markdown, dated, yours. No other assistant hands you the file.
2. Tell it something a colleague would remember: `Marina at Acme wants the revised quote by Friday — she never picks up the phone.`
3. Ask for it back the way a person would: `how should I follow up with Marina?` — the answer comes from the card Iva just wrote, not from the last few messages.

Then send a photo of a business card, or forward a long post and ask for the gist. `/menu` has the rest; the full list is in [25+ scenarios](docs/use-cases.md).

<details>
<summary><b>Install from a clone — build it yourself</b></summary>

```bash
git clone https://github.com/smixs/iva-agent.git ~/iva
cd ~/iva && bash install.sh
```

The installer reuses the existing checkout instead of re-cloning, keeps `.env` and the vault untouched, and installs the same dependencies. A fork or a branch works through variables read at startup: `REPO_URL=…`, `BRANCH=…`, `INSTALL_DIR=…` (defaults: this repo, `main`, `~/iva`). Details: [docs/install.md](docs/install.md).

</details>

## Providers & cost

Four model providers. Pick one and fill its block in `.env`:

| Provider         | How you pay                            |
| ---------------- | -------------------------------------- |
| OpenCode Go      | API key, ~$10/mo ($5 first month)      |
| Ollama Cloud     | API key, ~$20/mo                       |
| OpenRouter       | API key, pay-as-you-go, 300+ models    |
| OpenAI (ChatGPT) | your Plus/Pro subscription, no API key |

Default model is deepseek-v4-pro, 131k context. On Go it runs about $14–15/mo all-in ($10 model + $4–5 VPS; the model's first month is $5), no markup; voice rides Deepgram's free starter credit. Model lists, limits and the search matrix: [docs/providers.md](docs/providers.md).

## Documentation

[Use cases](docs/use-cases.md) · [Install](docs/install.md) · [Configuration](docs/configuration.md) · [Memory](docs/memory.md) · [Providers](docs/providers.md) · [Security](docs/security.md) · [Deploy](docs/deploy.md) · [Commands & CLI](docs/cli.md) · [Menu](docs/menu.md) · [Extending](docs/extending.md) · [Plugins](docs/plugins.md) · [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)

Документация на русском → [docs/ru/](docs/ru/)

## What's New

<details>
<summary><b>v0.3.31 · 24.08.2026 — expand the latest releases</b></summary>

### 24.08.2026

#### v0.3.31

- A reply to an old bot message no longer hangs the bot: sessions close all the time (nightly reset, rotation, `/new`, an update restart), and a Telegram reply quoting a message from a closed session was routed as a continuation of it. Delivery failed with `target session was not found via continuation token`, the item stayed in the inbox queue, and the poller retried it every cycle — hundreds of failures, the bot answering no one (#203). Now such a reply is delivered once as an ordinary new message (the quote loses its old context, the user gets an answer), and that failure class can no longer keep an item in the queue. A transient failure — eve restarting, a timeout — retries exactly as before, so no message is lost.

#### v0.3.30

- An old CLI stops instead of breaking: `iva update` runs on the installed code, and a unit-template token that old code does not know (`__DATA_DIR_ENV__`-class breakage, #191) used to fail the update three times in a row. The repo now carries `update-compat.json` with the oldest CLI release able to install it; an older updater stops before touching anything and prints the way out: `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash` — data and `.env` stay in place. The same hint goes to Telegram: in the update reply and in the daily new-version notice. Troubleshooting gains the section.
- `repair.sh` proves the service is up before saying so: it used to print `Iva is repaired and updated.` as soon as the restart command was accepted, which a unit in a restart loop grants every time. New `iva _await-healthy` waits — with the same 90-second budget an update allows — until `iva.service` is active and answers on its own port, and fails at once when systemd has given up. On failure the script names the journal command, keeps the backup and exits non-zero (#191).

#### v0.3.29

- Install no longer loses `agent-browser` and `gws` on a fresh VPS: the verified download landed in a `mktemp` file with no extension, npm 11 read that path as a package directory and died with `ENOTDIR … /package.json`. The tarball now downloads into its own private directory under its published name (`agent-browser-0.34.0.tgz`, `cli-0.22.5.tgz`); the SHA-256 check still runs before anything reaches npm, and the directory is removed after (#197).
- The agent reads its memory again: `10-map.md` told the model to call `read_file` with `vault/summaries/daily/…`, while the tool resolves a relative path against the vault root — the result was `vault/vault/…` and ENOENT on every day summary. Every model-facing memory path is now vault-relative (`CORE.md`, `summaries/daily/…`, `cards/…`, the same shape `memory_search` returns), the nightly rollup hands the model absolute paths, and a guard test fails on any instruction that brings the prefix back (#199).
- CORE.md is edited, not rewritten: the nightly rollup used to rewrite the whole file from the template, and a section the owner added by hand could vanish overnight. Now the rollup edits single lines only when the day produced a durable fact, preference, goal or lesson; a day with nothing new leaves the file byte-identical; sections outside the template stay verbatim. The «last day» pointer is written by code after the turn. If a `## ` heading present before the turn is gone after it, the previous file is restored and one Alert names the lost heading (#201).
- Forwarded messages carry their origin: a repost used to reach the model as the owner's own words. The first line of the text now says `[forwarded from @user]`, `[forwarded from channel Title (@name)]` or `[forwarded (hidden sender: Name)]` — the same line in the context and in the daily log; source names are stripped of brackets and line breaks so a channel title cannot forge a label. The allowlist is untouched: access is still decided by the actual sender (#195).
- Three contributor fixes to the update rails: recovery keeps the permissions it captured, so a group-writable tree (`664/775` under `umask 002`) no longer fails every `iva update` with `git recovery snapshot permissions do not match` and `Rollback: FAILED` (#196); a failed update drops its recovery stash the way a successful one does, so stale stashes stop piling up in `git stash list` (#200); the isolated build promotes `.eve/agent-summary.json` alongside `.output`, so `/menu → Skills` no longer says «Skill list is unavailable» after every update (#198).

### 19.08.2026

#### v0.3.28

- The update cleans up after itself: the disk keeps the running version and one rollback, everything else goes. Before a build only the running version stays — the build takes the rollback slot, so the peak is two versions (~400 MB each), not three. In the finish, removing old versions is the first step, ahead of `npm i -g @googleworkspace/cli@latest`, which downloads onto the same disk; a failed cleanup chore no longer cancels it. `iva doctor` removes leftovers of interrupted builds and surplus versions by itself, under the update lock, and prints `versions on disk: N (current …, rollback …) — X GB free`; with an update running it says `version cleanup skipped`, with a corrupt `active.json` it reports and deletes nothing. The cleanup before a build starts working from the update after this one — `iva update` runs on the installed CLI. Prompted by a test droplet with 8.7 GB that stalled on three copies of `node_modules` (#194). New troubleshooting section «Disk full during update», an honest disk line in install.
- The promoted runtime carries every source tree: the stable runtime snapshot copied `agent/` and `scripts/` by hand, `packages/` never reached it, and on an install with a non-empty custom layer the agent died with `[UNRESOLVED_IMPORT]` on `agent/lib/data-dir.ts` in a restart loop. One list now — `RUNTIME_SOURCE_TREES` — feeds both the snapshot and the replica smoke, the layout digest moves to v3 so a runtime staged without `packages/` rebuilds itself, and a guard test resolves every import of those trees and fails on a tree the snapshot would leave behind (#192, #191).
- Timezones come back in canonical spelling: Intl accepted `europe/moscow` in `.env`, systemd rejected `OnCalendar=*-*-* 05:00:00 europe/moscow`, and the nightly timer never came up. The validator now returns what Intl resolves — `Europe/Moscow`; aliases canonicalize (`US/Pacific` → `America/Los_Angeles`); property tests pin idempotence and insensitivity to case and padding (#190).
- A vision model per provider: instead of a constant in code, a variable in `.env` each, blank meaning the provider default — `OLLAMA_VISION_MODEL` (`gemma4:31b`), `OPENCODE_VISION_MODEL` (`qwen3.7-plus`), `OPENROUTER_VISION_MODEL` (`google/gemini-2.5-flash`); Codex has none, the subscription is multimodal. `iva config` asks for the vision model right after the text model and writes it next to `*_MODEL`. The OpenCode Go default comes from live runs on 18.08: `gpt-5.6-luna` answers 400 to any image, `minimax-m3` wraps its answer in `<think>` inside `content`, `qwen3.7-plus` returns a clean description with OCR in 4–6 seconds.
- Three Telegram fixes: the Stop button only in private chats — its callback has been rejected in groups since the last release, and the button hung there dead. Messages buffered during a rolling update pass the inbound gate with the same warning to the model and the same `[security] inbound flagged` line as fresh ones — the verdict used to be ignored. Prose that looks like a code placeholder (`the price is  50  dollars`, tables with padded numbers) is no longer cut out of an HTML reply: the placeholder moved to the Private Use Area, such code points from outside are stripped first, and a seeded property test walks digits, space runs and code spans mixed in prose.

### 18.08.2026

#### v0.3.27

- MCP servers of a plugin, both transports: `streamable-http` and `sse` in `mcp.json` become a generated eve connection `mcp-<name>--<server>`, and `${VAR}` in a header is filled at run time from `data/custom/plugins/<name>.env`, so no token is baked into a build. `stdio` runs as the systemd unit `iva-mcp-<name>-<server>.service` behind Iva's own MCP proxy (`services/mcp-proxy/`, `@modelcontextprotocol/sdk`): the agent reaches it over `127.0.0.1:<port>/mcp` with a bearer, and the token lives in `data/plugin-data/<name>/mcp-<server>.token` at mode 0600. The server sees only `PATH`, `HOME`, `PLUGIN_ROOT`, `PLUGIN_DATA`, its own env from `mcp.json` and `<name>.env` — nothing of the agent's environment reaches it. A second switch joins the first: `trusted`, through `iva plugin trust | untrust`, and `add` prints the processes and asks `Start these processes on this machine? [y/N]` (`--trust` answers yes; a shell without a terminal answers no). Ports are handed out from 8730, once, and stay until the plugin is removed. Proven end to end against a real stdio server and a real client from the SDK, not fakes.
- Plugin services: `sh.iva/services/<svc>/service.json` with `{command,args,port}` becomes the unit `iva-plugin-<name>-<svc>.service` — env `IVA_SERVICE_PORT`, `IVA_DATA_DIR`, `PLUGIN_ROOT` and `PLUGIN_DATA`, the service's own folder as the working directory, started only while the plugin is enabled and trusted. `iva plugin update` restarts the units of a plugin whose content changed, `iva update` brings them back right after the flip, and `iva doctor` lists the units, prints `is-active` and calls `GET /health` on every MCP proxy. `sh.iva/` is now two kinds: an eve Extension (`sh.iva/package.json`, built into a version) and services, which never rebuild one.
- The default Marketplace is live — `smixs/iva-plugins`: the list sits at [github.com/smixs/iva-plugins](https://github.com/smixs/iva-plugins) and carries two plugins. `trace` is the Trace viewer: the schema of Iva with the path of a turn lit across it, the feed of turns, replay at ×1, ×2 and ×4, tiles for today, 7 and 14 days; it listens on loopback only, and `iva trace open` prints the ready ssh tunnel command. `hello` is the demo code plugin authors copy: one skill, one tool. Three commands to get there: `iva plugin add trace`, `iva plugin trust trace`, `iva trace open`. Checked live from the public list: `list --available`, `add trace` pinned to a sha, `update`, `remove`.
- Plugin docs: `docs/plugins.md` (Russian: `docs/ru/plugins.md`) — what a plugin is, how to install one (a folder, `owner/repo[/subdir][@ref]`, a git URL or a name from a Marketplace), how enabled differs from trusted, what `iva update` does to plugins, how to write your own (skills, an Extension under `sh.iva/`, `mcp.json`, services) and what you risk; `SECURITY.md` gains a Plugins section. Also: the `iva plugin` CLI is split into modules with no command changed, and on a development checkout `add` and `remove` of a code plugin stop promising a build that never happened and say plainly that no version was built there.

</details>

Full history — [CHANGELOG.md](CHANGELOG.md).

## Built on

[eve](https://eve.dev/docs/introduction) 0.30.8, Vercel's agent framework, runs the agent; Node 24's built-in SQLite runs the search index — no separate database. Iva grew out of [agent-second-brain](https://github.com/smixs/agent-second-brain) and [autograph](https://github.com/smixs/autograph) — that story is in [docs/memory.md](docs/memory.md).

## Thanks

Iva gets better because people run it for real — contributors are welcome. [Open an issue](https://github.com/smixs/iva-agent/issues) with what breaks, or send a PR. Everyone who already helped: [docs/thanks.md](docs/thanks.md).

## License

[MIT](LICENSE) — take it, change it, run it on a hundred servers; just don't blame anyone if something breaks.
