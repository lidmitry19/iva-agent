#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

UNIT=iva-bitrix-gateway.service
UNIT_FILE=/etc/systemd/system/iva-bitrix-gateway.service
SYSTEM_UNIT_DIRS='/etc/systemd/system.control /run/systemd/system.control /run/systemd/transient /run/systemd/generator.early /etc/systemd/system /etc/systemd/system.attached /run/systemd/system /run/systemd/system.attached /run/systemd/generator /usr/local/lib/systemd/system /lib/systemd/system /usr/lib/systemd/system /run/systemd/generator.late'
SOCKET=/run/iva-bitrix/gateway.sock
INSTALL_ROOT=/usr/local/lib/iva-bitrix-gateway
RELEASES_DIR=$INSTALL_ROOT/releases
CURRENT_LINK=$INSTALL_ROOT/current

RELEASE_ID=${1:-}
RELEASE_DIR=$RELEASES_DIR/$RELEASE_ID
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SNAPSHOT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd -P)

ROLLBACK_ROOT=
UNIT_BACKUP=
PREVIOUS_UNIT_PRESENT=0
PREVIOUS_CURRENT_PRESENT=0
PREVIOUS_CURRENT=
PREVIOUS_ENABLE_STATE=absent
PREVIOUS_ACTIVE_STATE=inactive
RELEASE_EXISTED=0
ROLLBACK_ARMED=0
CLEANUP_NEEDED=0

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

