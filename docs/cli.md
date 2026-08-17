# Command reference

Iva has two control surfaces: slash commands in Telegram and the `iva` command on your server. This page is all of them.

## Telegram commands

| Command           | What it does                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/menu`           | The settings hub — model, search, language, character, memory, userbot, Google and more in one message ([menu.md](menu.md))                                                                                                                             |
| `/help`           | This list                                                                                                                                                                                                                                               |
| `/start`          | The greeting a new user gets on tapping **Start** — first steps, then points to `/help` and `/menu`. Handled by the bridge, never reaches the agent                                                                                                     |
| `/model`          | Wizard: provider → model → thinking level. Writes `.env`, then offers the restart that applies it. `ollama`, `opencode` and `codex` list what the account really exposes; `openrouter` shows a curated pick, since 300+ slugs do not fit inline buttons |
| `/think`          | The same wizard's last step alone — the thinking level for the model you already run                                                                                                                                                                    |
| `/stop`           | Interrupt the current turn — same as tapping the **⏹ Стоп** button                                                                                                                                                                                      |
| `/task <text>`    | Add a task; without text, Iva asks what to add                                                                                                                                                                                                          |
| `/tasks`          | Show the task list                                                                                                                                                                                                                                      |
| `/digest`         | Morning digest built by the morning-digest skill                                                                                                                                                                                                        |
| `/new`            | Start over — reset the current conversation                                                                                                                                                                                                             |
| `/restart`        | Reset the current conversation, then restart the agent process                                                                                                                                                                                          |
| `/update`         | Check for a new version; if there is one, tap **Update** to install it                                                                                                                                                                                  |
| `/usage [window]` | Token spend — variants below                                                                                                                                                                                                                            |

Two kinds here. `/task`, `/tasks` and `/digest` route into the agent and need it running.

Every turn starts with a status message carrying a **⏹ Стоп** button — tap it (or send `/stop`) to abort the turn mid-flight, Claude-Code style: completed work stays in the conversation history, the unfinished step is dropped. Messages sent while a turn is running are not processed immediately: the bridge queues them (you get a 👀 reaction), and they join the context of the next turn — triggered by your next message. `/menu`, `/help`, `/start`, `/usage`, `/restart`, `/new`, `/update`, `/model` and `/think` never reach the agent — the long-poll bridge handles them itself, out-of-band. `/menu` in particular is a whole settings surface that stays responsive even while a turn is running — its map and what applies instantly versus on restart live in [menu.md](menu.md). `/model` and `/think` are the same two wizards that **🧠 Model** and **🤔 Thinking** open there; `/think` needs a reasoning-capable provider (`ollama`, `opencode`, `codex`) and says so on the others.

`/new` retires only the exact Eve session for the current private chat, group conversation or forum topic. A private chat's queued messages are cleared with it. A group/topic queue is shared by several reply-anchored conversations, so those messages are preserved. Other chats keep their histories and queues. `/restart` performs the same scoped reset first and then restarts `iva.service`. Both commands work while a turn is running. The server-side `iva reset` remains the explicit break-glass command that quarantines the whole workflow store. The bridge accepts recovery commands only from IDs on the allowlist.

After upgrading a legacy group that has not recorded its Eve token yet, send `/new` as a reply to Iva's latest message once. Private chats and group conversations used after the upgrade need no migration step.

`/update` compares your install with the upstream repo. If a newer version exists, the same message gets **⬆️ Update** and **Later** buttons. After confirmation, that one message is edited through preservation, fetch, build and the final result — no phase messages are left behind. The active phase uses a small animated Telegram loader when the bot can send custom emoji and falls back to a simple `◇` otherwise. Build logs, diffs and commit IDs stay on the server. The detached updater survives the bridge restart. Nothing happens until you tap.

Independently, `iva-update-check.timer` checks upstream every day at 10:00 local time. It calls no model and says nothing unless a higher stable version exists. Each version is offered once in the digest chat with the same buttons; **Later** closes that offer, while manual `/update` always remains available.

### /usage variants

| Variant                   | Window                                         |
| ------------------------- | ---------------------------------------------- |
| `/usage` or `/usage last` | The last turn: tokens, steps, model, source    |
| `/usage today`            | Current day in your timezone                   |
| `/usage week`             | Last 7 days                                    |
| `/usage month`            | Current calendar month                         |
| `/usage by-model`         | Lifetime totals per model                      |
| `/usage by-source`        | Lifetime, chat vs background (rollups, digest) |

`/usage` costs zero tokens — the bridge reads the log, no model call.

## Server CLI

The installer puts `iva` in `~/.local/bin`. Commands that touch systemd need a Linux server.

| Command                            | What it does                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iva update [--force] [--verbose]` | Preserve tracked and untracked changes, safely fast-forward or rebase local commits, build, restart and health-check. On failure Iva rolls back to the recorded HEAD and previous `.output`. `--force` rebuilds with no new commits; `--verbose` streams technical output otherwise kept in `data/logs/` |
| `iva config`                       | The 5-step setup wizard, then offers a restart to apply                                                                                                                                                                                                                                                  |
| `iva login [--browser]`            | Sign in to an OpenAI (ChatGPT) subscription for `MODEL_PROVIDER=codex`. Default is device code (a link + one-time code, works on a headless VPS); `--browser` runs the local PKCE flow. Token → `data/codex-auth.json` (chmod 600)                                                                       |
| `iva rollback`                     | Go back to the version that ran before — a `current` symlink flip and a restart, no git, no build, no network. With no previous version on disk it says so and changes nothing                                                                                                                           |
| `iva doctor`                       | Checks Node ≥ 24, `.env` keys, build, units, both services, two systemd watchdog timers, four memory-schedule status records, vault git origin — auto-repairs what's safe                                                                                                                                |
| `iva status`                       | Status of both services and the systemd watchdog timers                                                                                                                                                                                                                                                  |
| `iva restart`                      | Regenerates units (keeps the port in sync with `IVA_PORT`), restarts agent + bridge                                                                                                                                                                                                                      |
| `iva reset`                        | Stop, quarantine workflow plus Telegram busy/queue state, restart — cures stuck turns that a plain restart brings right back                                                                                                                                                                             |
| `iva usage [window]`               | Same windows as `/usage`, plus `tail [N]` — the last N raw log lines (default 10)                                                                                                                                                                                                                        |
| `iva trace <sub>`                  | The turn journal in the terminal: `tail [--since N]` streams events live, `show [turn]` prints one turn or the last 20, `open` prints the viewer address and the `ssh -N -L` tunnel that reaches it — what the journal holds is in [trace.md](trace.md)                                                  |
| `iva notify <text>`                | Send one message to the digest chat, or to the first allowed user ID when no digest chat is set — how cron and `systemd-run` reminders reach Telegram                                                                                                                                                    |
| `iva userbot <sub>`                | The personal-account proxy (opt-in beta): `creds`, `setup`, `status`, `diagnose --json`, `off` — full walkthrough and the anti-ban guardrail in [userbot.md](userbot.md)                                                                                                                                 |
| `iva start` / `iva stop`           | Start both services and enable at boot / stop them                                                                                                                                                                                                                                                       |
| `iva logs [poll]`                  | Follow agent logs, last 50 lines; `poll` follows the Telegram bridge instead                                                                                                                                                                                                                             |
| `iva uninstall [--purge]`          | Remove units and the `iva` command; `--purge` also deletes code and vault, after a second confirmation                                                                                                                                                                                                   |
| `iva version`                      | Package version + git commit                                                                                                                                                                                                                                                                             |
| `iva tree`                         | The willow, animated                                                                                                                                                                                                                                                                                     |

