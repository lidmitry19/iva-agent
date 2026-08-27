#!/usr/bin/bash

set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

LIVE_REPO=/home/iva/iva
ROOT_DIR=/usr/local/lib/iva-bitrix-admin
ROOT_COPY=/usr/local/lib/iva-bitrix-admin/install
IVA_USER=iva
IVA_HOME=/home/iva
STATE_FILE=/run/iva-bitrix-admin-active-units
SECRET_DIR=/etc/iva-bitrix
SECRET_FILE=/etc/iva-bitrix/bitrix.env
UNIT=iva-bitrix-gateway.service
SYSTEM_UNIT_DIRS='/etc/systemd/system.control /run/systemd/system.control /run/systemd/transient /run/systemd/generator.early /etc/systemd/system /etc/systemd/system.attached /run/systemd/system /run/systemd/system.attached /run/systemd/generator /usr/local/lib/systemd/system /lib/systemd/system /usr/lib/systemd/system /run/systemd/generator.late'
INSTALLER_REL=services/bitrix-gateway/deploy/install-and-start.sh
MANIFEST_REL=MANIFEST.sha256

EXPECTED_COMMIT=${1:-}
EXPECTED_UNITS=
STATE_PUBLISHED=0
SECRET_TMP=
SUDO_CALLER=
SUDO_CALLER_HOME=
TTY_ECHO_DISABLED=0
TTY_PATH=
INSTALL_SUCCESS=0
STAGE_ROOT=

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