assert_no_gateway_dropins() {
  for system_unit_dir in $SYSTEM_UNIT_DIRS; do
    unit_dropin_dir=$system_unit_dir/$UNIT.d
    [ ! -L "$unit_dropin_dir" ] \
      || fail 'Gateway systemd drop-in metadata is unsafe; nothing was changed.'
    if [ -e "$unit_dropin_dir" ]; then
      [ -d "$unit_dropin_dir" ] \
        || fail 'Gateway systemd drop-in metadata is unsafe; nothing was changed.'
      for unit_dropin in "$unit_dropin_dir"/*.conf; do
        if [ -e "$unit_dropin" ] || [ -L "$unit_dropin" ]; then
          fail 'Gateway systemd drop-in configuration already exists; nothing was changed.'
        fi
      done
    fi
  done
  unset system_unit_dir unit_dropin_dir unit_dropin
}

loaded_gateway_unit_is_exact() {
  loaded_probe=$(systemctl show "$UNIT" \
    --property=LoadState \
    --property=FragmentPath \
    --property=Transient \
    --property=DropInPaths 2>/dev/null) \
    || return 1
  loaded_state=
  loaded_fragment_path=
  loaded_transient=
  loaded_dropin_paths=
  loaded_seen_state=0
  loaded_seen_fragment=0
  loaded_seen_transient=0
  loaded_seen_dropins=0
  loaded_parse_failed=0
  while IFS='=' read -r loaded_key loaded_value; do
    case "$loaded_key" in
      LoadState)
        if [ "$loaded_seen_state" -eq 0 ]; then
          loaded_state=$loaded_value
          loaded_seen_state=1
        else
          loaded_parse_failed=1
        fi
        ;;
      FragmentPath)
        if [ "$loaded_seen_fragment" -eq 0 ]; then
          loaded_fragment_path=$loaded_value
          loaded_seen_fragment=1
        else
          loaded_parse_failed=1
        fi
        ;;
      Transient)
        if [ "$loaded_seen_transient" -eq 0 ]; then
          loaded_transient=$loaded_value
          loaded_seen_transient=1
        else
          loaded_parse_failed=1
        fi
        ;;
      DropInPaths)
        if [ "$loaded_seen_dropins" -eq 0 ]; then
          loaded_dropin_paths=$loaded_value
          loaded_seen_dropins=1
        else
          loaded_parse_failed=1
        fi
        ;;
      '') ;;
      *) loaded_parse_failed=1 ;;
    esac
  done <<EOF
$loaded_probe
EOF
  unset loaded_probe loaded_key loaded_value

  if [ "$loaded_parse_failed" -eq 0 ] \
    && [ "$loaded_seen_state" -eq 1 ] \
    && [ "$loaded_seen_fragment" -eq 1 ] \
    && [ "$loaded_seen_transient" -eq 1 ] \
    && [ "$loaded_seen_dropins" -eq 1 ] \
    && [ "$loaded_state" = loaded ] \
    && [ "$loaded_fragment_path" = "$UNIT_FILE" ] \
    && [ "$loaded_transient" = no ] \
    && [ -z "$loaded_dropin_paths" ]; then
    loaded_result=0
  else
    loaded_result=1
  fi
  unset loaded_state loaded_fragment_path loaded_transient loaded_dropin_paths
  unset loaded_seen_state loaded_seen_fragment loaded_seen_transient loaded_seen_dropins
  unset loaded_parse_failed
  if [ "$loaded_result" -eq 0 ]; then
    unset loaded_result
    return 0
  fi
  unset loaded_result
  return 1
}

assert_exact_loaded_gateway_unit() {
  loaded_gateway_unit_is_exact \
    || fail 'Loaded gateway unit identity or drop-in state is unsafe; rolling back.'
}

# Installing /etc/systemd/system/$UNIT would shadow a vendor, generator,
# runtime, or transient unit with the same name. An "absent" rollback would
# then expose and potentially operate that unrelated unit. Prove true absence
# before creating the rollback snapshot or invoking any mutating helper.
assert_no_hidden_gateway_unit() {
  if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then
    return 0
  fi

  unit_probe=$(systemctl show "$UNIT" \
    --property=LoadState \
    --property=FragmentPath \
    --property=Transient 2>/dev/null) \
    || fail 'Could not prove that the gateway unit name is unused; nothing was changed.'
  unit_load_state=
  unit_fragment_path=
  unit_transient=
  unit_seen_load=0
  unit_seen_fragment=0
  unit_seen_transient=0
  while IFS='=' read -r unit_key unit_value; do
    case "$unit_key" in
      LoadState)
        unit_load_state=$unit_value
        unit_seen_load=1
        ;;
      FragmentPath)
        unit_fragment_path=$unit_value
        unit_seen_fragment=1
        ;;
      Transient)
        unit_transient=$unit_value
        unit_seen_transient=1
        ;;
      '') ;;
      *) fail 'Unexpected systemd unit metadata; nothing was changed.' ;;
    esac
  done <<EOF
$unit_probe
EOF
  unset unit_probe unit_key unit_value

  [ "$unit_seen_load" -eq 1 ] \
    && [ "$unit_seen_fragment" -eq 1 ] \
    && [ "$unit_seen_transient" -eq 1 ] \
    && [ "$unit_load_state" = not-found ] \
    && [ -z "$unit_fragment_path" ] \
    && [ "$unit_transient" = no ] \
    || fail 'Gateway unit resolves outside /etc/systemd/system or is transient; nothing was changed.'
  unset unit_load_state unit_fragment_path unit_transient
  unset unit_seen_load unit_seen_fragment unit_seen_transient
}

remove_rollback_root() {
  [ -n "$ROLLBACK_ROOT" ] || return 0
  case "$ROLLBACK_ROOT" in
    /run/iva-bitrix-rollback.*) rm -rf --one-file-system -- "$ROLLBACK_ROOT" ;;
    *)
      printf '%s\n' 'refusing to remove an unexpected rollback path' >&2
      return 1
      ;;
  esac
}

restore_current() {
  rollback_link=$INSTALL_ROOT/.rollback-current.$$
  rm -f -- "$rollback_link" || return 1
  if [ "$PREVIOUS_CURRENT_PRESENT" -eq 1 ]; then
    ln -s -- "$PREVIOUS_CURRENT" "$rollback_link" || return 1
    mv -Tf -- "$rollback_link" "$CURRENT_LINK" || return 1
    [ "$(readlink -- "$CURRENT_LINK")" = "$PREVIOUS_CURRENT" ] || return 1
  else
    if [ -L "$CURRENT_LINK" ]; then
      [ "$(readlink -- "$CURRENT_LINK")" = "releases/$RELEASE_ID" ] || return 1
      rm -f -- "$CURRENT_LINK" || return 1
    elif [ -e "$CURRENT_LINK" ]; then
      return 1
    fi
  fi
}

restore_unit() {
  rollback_unit=
  if [ "$PREVIOUS_UNIT_PRESENT" -eq 1 ]; then
    rollback_unit=$(mktemp /etc/systemd/system/.iva-bitrix-gateway.service.rollback.XXXXXX) || return 1
    if ! install -o root -g root -m 0644 "$UNIT_BACKUP" "$rollback_unit"; then
      rm -f -- "$rollback_unit" || true
      return 1
    fi
    if ! mv -T -- "$rollback_unit" "$UNIT_FILE"; then
      rm -f -- "$rollback_unit" || true
      return 1
    fi
    cmp -s -- "$UNIT_BACKUP" "$UNIT_FILE" || return 1
  elif [ -L "$UNIT_FILE" ]; then
    return 1
  elif [ -e "$UNIT_FILE" ]; then
    [ -f "$UNIT_FILE" ] && [ "$(stat -c '%U:%G' "$UNIT_FILE")" = 'root:root' ] || return 1
    rm -f -- "$UNIT_FILE" || return 1
  fi
}

restore_enablement() {
  systemctl disable "$UNIT" >/dev/null 2>&1 || true
  systemctl disable --runtime "$UNIT" >/dev/null 2>&1 || true
  case "$PREVIOUS_ENABLE_STATE" in
    enabled) systemctl enable "$UNIT" >/dev/null ;;
    enabled-runtime) systemctl enable --runtime "$UNIT" >/dev/null ;;
    disabled|absent) return 0 ;;
    *) return 1 ;;
  esac
}

restore_activity() {
  if [ "$PREVIOUS_UNIT_PRESENT" -eq 0 ]; then
    return 0
  fi
  case "$PREVIOUS_ACTIVE_STATE" in
    active) systemctl restart "$UNIT" ;;
    inactive) systemctl stop "$UNIT" ;;
    *) return 1 ;;
  esac
}

verify_rollback() {
  if [ "$PREVIOUS_CURRENT_PRESENT" -eq 1 ]; then
    [ -L "$CURRENT_LINK" ] && [ "$(readlink -- "$CURRENT_LINK")" = "$PREVIOUS_CURRENT" ] || return 1
  else
    [ ! -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ] || return 1
  fi

  if [ "$PREVIOUS_UNIT_PRESENT" -eq 1 ]; then
    [ -f "$UNIT_FILE" ] && [ ! -L "$UNIT_FILE" ] && cmp -s -- "$UNIT_BACKUP" "$UNIT_FILE" || return 1
    actual_enable=$(systemctl is-enabled "$UNIT" 2>/dev/null || true)
    [ "$actual_enable" = "$PREVIOUS_ENABLE_STATE" ] || return 1
  else
    [ ! -e "$UNIT_FILE" ] && [ ! -L "$UNIT_FILE" ] || return 1
    ! systemctl is-enabled --quiet "$UNIT" 2>/dev/null || return 1
    ! systemctl is-active --quiet "$UNIT" 2>/dev/null || return 1
  fi

  if [ "$PREVIOUS_UNIT_PRESENT" -eq 1 ]; then
    actual_active=$(systemctl show "$UNIT" --property=ActiveState --value 2>/dev/null || true)
    case "$PREVIOUS_ACTIVE_STATE" in
      active) [ "$actual_active" = active ] || return 1 ;;
      inactive) [ "$actual_active" = inactive ] || return 1 ;;
    esac
  fi
}

remove_new_release() {
  [ "$RELEASE_EXISTED" -eq 0 ] || return 0
  [ ! -e "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] && return 0
  if [ -L "$CURRENT_LINK" ]; then
    [ "$(readlink -- "$CURRENT_LINK")" != "releases/$RELEASE_ID" ] || return 1
  elif [ -e "$CURRENT_LINK" ]; then
    return 1
  fi
  [ ! -L "$RELEASE_DIR" ] && [ -d "$RELEASE_DIR" ] || return 1
  [ "$(stat -c '%U:%G %a' "$RELEASE_DIR")" = 'root:root 755' ] || return 1
  rm -rf --one-file-system -- "$RELEASE_DIR"
}

cleanup() {
  requested_rc=$?
  final_rc=$requested_rc
  rollback_failed=0
  rollback_unit_ready=1
  trap '' HUP INT TERM
  trap - EXIT

  if [ "$ROLLBACK_ARMED" -eq 1 ] && [ "$CLEANUP_NEEDED" -eq 1 ]; then
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
    current_active=$(systemctl show "$UNIT" --property=ActiveState --value 2>/dev/null || printf '%s' unknown)
    case "$current_active" in inactive|failed) ;; *) rollback_failed=1 ;; esac

    restore_current || rollback_failed=1
    if ! restore_unit; then
      rollback_failed=1
      rollback_unit_ready=0
    fi
    if ! systemctl daemon-reload; then
      rollback_failed=1
      rollback_unit_ready=0
    fi
    if [ "$PREVIOUS_UNIT_PRESENT" -eq 1 ]; then
      if [ "$rollback_unit_ready" -ne 1 ] || ! loaded_gateway_unit_is_exact; then
        printf '%s\n' 'restored gateway unit identity is unsafe; keeping it stopped' >&2
        rollback_failed=1
        rollback_unit_ready=0
      fi
    fi
    if [ "$rollback_unit_ready" -eq 1 ]; then
      restore_enablement || rollback_failed=1
      restore_activity || rollback_failed=1
    fi
    verify_rollback || rollback_failed=1
    remove_new_release || rollback_failed=1
  fi

  if [ "$rollback_failed" -eq 0 ]; then
    remove_rollback_root || final_rc=121
    ROLLBACK_ROOT=
  else
    printf 'gateway rollback failed; root-only recovery snapshot preserved at %s\n' "$ROLLBACK_ROOT" >&2
    final_rc=121
  fi
  exit "$final_rc"
}

[ "$#" -eq 1 ] && printf '%s\n' "$RELEASE_ID" | grep -Eq '^[0-9a-f]{40}$' \
  || fail 'Internal usage: install-and-start.sh <reviewed-40-character-release>' 2
[ "$(id -u)" -eq 0 ] || fail 'Run the fixed root-owned admin helper as root.' 2
[ -x /usr/bin/curl ] || fail '/usr/bin/curl is required.'
[ -x /usr/bin/python3 ] || fail '/usr/bin/python3 is required.'
[ -d "$SNAPSHOT_ROOT" ] && [ ! -L "$SNAPSHOT_ROOT" ] \
  && [ "$(stat -c '%U:%G %a' "$SNAPSHOT_ROOT")" = 'root:root 700' ] \
  || fail 'Installer source must be a root-only 0700 staging snapshot.'
[ ! -L "$INSTALL_ROOT" ] || fail 'Gateway install root must not be a symlink.'
[ ! -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ] \
  || fail 'Gateway current path must be absent or a symlink.'

assert_no_gateway_dropins
assert_no_hidden_gateway_unit

ROLLBACK_ROOT=$(mktemp -d /run/iva-bitrix-rollback.XXXXXX)
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chown root:root "$ROLLBACK_ROOT"
chmod 0700 "$ROLLBACK_ROOT"

if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then
  [ -f "$UNIT_FILE" ] && [ ! -L "$UNIT_FILE" ] \
    && [ "$(stat -c '%U:%G %a' "$UNIT_FILE")" = 'root:root 644' ] \
    || fail 'Existing gateway unit metadata is unsafe; nothing was changed.'
  PREVIOUS_UNIT_PRESENT=1
  UNIT_BACKUP=$ROLLBACK_ROOT/iva-bitrix-gateway.service
  install -o root -g root -m 0600 "$UNIT_FILE" "$UNIT_BACKUP"
  PREVIOUS_ENABLE_STATE=$(systemctl is-enabled "$UNIT" 2>/dev/null || true)
  case "$PREVIOUS_ENABLE_STATE" in
    enabled|enabled-runtime|disabled) ;;
    *) fail 'Existing gateway enablement state is unsupported; nothing was changed.' ;;
  esac
  PREVIOUS_ACTIVE_STATE=$(systemctl show "$UNIT" --property=ActiveState --value)
  case "$PREVIOUS_ACTIVE_STATE" in
    active|inactive) ;;
    *) fail 'Existing gateway is transitional; nothing was changed.' ;;
  esac
fi

if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_CURRENT=$(readlink -- "$CURRENT_LINK")
  printf '%s\n' "$PREVIOUS_CURRENT" | grep -Eq '^releases/[0-9a-f]{40}$' \
    || fail 'Existing gateway current link is outside the immutable release layout.'
  previous_release=$INSTALL_ROOT/$PREVIOUS_CURRENT
  [ -d "$previous_release" ] && [ ! -L "$previous_release" ] \
    && [ "$(stat -c '%U:%G %a' "$previous_release")" = 'root:root 755' ] \
    || fail 'Existing gateway current release metadata is unsafe.'
  PREVIOUS_CURRENT_PRESENT=1
fi

if [ -e "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
  [ -d "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] \
    && [ "$(stat -c '%U:%G %a' "$RELEASE_DIR")" = 'root:root 755' ] \
    || fail 'Target release path is unsafe; nothing was changed.'
  RELEASE_EXISTED=1
fi

ROLLBACK_ARMED=1
CLEANUP_NEEDED=1
/usr/bin/env IVA_BITRIX_TRANSACTION=1 "$SCRIPT_DIR/install.sh" "$RELEASE_ID"
assert_exact_loaded_gateway_unit
systemctl cat --no-pager "$UNIT"
systemctl enable "$UNIT"
systemctl restart "$UNIT"

socket_attempts=0
while [ ! -S "$SOCKET" ]; do
  systemctl is-active --quiet "$UNIT" || {
    systemctl status --no-pager --full "$UNIT" >&2 || true
    fail 'gateway service stopped before creating its socket'
  }
  socket_attempts=$((socket_attempts + 1))
  [ "$socket_attempts" -lt 40 ] || fail 'gateway socket did not appear within 10 seconds'
  sleep 0.25
done
unset socket_attempts

health_json=$(/usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 30 \
  --unix-socket "$SOCKET" http://localhost/health) \
  || fail 'gateway health request failed'
printf '%s' "$health_json" |
  /usr/bin/python3 -c \
    'import json,sys; data=json.load(sys.stdin); assert data.get("ok") is True and data.get("ready") is True' \
  || fail 'gateway health response was not ready'
unset health_json

CLEANUP_NEEDED=0
remove_rollback_root || fail 'Gateway installed but rollback snapshot cleanup failed.' 121
ROLLBACK_ROOT=
ROLLBACK_ARMED=0
trap - EXIT HUP INT TERM
printf 'Installed, started, and verified immutable gateway release %s.\n' "$RELEASE_ID"
