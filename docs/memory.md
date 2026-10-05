# Memory

Iva keeps memory in a plain Markdown vault. Raw conversations stay in `daily/`, stable knowledge lives in typed cards, and summaries fold upward from days to weeks, months and years. `CORE.md` is the small always-on layer included in every prompt.

## Night

At 04:00 local time by default one TypeScript schedule runs `scripts/memory/night.ts`. Code owns reads, validation, writes, commits, retries and limits. The configured model only returns proposals: each step instruction describes the answer in words with one short example, the model answers with a JSON object in plain text, and the night parses it leniently — the same way for every provider.

Choose another window with one `.env` setting, `MEMORY_NIGHT_TIME=HH:mm`, then rebuild with `iva update --force` (a development checkout uses `npm run build` and `iva restart`). Editing `.env` alone moves neither the Schedule nor catch-up: `/menu` → ⏰ shows the active time and a pending change. Night still excludes the current local day. Rollback restores the clock of that build; older builds without this setting keep 04:00.

The night consumes streamed text before validating the answer, including on ChatGPT subscriptions that require streaming. It records the final usage before the next call; an interrupted stream fails the step. Codex night calls request low reasoning effort without changing the chat setting.

The night has four steps:

1. Extract a day summary, card references and evidence-backed facts from the raw day.
2. Append dated facts to the Card and propose the whole new Compiled Truth.
3. Write bilateral Card links only when both targets exist.
4. Propose bounded edits to `CORE.md` from the owner's own quotations.

Large inputs are split at entry boundaries. The whole night is capped at 40 calls and 300,000 estimated input tokens. Missing or invalid provider usage closes the gate before the next call. A day is ready after its summary and the one-release compatibility marker in the raw day are committed together for paths allowed by the owner's Git policy. New files excluded by `.gitignore`, `.git/info/exclude` or global Git rules stay on disk and do not stop the night; the log explicitly lists them as outside the Git backup. Already tracked files continue to be committed even if their parent directory is later ignored. If all paths are excluded, day readiness is recorded locally, without backing up those files.

The day cache in `data/memory/night/` makes restarts idempotent. A matching late tail sends only the new entries to the model. If an older processed entry changed, the night leaves the day untouched and asks the owner to remove that cache explicitly before reprocessing.

Weekly summaries require all seven day states, including explicit no-data days. Monthly summaries use full weeks inside the month plus only the in-month days of edge weeks. Yearly summaries use all twelve months.

## Cards and CORE

Every accepted fact is append-only:

```text
- YYYY-MM-DD: fact · [[daily/YYYY-MM-DD]] HH:MM
```

Evidence must come from an owner entry. The model returns the whole new Compiled Truth; the night replaces it only if the Card file still matches the hash read for the call. Replaced truth moves to the Card archive; a concurrent owner edit wins and leaves `truth_pending` for the next night. `write_card` exposes explicit `fact`, `truth` and owner-confirmed `merge` operations. General `write_file` cannot write memory (`daily/`, `summaries/`, period summaries, `cards/`); other vault paths such as `library/` are written and committed, and `CORE.md` goes through the same capped, committed writer.

`write_card` describes a minimal JSON call for each operation before execution and repeats the relevant example when required operation fields are missing or invalid. Substitute the actual Card data, omit unused optional fields, and pass `tags` and `aliases` as arrays of strings. The `merge` example is a call shape, never evidence of the owner's confirmation. Schema-level errors still come from eve; repair the named field using the tool description.

## Brain and search

At 05:00 `scripts/memory/brain.ts` performs deterministic TypeScript maintenance: it commits outstanding owner changes, rebuilds `.graph/vault-graph.json`, checks the CORE size and pushes the vault when a remote exists. It does not call a model or rewrite cards.

`memory_search` uses Node's SQLite FTS5 index and the companion graph file. Hybrid search can additionally fuse embeddings when configured.

## Git and cleanup

The vault is a separate git repository. Night writes, direct Card writes, CORE edits and cleanup all leave scoped commits. The streaming cleaner is `scripts/vault-cleanup.ts`; it collapses duplicated `description` growth and caps oversized legacy descriptions without loading a whole damaged vault into memory. The same TypeScript entrypoint is used by `/menu` and the updater.

All memory code and prompts live under `scripts/memory/`; the vault contains data only. Existing legacy `.claude/` or `MOC.md` files may stay, but the night no longer reads or regenerates them.

## Layout

```text
vault/
├── CORE.md
├── CORE.history.md
├── PERSONA.md
├── cards/{contacts,projects,decisions,ideas,notes}/
├── daily/YYYY-MM-DD.md
├── summaries/daily/YYYY-MM-DD.md
├── weekly/ monthly/ yearly/
├── attachments/
├── schema.json
└── .graph/vault-graph.json
```
