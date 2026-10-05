#!/usr/bin/env bash
set -Eeuo pipefail
# Collect a token-usage and turn-failure package and send it to the owner's chat with the bot.
# User-facing entrypoint (nothing to type but this line):
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/diagnose-usage.sh | bash
# The package answers "what burned the tokens and why did the turn fail": tokens of every model
# step, the skeleton of every turn (model, why each step ended, tool names, which calls failed),
# the trace, the service journal. It holds no chat text, no tool inputs or outputs and no .env
# values beyond the model settings; secrets are cut once more before packing.
# The file goes ONLY to the bot owner's chat. IVA_DIAG_DAYS (default 3) sets the window;
# IVA_DIAG_NO_SEND=1 only writes the archive to data/diagnose/.
INSTALL_DIR="${IVA_INSTALL_DIR:-${HOME}/iva}"
DAYS="${IVA_DIAG_DAYS:-3}"
case "$DAYS" in '' | *[!0-9]*) DAYS=3 ;; esac
say() { printf '%s\n' "$*"; }
die() { printf 'Iva usage diagnose failed: %s\n' "$*" >&2; exit 1; }

[ -d "$INSTALL_DIR" ] || die "Iva was not found at $INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"
[ -f "$ENV_FILE" ] || die ".env was not found at $ENV_FILE"
if [ -d "$INSTALL_DIR/current" ]; then ROOT="$INSTALL_DIR/current"; else ROOT="$INSTALL_DIR"; fi
env_value() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true; }
DATA_DIR="$(env_value ASSISTANT_DATA_DIR)"; DATA_DIR="${DATA_DIR:-data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$ROOT/$DATA_DIR" ;; esac
BOT="$(env_value TELEGRAM_BOT_TOKEN)"
CHAT="$(env_value TELEGRAM_ALLOWED_USER_IDS | cut -d, -f1)"
[ -n "$BOT" ] && [ -n "$CHAT" ] || die "TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_IDS is missing in .env"

# The Node that runs Iva: PATH first, then the service unit, then the newest nvm install.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$(systemctl --user show iva.service -p ExecStart 2>/dev/null | grep -oE 'path=[^ ;]+' | head -n1 | cut -d= -f2 || true)"
  case "$NODE" in */node) ;; *) NODE="" ;; esac
fi
[ -n "$NODE" ] || NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n1 || true)"
[ -n "$NODE" ] && [ -x "$NODE" ] || die "Node.js was not found (PATH, iva.service, ~/.nvm)"

STORE=""
for candidate in "$INSTALL_DIR/.eve/.workflow-data" "$ROOT/.eve/.workflow-data"; do
  [ -d "$candidate" ] && { STORE="$candidate"; break; }
done
# `iva reset` and an update set the store aside as .workflow-data.trash-<stamp> next to it; the
# turns before a reset live only there, so every kept copy is read too.
STORES=()
if [ -n "$STORE" ]; then
  STORES=("$STORE")
  for trash in "$STORE".trash-*; do [ -d "$trash" ] && STORES+=("$trash"); done
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$DATA_DIR/diagnose"
mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/iva-usage-$STAMP"
mkdir -p "$PKG/trace"

cut_secrets() {
  sed -E 's/([A-Z_]*(TOKEN|KEY|SECRET|PASSWORD|BEARER)[A-Z_]*)=[^ ]*/\1=<cut>/g
    s#bot[0-9]+:[A-Za-z0-9_-]+#bot<cut>#g
    s/(sk|pk|rk)-[A-Za-z0-9_-]{16,}/\1-<cut>/g
    s/(Bearer|bearer) [A-Za-z0-9._~+\/=-]{12,}/\1 <cut>/g'
}

# --- Versions, model settings, doctor ------------------------------------------------------
{
  say "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  say "window_days: $DAYS"
  say "root: $ROOT"
  say "package: $(grep -m1 '"version"' "$ROOT/package.json" 2>/dev/null | tr -d ' ,' || true)"
  say "eve: $(grep -m1 '"version"' "$ROOT/node_modules/eve/package.json" 2>/dev/null | tr -d ' ,' || true)"
  say "node: $("$NODE" --version 2>/dev/null || true)"
  say "store: ${STORE:-(not found)}"
  say "stores set aside by reset/update: $(( ${#STORES[@]} > 0 ? ${#STORES[@]} - 1 : 0 ))"
  say; say "versions on disk:"; ls -1 "$INSTALL_DIR/versions" 2>/dev/null || say "(none)"
} > "$PKG/versions.txt"

