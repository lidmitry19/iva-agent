# Trace — the turn journal

The core writes one JSONL line per event: from the update the Bridge accepts to the answer
Outbox delivers. Two readers consume it — the `trace` plugin viewer and `iva trace` — so
this file, not the code, is the contract (ADR-0010). Terms follow `CONTEXT.md`.

File: `data/trace/YYYY-MM-DD.jsonl` under the data directory (`ASSISTANT_DATA_DIR`,
`./data` by default). Two processes append to it: the agent and the Bridge. Append-only,
one line per write.

## Event schema

Exactly seven fields, always in this order:

| Field     | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `ts`      | ISO-8601 **UTC**, the moment of writing                                        |
| `turn`    | turn key — three cases, see below                                              |
| `session` | Eve session id (empty until the turn starts)                                   |
| `source`  | `telegram`, `bridge`, `web`, `http`, `rollup`, `digest`, `cron`, `unknown`     |
| `kind`    | group: `bridge`, `inbound`, `gate`, `context`, `turn`, `eve`, `outbox`, `stop` |
| `name`    | the specific event inside the group                                            |
| `data`    | object: names, timings, sizes, content                                         |

`source` is `unknown` when an Eve event arrives without a channel kind. Note that `ts` is
UTC while the **day file** is named after the installation timezone
(`ASSISTANT_TIMEZONE`): near midnight the first lines of a file can carry a UTC timestamp
that belongs to the previous UTC day. That is deliberate — the journal splits days the way
the vault does.

A line is never longer than 16 KB **in UTF-8 bytes**. An event that does not fit loses its
content and is marked `data.traceTrimmed: true`; names, timings and sizes always survive.

## The three key spaces of `turn`

1. **Before the turn exists** — the update key `tg:<chatId>:<messageId>`. Both the Bridge
   and the core can compute it; `update_id` is invisible to the core.
2. **After the turn starts** — the Eve `turnId` (`turn_0`, `turn_1`, …). Subagent steps
   carry a suffix: `turn_3#planner`, the same key `data/usage.jsonl` uses.
3. **Night turns have no turn key at all.** Rollup, digest and other cron deliveries go
   through the Eve client, which exposes only a session id, so their `gate.outbound` and
   `outbox.*` lines carry `turn: ""` with a non-empty `session` and `source` in
   {`rollup`, `digest`, `cron`}. The Eve events of that same night turn still carry
   `turn_N` from the hook, because the hook runs inside the agent.

**How a reader stitches one turn**

- _Chat turn:_ take `turn.bound`, collect everything whose `turn` equals its
  `data.updateKey` (Bridge, inbound, inbound gate) plus everything whose `turn` equals its
  `turn` (Eve events, Outbox, Stop), then sort by `ts`.
- _Night turn:_ group by `session` **and** `turn_N` together. One Eve session holds many
  turns — the daily digest sends twice inside one session, and the nightly Rollup keeps its
  session alive across nights — so a session on its own would glue a fortnight of nights
  into one turn.
- _A line with no turn key_ (`gate.outbound` and `outbox.*` of a night send) belongs to the
  **most recent turn of its session** by `ts`.
- _Source is part of no key._ Inside one night turn the Eve lines carry
  `source: "unknown"` while `gate.outbound` and `outbox.*` carry `rollup`, so grouping by
  source would cut one turn in two.

Callback updates (`⏹ Stop`, `/menu` buttons) get the key `tg:<chatId>:cb:<callbackId>`,
and **only the Bridge produces it**: callbacks never reach `runTelegramInbound`, so those
`bridge.*` lines stay orphans with no `turn.bound` and no `inbound.*`.

## Event catalogue

