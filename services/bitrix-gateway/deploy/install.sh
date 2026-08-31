#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

SERVICE_USER=iva-bitrix
SOCKET_GROUP=iva
SECRET_DIR=/etc/iva-bitrix
SECRET_FILE=/etc/iva-bitrix/bitrix.env
INSTALL_ROOT=/usr/local/lib/iva-bitrix-gateway
RELEASES_DIR=$INSTALL_ROOT/releases
CURRENT_LINK=$INSTALL_ROOT/current
UNIT_NAME=iva-bitrix-gateway.service
UNIT_DIR=/etc/systemd/system
UNIT_FILE=$UNIT_DIR/$UNIT_NAME

RELEASE_ID=${1:-}
CANDIDATE_DIR=
CURRENT_TMP=
UNIT_TMP=

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ -n "$UNIT_TMP" ]; then
    rm -f -- "$UNIT_TMP" || rc=121
  fi
  if [ -n "$CURRENT_TMP" ]; then
    rm -f -- "$CURRENT_TMP" || rc=121
  fi
  if [ -n "$CANDIDATE_DIR" ]; then
    case "$CANDIDATE_DIR" in
      "$RELEASES_DIR"/.[0-9a-f]*.*) rm -rf --one-file-system -- "$CANDIDATE_DIR" || rc=121 ;;
      *)
        printf '%s\n' 'refusing to remove an unexpected release candidate path' >&2
        rc=121
        ;;
    esac
  fi
  exit "$rc"
}

validate_release() {
  release=$1
  [ -d "$release" ] && [ ! -L "$release" ] || return 1
  [ "$(stat -c '%U:%G %a' "$release")" = 'root:root 755' ] || return 1

  expected_count=0
  for source in errors.mjs normalize.mjs policy.mjs client.mjs gateway.mjs server.mjs index.mjs; do
    expected_count=$((expected_count + 1))
    [ -f "$release/$source" ] && [ ! -L "$release/$source" ] || return 1
    [ "$(stat -c '%U:%G %a' "$release/$source")" = 'root:root 644' ] || return 1
    cmp -s -- "$CANDIDATE_DIR/$source" "$release/$source" || return 1
  done
  for source in preflight-read-state.mjs audit-secret.py; do
    expected_count=$((expected_count + 1))
    [ -f "$release/$source" ] && [ ! -L "$release/$source" ] || return 1
    [ "$(stat -c '%U:%G %a' "$release/$source")" = 'root:root 755' ] || return 1
    cmp -s -- "$CANDIDATE_DIR/$source" "$release/$source" || return 1
  done

  [ "$(find "$release" -mindepth 1 -maxdepth 1 -type f -printf . | wc -c)" -eq "$expected_count" ] || return 1
  [ -z "$(find "$release" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ] || return 1
}

[ "$#" -eq 1 ] && printf '%s\n' "$RELEASE_ID" | grep -Eq '^[0-9a-f]{40}$' \
  || fail 'Internal usage: install.sh <reviewed-40-character-release>' 2
[ "${IVA_BITRIX_TRANSACTION:-}" = 1 ] \
  || fail 'install.sh may run only inside the audited install-and-start transaction.' 2
[ "$(id -u)" -eq 0 ] || fail 'Run the fixed root-owned admin helper as root.' 2
command -v getent >/dev/null 2>&1 || fail 'getent is required.'
command -v useradd >/dev/null 2>&1 || fail 'useradd is required.'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required.'
[ -x /usr/bin/node ] || fail '/usr/bin/node is required.'

NODE_MAJOR=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || fail 'Node.js 20 or newer is required.'
getent group "$SOCKET_GROUP" >/dev/null 2>&1 || fail 'The iva group must exist before installing the gateway.'
getent passwd iva >/dev/null 2>&1 || fail 'The iva service user must exist before installing the gateway.'

if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

[ "$(id -u "$SERVICE_USER")" != "$(id -u iva)" ] || fail 'iva-bitrix must have a UID separate from iva.'
install -d -o root -g "$SERVICE_USER" -m 0750 "$SECRET_DIR"

if [ ! -f "$SECRET_FILE" ] || [ -L "$SECRET_FILE" ]; then
  fail 'Create /etc/iva-bitrix/bitrix.env through the fixed root-owned admin helper, then rerun.' 2
fi

[ "$(stat -c '%U:%G' "$SECRET_FILE")" = "$SERVICE_USER:$SERVICE_USER" ] \
  || fail 'The secret file must be owned by iva-bitrix:iva-bitrix.'
[ "$(stat -c '%a' "$SECRET_FILE")" = '600' ] \
  || fail 'The secret file must have mode 600.'
[ "$(grep -c '^BITRIX_WEBHOOK_URL=' "$SECRET_FILE" || true)" -eq 1 ] \
  || fail 'The secret file must contain exactly one BITRIX_WEBHOOK_URL entry.'
grep -Eq '^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$' "$SECRET_FILE" \
  || fail 'BITRIX_WEBHOOK_URL must be a non-empty HTTPS URL on one line.'
[ "$(grep -c '^BITRIX_CHAT_READ_VERIFIED=' "$SECRET_FILE" || true)" -le 1 ] \
  || fail 'The secret file may contain at most one BITRIX_CHAT_READ_VERIFIED entry.'
if grep -q '^BITRIX_CHAT_READ_VERIFIED=' "$SECRET_FILE"; then
  grep -Eq '^BITRIX_CHAT_READ_VERIFIED=(true|false)$' "$SECRET_FILE" \
    || fail 'BITRIX_CHAT_READ_VERIFIED must be exactly true or false.'
fi
[ "$(grep -Ev '^[[:space:]]*(#|$)|^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=' "$SECRET_FILE" | wc -l)" -eq 0 ] \
  || fail 'The secret file may contain only the webhook, chat-read gate, comments, and blank lines.'

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
SNAPSHOT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd -P)
[ -d "$SNAPSHOT_ROOT" ] && [ ! -L "$SNAPSHOT_ROOT" ] \
  && [ "$(stat -c '%U:%G %a' "$SNAPSHOT_ROOT")" = 'root:root 700' ] \
  || fail 'Installer source must be a root-only 0700 staging snapshot.'

