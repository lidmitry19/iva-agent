#!/bin/sh
# Малые конфиги FileLock под TLC с проверкой ожиданий: witness обязан нарушать NotSlow,
# lag/hold/sync-slow — MutualExclusion (границы контракта), остальные — без ошибок.
# Любой сбой tlc или несовпадение ожидания — ненулевой выход. 3-процессные конфиги
# (FileLock.cfg, FileLock-slow.cfg) сюда не входят: минуты и десятки миллионов состояний.
set -u
cd "$(dirname "$0")" || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "tlc-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
WORKERS=${WORKERS:-4}
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected: none | <Invariant>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers "$WORKERS" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" FileLock.tla >"$log" 2>&1
  if grep -q "No error has been found" "$log"; then got=none
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$log" | head -1); fi
  if [ -z "$got" ]; then
    echo "FAIL $cfg: tlc failed or gave no verdict (log: $log)"; sed -n '1,40p' "$log"; failed=$((failed+1)); return
  fi
  if [ "$got" = "$expect" ]; then
    if [ "$got" = none ]; then echo "OK $cfg: no error"; else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '$got', expected '$expect'"; failed=$((failed+1))
  fi
}
check FileLock-2p none
check FileLock-deadline none
check FileLock-witness NotSlow
check FileLock-lag MutualExclusion
check FileLock-hold MutualExclusion
check FileLock-sync-slow MutualExclusion
echo "tlc-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