| `kind`.`name`                                                     | `data`                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.admitted` / `bridge.dropped`                              | `updateId`, `chatId`, `messageId`, `kind` (`message`/`callback`), `decision` (`owned`/`terminal-drop`/`unownable`/`write-failed`) |
| `bridge.delivered` / `bridge.rejected`                            | the same fields plus `accepted` (`true`/`false`/`"handled"`), `ms`                                                                |
| `inbound.received`                                                | `chatId`, `chatType`, `messageId`, `userId`, `allowlisted`; content: `text`                                                       |
| `inbound.accepted` / `inbound.dropped`                            | `chatId`, `chatKey`, `parts`, `partChars[]`; content: `context[]`                                                                 |
| `gate.inbound` / `gate.web`                                       | `surface`, `blocked`, `reason`, `flags[]`, `truncatedChars`, `chars`                                                              |
| `turn.bound`                                                      | `chatKey`, `updateKey`                                                                                                            |
| `context.parts`                                                   | `core`, `persona`, `moc`, `daily` — memory file sizes in bytes, `unit`, `approximate`                                             |
| `eve.turn.started` / `turn.completed` / `turn.cancelled`          | `sequence`                                                                                                                        |
| `eve.turn.failed` / `eve.step.failed`                             | `sequence`, `stepIndex`, `code`; content: `message`, `details`                                                                    |
| `eve.step.started`                                                | `sequence`, `stepIndex`                                                                                                           |
| `eve.step.completed`                                              | `sequence`, `stepIndex`, `finishReason`, `usage {in,out,cacheRead,cacheWrite,costUsd?}`                                           |
| `eve.actions.requested`                                           | `sequence`, `stepIndex`, `actions[{kind,callId,toolName\|name}]`; content: `args[]`, index-aligned with `actions`                 |
| `eve.action.result`                                               | `sequence`, `stepIndex`, `status`, `callId`, `toolName`, `isError`, `errorCode?`; content: `result`, `error`                      |
| `eve.message.completed`                                           | `sequence`, `stepIndex`, `finishReason`; content: `message`                                                                       |
| `eve.message.received`                                            | `sequence`, `parts`; content: `message`                                                                                           |
| `eve.reasoning.completed`                                         | `sequence`, `stepIndex`; content: `reasoning`                                                                                     |
| `eve.subagent.started` / `subagent.completed` / `subagent.called` | `callId`, `subagentName`, `name`, `childSessionId`; content: `output`                                                             |
| Eve events inside a subagent                                      | the same fields plus `subagent`, `parentCallId`                                                                                   |
| `gate.outbound`                                                   | `clean`, `findings[]` (`type:name`, no secret preview), `chars`; content: `text` — already **after** redaction                    |
| `outbox.delivered` / `outbox.failed`                              | `ok`, `delivered`, `fellBack`, `error`, `chars`, `ms`                                                                             |
| `stop.requested` / `stop.idle` / `stop.failed`                    | `chatKey`, `outcome`                                                                                                              |

Any Eve event may also carry `sessionId` in `data` (whenever its payload has one) and
`input` in content (with `inputChars`); the hook copies both by name.

**`gate.outbound` can appear without a matching `outbox.*`.** Every service reply the
channel sends (a working-status message, an error explanation, a media notice) passes the
same outbound gate but not the Outbox seam, so it produces a gate line alone. Do not wait
for a delivery event after each gate verdict.

Writer markers in `data`: `traceTrimmed` — the event went without content;
`traceUnreadable` — the payload could not be serialized. Markers inside values:
`…[truncated]` — a string or list was cut, `…[deep]` — nesting deeper than four levels,
`…[keys]` — how many fields the truncated object had, `…[unreadable]` — a field could not
be read.

### What is not in the journal

- **Delta events** (`message.appended`, `reasoning.appended`, `action.partial`). They
  repeat the accumulated text hundreds of times per turn; the final text arrives in
  `*.completed`.
- **Eve's own context composition.** CORE, PERSONA and the current time are injected by
  Eve's dynamic instructions, which cannot report from inside. `context.parts` gives the
  **size of those same files on disk** when the turn starts — an approximation, which the
  event itself states with `approximate: true`.
- **Gate verdicts outside a turn.** The sanitizer is called by scripts and unit tests too;
  without a turn key a verdict has nothing to attach to, so those calls write nothing.
  The in-process turn mark also expires after 60 seconds: if media handling of one inbound
  message takes longer than a minute, the gate verdict that follows it is not journaled.

## Content: the toggle and the caps

`data/settings.json`, field `captureContent` (on by default):

```json
{ "captureContent": false }
```

Turned off it keeps names, timings and sizes — the turn stays fully visible, only without
text. Every content field is capped at 2000 characters with the `…[truncated]` marker.

Sizes are written for **string** content fields only, as `<key>Chars` (`text` →
`textChars`). Array content — `args[]`, `context[]` — gets no size; their counts already
live in `data` as `actions[]` and `parts`.

## Retention

14 days: today's file and the 13 before it. Pruning goes by the **date in the file name**,
never by mtime (ADR-0002: file time lies after a copy or a restore), and runs on the first
journal write of a process and again whenever the day file changes. Files whose names do
not match `YYYY-MM-DD.jsonl` are left alone.

## Guarantees for a reader

- Every line is standalone valid JSON; one broken line does not spoil its neighbours.
- A write failure never breaks or slows a turn: it goes to the service log (at most once a
  minute) and nothing else.
- Two processes append to one file, so line order is write order, not turn order. Sort by
  `ts`.