{
  say "# Model settings from .env (values only for these keys; the rest are names)"
  grep -E '^(MODEL_PROVIDER|THINKING_EFFORT|AGENT_LANGUAGE|MEMORY_SEARCH_MODE|SEARCH_PROVIDER|ASSISTANT_TIMEZONE|[A-Z]+_MODEL|[A-Z]+_VISION_MODEL|[A-Z]+_CONTEXT_WINDOW|CUSTOM_REASONING|CUSTOM_BASE_URL|[A-Z_]*TIMEOUT[A-Z_]*)=' "$ENV_FILE" || true
  say; say "# Other keys that are set (names only)"
  grep -E '^[A-Z0-9_]+=.+' "$ENV_FILE" | cut -d= -f1 | sort || true
} | cut_secrets > "$PKG/env-model.txt"

IVA="$(command -v iva || true)"
[ -n "$IVA" ] || IVA="$HOME/.local/bin/iva"
# `iva diagnose` (0.4.1+) brings the doctor and cuts the secrets it knows by value.
if [ -x "$IVA" ] && "$IVA" diagnose >/dev/null 2>&1; then
  LAST_MD="$(ls -t "$OUT_DIR"/*.md 2>/dev/null | head -n1 || true)"
  [ -n "$LAST_MD" ] && cp "$LAST_MD" "$PKG/diagnose.md"
fi

# --- Iva's own files: token counters per step, trace, custom layer names --------------------
if [ -f "$DATA_DIR/usage.jsonl" ]; then
  SINCE="$("$NODE" -e 'console.log(new Date(Date.now()-Number(process.argv[1])*864e5).toISOString())' "$((DAYS > 14 ? DAYS : 14))")"
  "$NODE" -e '
    const fs = require("fs"); const since = process.argv[2];
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line) continue;
      try { if ((JSON.parse(line).ts ?? "") >= since) process.stdout.write(line + "\n"); } catch {}
    }' "$DATA_DIR/usage.jsonl" "$SINCE" > "$PKG/usage.jsonl" || true
fi
if [ -d "$DATA_DIR/trace" ]; then
  find "$DATA_DIR/trace" -maxdepth 1 -name '*.jsonl' -mtime "-$((DAYS + 1))" -exec cp {} "$PKG/trace/" \; 2>/dev/null || true