The installer records the selected update branch in the checkout's local Git config. Stable installs follow `main`; an explicitly installed `BRANCH=…` keeps following that channel. Legacy installs without this setting automatically move from an old feature branch to `main` only when Git proves that the feature HEAD is already contained in `main`, so local work is never overwritten to guess an update channel.

```bash
iva usage week      # 7-day totals, by source and model
iva usage tail 20   # last 20 raw log lines

iva trace show           # the last 20 turns
iva trace show last      # the newest turn, step by step
iva trace tail --since 20 # 20 lines of history, then the stream
```

## Token accounting

Every model step appends one JSON line to `data/usage.jsonl` — including tool-call rounds, which is where most tokens actually go. What each line carries:

- 📍 **Source** — `telegram` chat vs `http` background jobs, so rollups and digests don't hide inside your chat totals
- 🧮 **Five counters** — in, out, cache read, cache write, total — plus model, session, turn and step index
- 🤖 **Subagent steps** — planner tokens are tagged with the subagent name and counted, not lost

The log lives in `data/` next to `tasks.json`, gitignored and outside the vault — otherwise the nightly Brain pass would commit an ever-growing log into your memory repo.

No dollar figures, on purpose. Both providers are flat-rate subscriptions (see [providers.md](providers.md)), so there is no per-token price to multiply. Tokens are the number you can trust; a computed dollar estimate would be fiction.