assert_no_gateway_dropins() {
  local system_unit_dir unit_dropin_dir unit_dropin

  for system_unit_dir in $SYSTEM_UNIT_DIRS; do
    unit_dropin_dir=$system_unit_dir/$UNIT.d
    [[ ! -L "$unit_dropin_dir" ]] ||
      fail 'Gateway systemd drop-in metadata is unsafe; nothing was changed.'
    if [[ -e "$unit_dropin_dir" ]]; then
      [[ -d "$unit_dropin_dir" ]] ||
        fail 'Gateway systemd drop-in metadata is unsafe; nothing was changed.'
      for unit_dropin in "$unit_dropin_dir"/*.conf; do
        if [[ -e "$unit_dropin" || -L "$unit_dropin" ]]; then
          fail 'Gateway systemd drop-in configuration already exists; nothing was changed.'
        fi
      done
    fi
  done
}

[[ $# -eq 1 && "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
  fail 'Usage: sudo /usr/local/lib/iva-bitrix-admin/install <reviewed-40-character-commit>' 2
[[ $(/usr/bin/id -u) -eq 0 ]] || fail 'Run this helper through sudo as the admin account.' 2
[[ -t 0 && -r /dev/tty && -w /dev/tty ]] || fail 'A dedicated interactive TTY is required.' 2
SELF_REAL=$(/usr/bin/readlink -f -- "$0")
[[ "$SELF_REAL" == "$ROOT_COPY" && -f "$ROOT_COPY" && ! -L "$ROOT_COPY" ]] ||
  fail 'Run only the fixed root-owned copy from /usr/local/lib/iva-bitrix-admin.' 2
[[ -d "$ROOT_DIR" && ! -L "$ROOT_DIR" && $(/usr/bin/stat -c '%U:%G %a' "$ROOT_DIR") == 'root:root 700' ]] ||
  fail 'The fixed admin helper directory must be root:root mode 700.' 2
[[ $(/usr/bin/stat -c '%U:%G %a' "$ROOT_COPY") == 'root:root 700' ]] ||
  fail 'The fixed admin helper copy must be root:root mode 700.' 2
[[ -n ${SUDO_USER:-} && ${SUDO_USER} != root ]] || fail 'A non-root SUDO_USER is required.' 2
[[ ${SUDO_UID:-} =~ ^[0-9]+$ && ${SUDO_UID} != 0 ]] || fail 'A non-root SUDO_UID is required.' 2
[[ $(/usr/bin/id -u "$SUDO_USER") == "$SUDO_UID" ]] || fail 'SUDO_USER and SUDO_UID do not match.' 2

SUDO_CALLER=$SUDO_USER
SUDO_CALLER_HOME=$(/usr/bin/getent passwd "$SUDO_CALLER" | /usr/bin/cut -d: -f6)
[[ "$SUDO_CALLER_HOME" == /* && -d "$SUDO_CALLER_HOME" ]] || fail 'Invalid sudo caller home.' 2

IVA_UID=$(/usr/bin/id -u "$IVA_USER")
IVA_RUNTIME=/run/user/$IVA_UID
IVA_BUS=unix:path=$IVA_RUNTIME/bus
[[ -d "$IVA_RUNTIME" && -S "$IVA_RUNTIME/bus" ]] || fail 'IVA user manager bus is unavailable.'
[[ $(/usr/bin/stat -c '%U:%G' "$IVA_RUNTIME") == "$IVA_USER:$IVA_USER" ]] ||
  fail 'IVA runtime directory ownership is unsafe.'

run_as_iva() {
  /usr/sbin/runuser -u "$IVA_USER" -- /usr/bin/env -i \
    HOME="$IVA_HOME" USER="$IVA_USER" LOGNAME="$IVA_USER" \
    PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$IVA_RUNTIME" \
    DBUS_SESSION_BUS_ADDRESS="$IVA_BUS" "$@"
}

run_git_as_iva() {
  run_as_iva /usr/bin/env GIT_OPTIONAL_LOCKS=0 /usr/bin/git -C "$LIVE_REPO" "$@"
}

run_as_sudo_caller() {
  /usr/sbin/runuser -u "$SUDO_CALLER" -- /usr/bin/env -i \
    HOME="$SUDO_CALLER_HOME" USER="$SUDO_CALLER" LOGNAME="$SUDO_CALLER" \
    PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"
}

list_active_units() {
  local raw
  raw=$(run_as_iva /usr/bin/systemctl --user list-units --state=active \
    --no-legend --plain 'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service') || return 1
  printf '%s\n' "$raw" | /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

list_live_units() {
  local raw
  raw=$(run_as_iva /usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service') || return 1
  printf '%s\n' "$raw" | /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

stop_unit_set() {
  local units=${1-} unit failed=0 remaining

  while IFS= read -r unit; do
    case "$unit" in
      iva.timer|iva-*.timer) run_as_iva /usr/bin/systemctl --user stop "$unit" || failed=1 ;;
    esac
  done <<< "$units"
  while IFS= read -r unit; do
    case "$unit" in
      iva.service|'') ;;
      iva-*.service) run_as_iva /usr/bin/systemctl --user stop "$unit" || failed=1 ;;
    esac
  done <<< "$units"
  if /usr/bin/grep -Fxq 'iva.service' <<< "$units"; then
    run_as_iva /usr/bin/systemctl --user stop iva.service || failed=1
  fi

  remaining=$(list_live_units) || return 1
  if [[ $failed != 0 || -n "$remaining" ]]; then
    printf 'unsafe IVA units remain live:\n%s\n' "$remaining" >&2
    return 1
  fi
}

stop_all_live_units() {
  local live
  live=$(list_live_units 2>/dev/null || true)
  stop_unit_set "$live" || true
}

restore_expected_units() {
  local unit active live failed=0

  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && $(/usr/bin/stat -c '%U:%G %a' "$STATE_FILE") == 'root:root 600' ]] || {
    printf '%s\n' 'missing or unsafe admin recovery state' >&2
    return 1
  }
  [[ $(/usr/bin/sort -u "$STATE_FILE") == "$EXPECTED_UNITS" ]] || {
    printf '%s\n' 'admin recovery state changed after capture' >&2
    return 1
  }
  [[ -z $(list_live_units) ]] || {
    printf '%s\n' 'unexpected IVA units became live before restore' >&2
    return 1
  }

  if /usr/bin/grep -Fxq 'iva.service' <<< "$EXPECTED_UNITS"; then
    run_as_iva /usr/bin/systemctl --user start iva.service || failed=1
  fi
  while IFS= read -r unit; do
    case "$unit" in
      iva.service|'') ;;
      iva-*.service) run_as_iva /usr/bin/systemctl --user start "$unit" || failed=1 ;;
    esac
  done <<< "$EXPECTED_UNITS"
  while IFS= read -r unit; do
    case "$unit" in
      iva.timer|iva-*.timer) run_as_iva /usr/bin/systemctl --user start "$unit" || failed=1 ;;
    esac
  done <<< "$EXPECTED_UNITS"

  active=$(list_active_units) || return 1
  live=$(list_live_units) || return 1
  if [[ $failed != 0 || "$active" != "$EXPECTED_UNITS" || "$live" != "$EXPECTED_UNITS" ]]; then
    printf '%s\n' 'IVA restore mismatch; recovery state preserved' >&2
    printf 'expected:\n%s\nactive:\n%s\nlive:\n%s\n' "$EXPECTED_UNITS" "$active" "$live" >&2
    return 1
  fi
}

invalidate_sudo_ticket() {
  run_as_sudo_caller /usr/bin/sudo -k || true
  if run_as_sudo_caller /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    run_as_sudo_caller /usr/bin/sudo -K || true
  fi
  if run_as_sudo_caller /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    printf '%s\n' 'unsafe sudo authorization remains active' >&2
    return 1
  fi
}

cleanup() {
  local requested_rc=$? final_rc live
  trap '' HUP INT TERM
  trap - EXIT
  final_rc=$requested_rc

  if [[ $TTY_ECHO_DISABLED == 1 && -n "$TTY_PATH" ]]; then
    /usr/bin/stty echo < "$TTY_PATH" || final_rc=121
    TTY_ECHO_DISABLED=0
  fi

  if [[ -n "$SECRET_TMP" ]]; then
    /usr/bin/rm -f -- "$SECRET_TMP" || final_rc=121
    SECRET_TMP=
  fi

  if [[ -n "$STAGE_ROOT" ]]; then
    case "$STAGE_ROOT" in
      /run/iva-bitrix-admin-stage.*)
        /usr/bin/rm -rf --one-file-system -- "$STAGE_ROOT" || final_rc=121
        ;;
      *)
        printf '%s\n' 'refusing to remove an unexpected admin staging path' >&2
        final_rc=121
        ;;
    esac
    STAGE_ROOT=
  fi

  if ! invalidate_sudo_ticket; then
    stop_all_live_units
    live=$(list_live_units 2>/dev/null || printf '%s' '<unknown>')
    printf 'sudo invalidation failed; IVA left contained; live set:\n%s\n' "$live" >&2
    exit 125
  fi

  if [[ $STATE_PUBLISHED == 1 ]]; then
    if ! restore_expected_units; then
      stop_all_live_units
      live=$(list_live_units 2>/dev/null || printf '%s' '<unknown>')
      printf 'IVA restore failed; recovery state preserved; live set:\n%s\n' "$live" >&2
      exit 123
    fi
    /usr/bin/rm -- "$STATE_FILE" || {
      printf '%s\n' 'could not remove completed admin recovery state' >&2
      exit 122
    }
    STATE_PUBLISHED=0
  fi

  if [[ $final_rc == 0 && $INSTALL_SUCCESS == 1 ]]; then
    printf '%s\n' 'ADMIN_INSTALL_COMPLETE'
  fi

  exit "$final_rc"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ ! -e "$STATE_FILE" && ! -L "$STATE_FILE" ]] ||
  fail 'stale admin recovery state exists; inspect it before retrying'

[[ $(run_git_as_iva rev-parse --show-toplevel) == "$LIVE_REPO" ]] ||
  fail 'invalid live repository root'
[[ $(run_git_as_iva rev-parse HEAD) == "$EXPECTED_COMMIT" ]] ||
  fail 'live checkout commit does not match the reviewed commit'
[[ -z $(run_git_as_iva status --porcelain=v1 --untracked-files=all) ]] ||
  fail 'live checkout is not fully clean'

assert_no_gateway_dropins

write_manifest() {
  /usr/bin/cat <<'MANIFEST'
5afad5f051d07286b1e1b46d8a7c776b01b596bb3c8376821129def46e4630dd  services/bitrix-gateway/errors.mjs
3c66e776c669fd65352f6627a7a6da676f903dcef676b6ad3f93aaf722fdc7d6  services/bitrix-gateway/normalize.mjs
d9c2d9476217eeb4282c9ddd16cad719efb5c271200c7f7055aea0fb562154d5  services/bitrix-gateway/policy.mjs
77a86f8d6ce7393183fa3c09b7b38fd96537a8910bab3c6b909b8dc952f37504  services/bitrix-gateway/client.mjs
9b7e87a2fa5170a4e04d6fcd19cb31850aba60a80a90960ed28539aa0a59b380  services/bitrix-gateway/gateway.mjs
a5b473cd2fafe8647a11306242e8c0b32e543960584fef3b56a277a63c266b7b  services/bitrix-gateway/server.mjs
d24d62005387613cf4520bf0a281e4eec29fa385118359fcb4c748e631c6cba4  services/bitrix-gateway/index.mjs
fc9607a97a12442c90d1eaebacaebbc4015dbd3d3b8dbc67daeadce2d344737d  services/bitrix-gateway/preflight-read-state.mjs
4ff3a1b5b01dfc0bae4335a2fec72060d9f00d86c3db3fc1534cf2f60075a33b  services/bitrix-gateway/deploy/audit-secret.py
0e8b2374ddd468e37861e3a7e33866426521d19a6bcf488b3897f2cc2782069d  services/bitrix-gateway/deploy/iva-bitrix-gateway.service
a9740208be8b846439674b3208db52c2f5107416cfd8eed8e6269b024730a55d  services/bitrix-gateway/deploy/install.sh
0df96fc4350bdde2d5b282d30bc0b9aba984003c6bc4404220539d266b58703a  services/bitrix-gateway/deploy/install-and-start.sh
MANIFEST
}

STAGE_ROOT=$(/usr/bin/mktemp -d /run/iva-bitrix-admin-stage.XXXXXX)
/usr/bin/chown root:root "$STAGE_ROOT"
/usr/bin/chmod 0700 "$STAGE_ROOT"
[[ -d "$STAGE_ROOT" && ! -L "$STAGE_ROOT" && $(/usr/bin/stat -c '%U:%G %a' "$STAGE_ROOT") == 'root:root 700' ]] ||
  fail 'could not create a root-only admin staging snapshot'

MANIFEST_FILE=$STAGE_ROOT/$MANIFEST_REL
write_manifest > "$MANIFEST_FILE"
/usr/bin/chown root:root "$MANIFEST_FILE"
/usr/bin/chmod 0600 "$MANIFEST_FILE"

while read -r checksum relative extra; do
  [[ "$checksum" =~ ^[0-9a-f]{64}$ && -n "$relative" && -z ${extra:-} ]] ||
    fail 'invalid embedded admin manifest entry'
  case "$relative" in
    services/bitrix-gateway/errors.mjs|services/bitrix-gateway/normalize.mjs|services/bitrix-gateway/policy.mjs|services/bitrix-gateway/client.mjs|services/bitrix-gateway/gateway.mjs|services/bitrix-gateway/server.mjs|services/bitrix-gateway/index.mjs|services/bitrix-gateway/preflight-read-state.mjs|services/bitrix-gateway/deploy/audit-secret.py|services/bitrix-gateway/deploy/iva-bitrix-gateway.service|services/bitrix-gateway/deploy/install.sh|services/bitrix-gateway/deploy/install-and-start.sh) ;;
    *) fail 'embedded admin manifest path is outside the fixed allowlist' ;;
  esac

  source=$LIVE_REPO/$relative
  staged=$STAGE_ROOT/$relative
  [[ -f "$source" ]] || fail "manifest source is not a regular file: $relative"
  /usr/bin/install -d -o root -g root -m 0700 "$(/usr/bin/dirname -- "$staged")"
  /usr/bin/install -o root -g root -m 0600 -- "$source" "$staged"
  [[ -f "$staged" && ! -L "$staged" && $(/usr/bin/stat -c '%U:%G %a' "$staged") == 'root:root 600' ]] ||
    fail "could not snapshot manifest source safely: $relative"
done < "$MANIFEST_FILE"

(
  cd "$STAGE_ROOT"
  /usr/bin/sha256sum -c --strict "$MANIFEST_REL"
)
/usr/bin/chmod 0700 \
  "$STAGE_ROOT/services/bitrix-gateway/deploy/install.sh" \
  "$STAGE_ROOT/$INSTALLER_REL"

active=$(list_active_units)
live=$(list_live_units)
[[ "$active" == "$live" ]] || fail 'transitional IVA unit state; nothing was stopped'
EXPECTED_UNITS=$active

tmp_state=$(/usr/bin/mktemp /run/.iva-bitrix-admin-active-units.XXXXXX)
/usr/bin/chown root:root "$tmp_state"
/usr/bin/chmod 0600 "$tmp_state"
printf '%s\n' "$EXPECTED_UNITS" > "$tmp_state"
/usr/bin/ln -T -- "$tmp_state" "$STATE_FILE"
/usr/bin/rm -- "$tmp_state"
[[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && $(/usr/bin/stat -c '%U:%G %a' "$STATE_FILE") == 'root:root 600' ]] ||
  fail 'could not publish safe admin recovery state'
[[ $(/usr/bin/sort -u "$STATE_FILE") == "$EXPECTED_UNITS" ]] || fail 'admin recovery state verification failed'
STATE_PUBLISHED=1

stop_unit_set "$EXPECTED_UNITS"

for path in "$SECRET_DIR" /usr/local/lib/iva-bitrix-gateway /etc/systemd/system/iva-bitrix-gateway.service; do
  [[ ! -L "$path" ]] || fail "unsafe partial-install symlink: $path"
done

/usr/bin/getent passwd iva-bitrix >/dev/null ||
  /usr/sbin/useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin iva-bitrix
/usr/bin/install -d -o root -g iva-bitrix -m 0750 "$SECRET_DIR"

secret_is_valid=0
if [[ -f "$SECRET_FILE" && ! -L "$SECRET_FILE" && $(/usr/bin/stat -c '%U:%G %a' "$SECRET_FILE") == 'iva-bitrix:iva-bitrix 600' ]]; then
  if /bin/sh -c '
    f=/etc/iva-bitrix/bitrix.env
    [ "$(grep -c "^BITRIX_WEBHOOK_URL=" "$f" || true)" -eq 1 ] &&
    grep -Eq "^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$" "$f" &&
    [ "$(grep -c "^BITRIX_CHAT_READ_VERIFIED=" "$f" || true)" -le 1 ] &&
    ! grep -Eqv "^[[:space:]]*(#|$)|^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=(true|false)$" "$f"
  ' >/dev/null; then
    secret_is_valid=1
  fi
fi

if [[ $secret_is_valid != 1 ]]; then
  SECRET_TMP=$(/usr/bin/mktemp "$SECRET_DIR/.bitrix.env.XXXXXX")
  /usr/bin/chown root:root "$SECRET_TMP"
  /usr/bin/chmod 0600 "$SECRET_TMP"
  TTY_PATH=/dev/tty
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  /usr/bin/stty -echo < "$TTY_PATH"
  TTY_ECHO_DISABLED=1
  printf '%s\n' 'Paste exactly these two lines, then press Ctrl-D:' > "$TTY_PATH"
  printf '%s\n' 'BITRIX_WEBHOOK_URL=<the HTTPS webhook from BitrixConnect config>' > "$TTY_PATH"
  printf '%s\n' 'BITRIX_CHAT_READ_VERIFIED=false' > "$TTY_PATH"
  printf '%s' 'Secret input (hidden): ' > "$TTY_PATH"
  /usr/bin/cat < "$TTY_PATH" > "$SECRET_TMP"
  /usr/bin/stty echo < "$TTY_PATH"
  TTY_ECHO_DISABLED=0
  printf '\n' > "$TTY_PATH"

  /bin/sh -ceu '
    f=$1
    [ "$(grep -c "^BITRIX_WEBHOOK_URL=" "$f" || true)" -eq 1 ]
    grep -Eq "^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$" "$f"
    [ "$(grep -c "^BITRIX_CHAT_READ_VERIFIED=" "$f" || true)" -eq 1 ]
    grep -Eq "^BITRIX_CHAT_READ_VERIFIED=false$" "$f"
    ! grep -Eqv "^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=false$" "$f"
  ' sh "$SECRET_TMP" || fail 'secret input was invalid; no secret was installed'
  /usr/bin/chown iva-bitrix:iva-bitrix "$SECRET_TMP"
  /usr/bin/chmod 0600 "$SECRET_TMP"
  /usr/bin/mv -T -- "$SECRET_TMP" "$SECRET_FILE"
  SECRET_TMP=
fi

"$STAGE_ROOT/$INSTALLER_REL" "$EXPECTED_COMMIT"
INSTALL_SUCCESS=1