fi
{
  say "## custom layer (names only)"
  ls -1 "$DATA_DIR/custom" 2>/dev/null || say "(none)"
  say; say "## custom skills"
  ls -1 "$DATA_DIR/custom/skills" 2>/dev/null || say "(none)"
  say; say "## schedules and reminders (counts)"
  for f in jobs.json reminders.json tasks.json; do
    [ -f "$DATA_DIR/$f" ] && say "$f: $(wc -c < "$DATA_DIR/$f") bytes" || true
  done
  say; say "## workflow store runs by status"
  if [ -n "$STORE" ] && [ -d "$STORE/runs" ]; then
    cat "$STORE"/runs/*.json 2>/dev/null | grep -oE '"status":"[a-z_]+"' | sort | uniq -c || true
  fi
} > "$PKG/layout.txt"

# --- Journal: failures, limits and lifecycle only. Request bodies (prompts, chat) and job
# tails (the agent's own reports) are dropped; a line is cut at 300 bytes.
journalctl --user -u iva.service -u iva-telegram-poll.service -u 'iva-brain*' -u 'iva-self-update*' \
  --since "-${DAYS}d" --no-pager 2>&1 \
  | grep -vE "(content|text|prompt|instructions|messages|input|output|stdout|stderr|detail):" \
  | grep -iE "error|fail|warn|timeout|timed out|limit|retr|abort|cancel|kill|exit|restart|started|stopped|empty|invalid|refus|denied|[^0-9](4[0-9]{2}|5[0-9]{2})[^0-9]|schedule-runner|compaction" \
  | sed -E 's/ tail: .*/ tail: <cut>/' \
  | LC_ALL=C cut -c1-300 | cut_secrets | tail -n 20000 > "$PKG/journal.log" || true

# --- Turn skeleton from eve's store + the summary a human reads first -----------------------
cat > "$WORK/skeleton.mjs" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [pkg, days, ...stores] = process.argv.slice(2);
const since = new Date(Date.now() - Number(days) * 864e5).toISOString();
const clip = (v, n) => (typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\s+/g, " ").slice(0, n);
const size = (v) => (v == null ? 0 : typeof v === "string" ? v.length : JSON.stringify(v).length);

/** One decoded stream event, or null: files are `<header>devl` + a devalue pair around base64 JSON. */
function decode(buf) {
  const at = buf.indexOf("devl");
  if (at < 0) return null;
  try {
    const pair = JSON.parse(buf.subarray(at + 4).toString("utf8"));
    return typeof pair[1] === "string" ? JSON.parse(Buffer.from(pair[1], "base64").toString("utf8")) : null;
  } catch {
    return null;
  }
}

/** Tool outputs carry the user's data; only the fact of failure leaves the machine. */
function failed(result, status) {
  if (status && !/^(completed|succeeded|ok)$/i.test(status)) return true;
  if (!result || result.kind === "tool-error") return true;
  const o = result.output;
  if (o && typeof o === "object") return o.ok === false || o.error != null || (o.exitCode != null && o.exitCode !== 0);
  return false;
}

const rows = [];
const seen = new Set(); // a chunk id is unique; the same lane can sit in the store and a set-aside copy
for (const store of stores) {
  const chunks = path.join(store, "streams", "chunks");
  if (!fs.existsSync(chunks)) continue;
  for (const dir of fs.readdirSync(chunks).sort()) {
    const full = path.join(chunks, dir);
    if (!fs.statSync(full).isDirectory() || fs.statSync(full).mtime.toISOString() < since) continue;
    const session = "wrun_" + dir.replace(/^strm_/, "").split("_")[0];
    const lane = dir.split("_").slice(2).join("_");
    for (const file of fs.readdirSync(full).sort()) {
      if (seen.has(`${dir}/${file}`)) continue;
      seen.add(`${dir}/${file}`);
      const ev = decode(fs.readFileSync(path.join(full, file)));
      if (!ev || !ev.type) continue;
      const d = ev.data ?? {};
      const at = ev.meta?.at ?? "";
      if (at && at < since) continue;
      const base = { at, session, lane, turn: d.turnId, step: d.stepIndex, type: ev.type };
      switch (ev.type) {
        case "action.input.appended":
        case "message.appended":
        case "reasoning.appended":
          break; // streaming deltas: text, never exported
        case "step.started":
          rows.push({ ...base, model: d.modelId });
          break;
        case "step.completed":
          rows.push({ ...base, finish: d.finishReason, usage: d.usage });
          break;
        case "step.failed":
        case "turn.failed":
          rows.push({ ...base, code: d.code, error: clip(d.message ?? d.error, 300) });
          break;
        case "actions.requested":
          rows.push({
            ...base,
            actions: (d.actions ?? []).map((a) => ({ tool: a.toolName ?? a.name ?? a.kind, kind: a.kind, inputChars: size(a.input) })),
          });
          break;
        case "action.result": {
          const r = d.result ?? {};
          const bad = failed(r, d.status);
          rows.push({
            ...base,
            tool: r.toolName,
            status: d.status,
            kind: r.kind,
            failed: bad,
            outputChars: size(r.output),
            // Harness errors (invalid input, unknown tool) are eve's own words, not user data.
            harnessError: r.kind === "tool-error" ? clip(r.error?.message ?? r.error, 160) : undefined,
          });
          break;
        }
        case "message.received":
          rows.push({ ...base, parts: Array.isArray(d.parts) ? d.parts.length : d.parts, chars: size(d.message ?? d.parts) });
          break;
        case "message.completed":
          rows.push({ ...base, finish: d.finishReason, chars: size(d.message) });
          break;
        default:
          rows.push(base); // turn.*, session.*, compaction.*, input.*, subagent.* — the type is the fact
      }
    }
  }
}
rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
fs.writeFileSync(path.join(pkg, "turn-skeleton.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

// ---- summary ----
const turns = new Map();
const key = (r) => `${r.session} ${r.turn ?? "?"}`;
for (const r of rows) {
  if (!r.turn) continue;
  const t = turns.get(key(r)) ?? {
    session: r.session, turn: r.turn, lane: r.lane, first: r.at, last: r.at, models: new Set(),
    steps: 0, finish: {}, actionSteps: new Set(), textSteps: new Set(), finishedSteps: [],
    tools: {}, failedTools: {}, harnessErrors: {}, in: 0, out: 0, cacheRead: 0, end: "", error: "",
  };
  t.last = r.at || t.last;
  if (r.type === "step.started") { t.steps++; if (r.model) t.models.add(r.model); }
  if (r.type === "step.completed") {
    t.finish[r.finish ?? "?"] = (t.finish[r.finish ?? "?"] ?? 0) + 1;
    t.finishedSteps.push(r.step);
    t.in += r.usage?.inputTokens ?? 0; t.out += r.usage?.outputTokens ?? 0; t.cacheRead += r.usage?.cacheReadTokens ?? 0;
  }
  if (r.type === "actions.requested") { t.actionSteps.add(r.step); for (const a of r.actions) t.tools[a.tool] = (t.tools[a.tool] ?? 0) + 1; }
  if (r.type === "message.completed" && r.chars > 0) t.textSteps.add(r.step);
  if (r.type === "action.result" && r.failed) t.failedTools[r.tool ?? "?"] = (t.failedTools[r.tool ?? "?"] ?? 0) + 1;
  if (r.harnessError) t.harnessErrors[r.harnessError] = (t.harnessErrors[r.harnessError] ?? 0) + 1;
  if (/^turn\.(completed|failed|cancelled)$/.test(r.type)) t.end = r.type.slice(5);
  if (r.type === "turn.failed" || r.type === "step.failed") t.error = r.error || t.error;
  turns.set(key(r), t);
}

// Iva's own counters cover versions whose store was pruned; they are the spend of record.
const usage = [];
const usageFile = path.join(pkg, "usage.jsonl");
if (fs.existsSync(usageFile)) {
  for (const line of fs.readFileSync(usageFile, "utf8").split("\n")) {
    try { if (line) usage.push(JSON.parse(line)); } catch {}
  }
}
const perDay = new Map();
const perTurn = new Map();
for (const u of usage) {
  const day = (u.ts ?? "").slice(0, 10);
  const dk = `${day} ${u.source ?? "?"} ${u.model ?? "?"}`;
  const d = perDay.get(dk) ?? { steps: 0, in: 0, out: 0, cacheRead: 0 };
  d.steps++; d.in += u.in ?? 0; d.out += u.out ?? 0; d.cacheRead += u.cacheRead ?? 0;
  perDay.set(dk, d);
  // Vision and compaction outside a step have no turn (turnId "#vision"): count them per day
  // above, never glue them into one false "heaviest turn".
  if (!String(u.turnId ?? "").split("#")[0]) continue;
  const tk = `${u.sessionId} ${u.turnId}`;
  const t = perTurn.get(tk) ?? { first: u.ts, source: u.source, model: u.model, steps: 0, in: 0, out: 0, cacheRead: 0, maxIn: 0 };
  t.steps++; t.in += u.in ?? 0; t.out += u.out ?? 0; t.cacheRead += u.cacheRead ?? 0; t.maxIn = Math.max(t.maxIn, u.in ?? 0);
  perTurn.set(tk, t);
}

const m = (n) => (n / 1e6).toFixed(2) + "M";
const minutes = (a, b) => (a && b ? ((Date.parse(b) - Date.parse(a)) / 6e4).toFixed(1) : "?");
const top = (o, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}×${v}`).join(", ");
const out = [];
out.push(`# Iva usage summary (last ${days} days of the store, 14 days of counters)`, "");
out.push("## Tokens per day, source and model (usage.jsonl)");
out.push("day        source            model                          steps      input     output  cacheRead");
for (const [k, d] of [...perDay].sort()) {
  const [day, source, model] = k.split(" ");
  out.push(`${day} ${source.padEnd(17)} ${model.slice(0, 30).padEnd(30)} ${String(d.steps).padStart(6)} ${m(d.in).padStart(10)} ${m(d.out).padStart(10)} ${m(d.cacheRead).padStart(10)}`);
}
out.push("", "## Heaviest turns by input tokens (usage.jsonl)");
out.push("start        source            steps    input  maxStepIn  cacheRead  session turn");
for (const [k, t] of [...perTurn].sort((a, b) => b[1].in - a[1].in).slice(0, 25)) {
  out.push(`${(t.first ?? "").slice(5, 16)} ${String(t.source).padEnd(17)} ${String(t.steps).padStart(5)} ${m(t.in).padStart(8)} ${String(t.maxIn).padStart(10)} ${m(t.cacheRead).padStart(9)}  ${k}`);
}
out.push("", "## Turns with the most model steps (eve store)");
out.push("Columns: steps; steps that called a tool; steps with text; steps with neither (a model that");
out.push("stopped for a tool call eve could not run, or answered nothing, and was asked again).");
const list = [...turns.values()].sort((a, b) => b.steps - a.steps).slice(0, 30);
for (const t of list) {
  const silent = t.finishedSteps.filter((s) => !t.actionSteps.has(s) && !t.textSteps.has(s)).length;
  out.push(
    `${(t.first ?? "").slice(5, 16)} ${t.lane.padEnd(6)} ${t.session} ${t.turn}  end=${t.end || "open"}  ${minutes(t.first, t.last)} min`,
    `   steps=${t.steps} withTool=${t.actionSteps.size} withText=${t.textSteps.size} silent=${silent}  in=${m(t.in)} out=${m(t.out)} cacheRead=${m(t.cacheRead)}  model=${[...t.models].join(",")}`,
    `   finish: ${top(t.finish)}`,
    `   tools: ${top(t.tools, 8) || "-"}`,
    ...(Object.keys(t.failedTools).length ? [`   failed tools: ${top(t.failedTools)}`] : []),
    ...(Object.keys(t.harnessErrors).length ? [`   harness errors: ${top(t.harnessErrors, 3)}`] : []),
    ...(t.error ? [`   error: ${t.error}`] : []),
  );
}
if (!turns.size) out.push("(no eve store events in the window: the store was not found or was pruned)");
fs.writeFileSync(path.join(pkg, "summary.txt"), out.join("\n") + "\n");
NODE
"$NODE" "$WORK/skeleton.mjs" "$PKG" "$DAYS" ${STORES[@]+"${STORES[@]}"} 2> "$PKG/skeleton-errors.txt" || true
[ -s "$PKG/skeleton-errors.txt" ] || rm -f "$PKG/skeleton-errors.txt"

cat > "$PKG/README.txt" <<'TXT'
Iva usage package. Start with summary.txt.
  summary.txt          tokens per day, heaviest turns, turns with the most steps
  turn-skeleton.jsonl  every model step: model, why it ended, tokens, tool names, failures (no text)
  usage.jsonl          Iva's token counters per step, 14 days
  trace/               Iva's trace (counts and sizes only)
  journal.log          service journal: failures, limits, restarts; no request bodies, secrets cut
  env-model.txt        model settings; other .env keys by name only
  diagnose.md          `iva diagnose` with the doctor (0.4.1 and newer)
  versions.txt, layout.txt
TXT

# One more pass over every text file: whatever slipped into an error message is cut here.
for f in "$PKG"/*.txt "$PKG"/*.log "$PKG"/*.jsonl "$PKG"/trace/*.jsonl; do
  [ -f "$f" ] || continue
  cut_secrets < "$f" > "$f.cut" && mv "$f.cut" "$f"
done

ARCHIVE="$OUT_DIR/iva-usage-$STAMP.tgz"
tar -czf "$ARCHIVE" -C "$WORK" "iva-usage-$STAMP"

if [ -n "${IVA_DIAG_NO_SEND:-}" ]; then say "Package written, not sent: $ARCHIVE"; exit 0; fi
RESPONSE="$(curl -s -F "chat_id=$CHAT" -F "document=@$ARCHIVE" -F "caption=Iva usage package $(date +%Y-%m-%d\ %H:%M)" "https://api.telegram.org/bot$BOT/sendDocument" || true)"
case "$RESPONSE" in
  *'"ok":true'*) say "Sent to your chat with the bot: $(basename "$ARCHIVE"). Forward it to the maintainer." ;;
  *) die "could not send the package: $(printf '%s' "$RESPONSE" | head -c 200). The file is here: $ARCHIVE" ;;
esac
