# Bitrix read-only gateway

Deploy only a reviewed commit from a clean checkout, through the fixed root-owned installer. It creates an immutable gateway release and rolls back a failed promotion itself:

```sh
/usr/bin/sudo /usr/local/lib/iva-bitrix-admin/install <reviewed-commit>
```

Do not run repository deployment scripts with sudo directly. Before any guarded operator preflight, open the temporary window and run the installed immutable copy with a task id that has already been authorized for this check:

```sh
source /usr/local/lib/iva-bitrix-admin/guarded-window.sh
iva_guard_begin
iva_guard_open_sudo_window
/usr/bin/sudo -u iva-bitrix /usr/bin/node --env-file=/etc/iva-bitrix/bitrix.env /usr/local/lib/iva-bitrix-gateway/current/preflight-read-state.mjs <authorized-task-id-with-chat>
```

The normal IVA service is installed from the reviewed checkout through the versioned installer entrypoint:

The root helper must receive `LIVE_REPO` as an absolute, clean reviewed checkout.
The production deployment root is a bare Git mirror and is not a valid value.

```sh
"$LIVE_REPO/bin/iva.mjs" _install-units
ExecStart=$NODE24_BIN_DIR/node --env-file=.env scripts/bitrix-sync.ts --daily
```

If a release must be reverted, use the versioned IVA rollback procedure; do not edit `/usr/local/lib/iva-bitrix-gateway/current` or its source files in place.