for path in "$INSTALL_ROOT" "$RELEASES_DIR"; do
  [ ! -L "$path" ] || fail "Unsafe install-directory symlink: $path"
  [ ! -e "$path" ] || [ -d "$path" ] || fail "Install path is not a directory: $path"
  if [ -d "$path" ]; then
    [ "$(stat -c '%U:%G %a' "$path")" = 'root:root 755' ] \
      || fail "Existing install-directory metadata is unsafe: $path"
  else
    install -d -o root -g root -m 0755 "$path"
  fi
done
[ "$(stat -c '%U:%G %a' "$INSTALL_ROOT")" = 'root:root 755' ] \
  || fail 'Gateway install root metadata is unsafe.'
[ "$(stat -c '%U:%G %a' "$RELEASES_DIR")" = 'root:root 755' ] \
  || fail 'Gateway releases directory metadata is unsafe.'

CANDIDATE_DIR=$(mktemp -d "$RELEASES_DIR/.${RELEASE_ID}.XXXXXX")
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chown root:root "$CANDIDATE_DIR"
chmod 0700 "$CANDIDATE_DIR"

for source in errors.mjs normalize.mjs policy.mjs client.mjs gateway.mjs server.mjs index.mjs; do
  [ -f "$SOURCE_DIR/$source" ] && [ ! -L "$SOURCE_DIR/$source" ] \
    || fail "Required staged gateway source is missing or is a symlink: $source"
  install -o root -g root -m 0644 "$SOURCE_DIR/$source" "$CANDIDATE_DIR/$source"
done

[ -f "$SOURCE_DIR/preflight-read-state.mjs" ] && [ ! -L "$SOURCE_DIR/preflight-read-state.mjs" ] \
  || fail 'Required staged read-state preflight is missing or is a symlink.'
install -o root -g root -m 0755 \
  "$SOURCE_DIR/preflight-read-state.mjs" "$CANDIDATE_DIR/preflight-read-state.mjs"

[ -f "$SCRIPT_DIR/audit-secret.py" ] && [ ! -L "$SCRIPT_DIR/audit-secret.py" ] \
  || fail 'Required staged secret audit helper is missing or is a symlink.'
install -o root -g root -m 0755 \
  "$SCRIPT_DIR/audit-secret.py" "$CANDIDATE_DIR/audit-secret.py"

RELEASE_DIR=$RELEASES_DIR/$RELEASE_ID
if [ -e "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
  validate_release "$RELEASE_DIR" \
    || fail 'Existing immutable release does not match the reviewed staging snapshot.'
  rm -rf --one-file-system -- "$CANDIDATE_DIR"
  CANDIDATE_DIR=
else
  chmod 0755 "$CANDIDATE_DIR"
  mv -T -- "$CANDIDATE_DIR" "$RELEASE_DIR"
  CANDIDATE_DIR=
fi
[ -d "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] \
  && [ "$(stat -c '%U:%G %a' "$RELEASE_DIR")" = 'root:root 755' ] \
  || fail 'Promoted release metadata is unsafe.'

CURRENT_TMP=$INSTALL_ROOT/.current.$$
[ ! -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ] \
  || fail 'Gateway current path must be absent or a symlink.'
[ ! -e "$CURRENT_TMP" ] && [ ! -L "$CURRENT_TMP" ] \
  || fail 'Stale current-link candidate exists.'
ln -s -- "releases/$RELEASE_ID" "$CURRENT_TMP"
mv -Tf -- "$CURRENT_TMP" "$CURRENT_LINK"
CURRENT_TMP=

[ -f "$SCRIPT_DIR/$UNIT_NAME" ] && [ ! -L "$SCRIPT_DIR/$UNIT_NAME" ] \
  || fail 'Required staged systemd unit is missing or is a symlink.'
UNIT_TMP=$(mktemp "$UNIT_DIR/.${UNIT_NAME}.XXXXXX")
install -o root -g root -m 0644 "$SCRIPT_DIR/$UNIT_NAME" "$UNIT_TMP"
mv -T -- "$UNIT_TMP" "$UNIT_FILE"
UNIT_TMP=
systemctl daemon-reload

trap - EXIT HUP INT TERM
printf 'Prepared immutable gateway release %s and atomically promoted its code and unit.\n' "$RELEASE_ID"
