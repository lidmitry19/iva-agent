#!/bin/sh
# PluginProposal.tla под TLC с проверкой ожиданий: основная модель без ошибок, каждый свидетель
# нарушает свой инвариант первым (поиск в ширину, один поток — самый короткий контрпример).
# Третий аргумент check — инварианты, убранные из списка: norename на той же глубине, что
# OneInstaller, ломает и SweepSparesTaken (тап возвращает общую копию из-под второго тапа), и
# какой из двух выйдет первым, решает порядок обхода; поэтому OneInstaller проверяется без него.
# Любой сбой tlc или несовпадение ожидания — ненулевой выход. Файлы состояний TLC пишет во
# временную папку.
set -u
cd "$(dirname "$0")" || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "plugin-proposal-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
WORKERS=${WORKERS:-4}
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected [dropped invariant]; expected: none | <Invariant>
  cfg=$1; expect=$2; drop=${3:-}
  name="$cfg${drop:+ without $drop}"; run="$META/$cfg$(printf %s "$drop" | tr ' ' '-')"; log="$run.log"
  cp "$cfg.cfg" "$run.cfg"
  for inv in $drop; do
    sed "/^INVARIANTS/s/ $inv\$//; /^INVARIANTS/s/ $inv / /" "$run.cfg" >"$run.tmp" && mv "$run.tmp" "$run.cfg"
    if grep -Eq "^INVARIANTS.* $inv( |\$)" "$run.cfg" || ! grep -Eq "^INVARIANTS" "$run.cfg"; then
      echo "FAIL $name: could not drop $inv"; failed=$((failed+1)); return
    fi
  done
  w=$WORKERS; [ "$expect" = none ] || w=1
  cp PluginProposal.tla "$META/"
  (cd "$META" && "$TLC" -workers "$w" -deadlock -metadir "$run.states" -config "$run.cfg" PluginProposal.tla) >"$log" 2>&1
  if grep -q "No error has been found" "$log"; then got=none
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$log" | head -1); fi
  if [ -z "$got" ]; then
    echo "FAIL $name: tlc failed or gave no verdict"; sed -n '1,40p' "$log"; failed=$((failed+1)); return
  fi
  if [ "$got" = "$expect" ]; then
    if [ "$got" = none ]; then
      echo "OK $name: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $name: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $name: got '$got', expected '$expect'"; failed=$((failed+1))
  fi
}
check PluginProposal-norename OneInstaller SweepSparesTaken
check PluginProposal-nostamp SweepSparesTaken
check PluginProposal-nostaged OnlyButtonBytes
check PluginProposal none
echo "plugin-proposal-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
