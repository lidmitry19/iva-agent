import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const deployRoot = new URL(
  "../../services/bitrix-gateway/deploy/",
  import.meta.url,
);

test("systemd unit runs a root-owned installed copy under a separate UID and group-readable socket", async () => {
  const unit = await readFile(
    new URL("iva-bitrix-gateway.service", deployRoot),
    "utf8",
  );
  assert.match(unit, /^User=iva-bitrix$/mu);
  assert.match(unit, /^Group=iva$/mu);
  assert.match(unit, /^SupplementaryGroups=iva-bitrix$/mu);
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/iva-bitrix-gateway\/current\/server\.mjs$/mu,
  );
  assert.doesNotMatch(unit, /\/home\/iva\/iva/iu);
  assert.match(unit, /^EnvironmentFile=\/etc\/iva-bitrix\/bitrix\.env$/mu);
  assert.match(unit, /^UMask=0007$/mu);
  assert.match(unit, /^LimitCORE=0$/mu);
  assert.match(unit, /^ProtectSystem=strict$/mu);
  assert.match(unit, /^ProtectHome=yes$/mu);
  assert.match(unit, /^NoNewPrivileges=yes$/mu);
  assert.match(unit, /^CapabilityBoundingSet=$/mu);
});

test("installer accepts only a reviewed release, validates the secret, and atomically promotes immutable root-owned code", async () => {
  const installer = await readFile(new URL("install.sh", deployRoot), "utf8");
  assert.match(installer, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu);
  assert.match(installer, /^export PATH$/mu);
  assert.ok(
    installer.indexOf("PATH=/usr/sbin:/usr/bin:/sbin:/bin") <
      installer.indexOf("$(id -u)"),
  );
  assert.match(installer, /\[ "\$#" -eq 1 \]/u);
  assert.match(installer, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(installer, /IVA_BITRIX_TRANSACTION/u);
  assert.match(installer, /SECRET_FILE=\/etc\/iva-bitrix\/bitrix\.env/u);
  assert.match(installer, /must be owned by iva-bitrix:iva-bitrix/u);
  assert.match(installer, /must have mode 600/u);
  assert.match(
    installer,
    /INSTALL_ROOT=\/usr\/local\/lib\/iva-bitrix-gateway/u,
  );
  assert.match(installer, /RELEASES_DIR=\$INSTALL_ROOT\/releases/u);
  assert.match(installer, /CURRENT_LINK=\$INSTALL_ROOT\/current/u);
  assert.match(installer, /root-only 0700 staging snapshot/u);
  assert.match(
    installer,
    /mktemp -d "\$RELEASES_DIR\/\.\$\{RELEASE_ID\}\.XXXXXX"/u,
  );
  assert.match(installer, /chmod 0700 "\$CANDIDATE_DIR"/u);
  assert.match(installer, /install -o root -g root -m 0644/u);
  assert.match(installer, /validate_release "\$RELEASE_DIR"/u);
  assert.match(installer, /mv -T -- "\$CANDIDATE_DIR" "\$RELEASE_DIR"/u);
  assert.match(installer, /ln -s -- "releases\/\$RELEASE_ID" "\$CURRENT_TMP"/u);
  assert.match(installer, /mv -Tf -- "\$CURRENT_TMP" "\$CURRENT_LINK"/u);
  assert.match(installer, /mv -T -- "\$UNIT_TMP" "\$UNIT_FILE"/u);
  assert.doesNotMatch(
    installer,
    /read .*BITRIX_WEBHOOK|echo .*BITRIX_WEBHOOK|printf .*BITRIX_WEBHOOK_URL=https|\bsudo\b/iu,
  );
});

test("deployment example defaults the chat read-state gate to false and contains no webhook", async () => {
  const example = await readFile(
    new URL("bitrix.env.example", deployRoot),
    "utf8",
  );
  assert.match(example, /^BITRIX_CHAT_READ_VERIFIED=false$/mu);
  assert.match(example, /^BITRIX_WEBHOOK_URL=$/mu);
  assert.doesNotMatch(example, /https?:\/\//iu);
});

test("deployment guidance invokes only the fixed root helper and uses current entrypoint paths", async () => {
  const repoRoot = new URL("../../", import.meta.url);
  const [docs, envExample] = await Promise.all([
    readFile(new URL("docs/bitrix-readonly.md", repoRoot), "utf8"),
    readFile(new URL(".env.example", repoRoot), "utf8"),
  ]);

  assert.match(
    docs,
    /\/usr\/bin\/sudo \/usr\/local\/lib\/iva-bitrix-admin\/install/u,
  );
  assert.match(
    envExample,
    /sudo \/usr\/local\/lib\/iva-bitrix-admin\/install <reviewed-commit>/u,
  );
  assert.doesNotMatch(
    `${docs}\n${envExample}`,
    /sudo\s+(?:\.\/)?services\/bitrix-gateway\/deploy\/(?:install|install-and-start)\.sh/iu,
  );
  assert.match(
    docs,
    /\/usr\/local\/lib\/iva-bitrix-gateway\/current\/preflight-read-state\.mjs/u,
  );
  assert.match(docs, /"\$LIVE_REPO\/bin\/iva\.mjs" _install-units/u);
  assert.match(
    docs,
    /ExecStart=\$NODE24_BIN_DIR\/node --env-file=\.env scripts\/bitrix-sync\.ts --daily/u,
  );
  assert.doesNotMatch(
    docs,
    /preflight-read-state\.ts|bin\/iva\.ts|--import=tsx/iu,
  );
});

test("guarded sudo window persists state, orders stops/restores, and fails closed", async () => {
  const guard = await readFile(
    new URL("guarded-window.sh", deployRoot),
    "utf8",
  );
  const begin = guard.indexOf("iva_guard_begin()");
  const publishState = guard.indexOf(
    'iva_guard__publish_content "$state" "$content"',
    begin,
  );
  const armed = guard.indexOf("IVA_GUARD_ARMED=1", begin);
  const exitTrap = guard.indexOf("trap 'iva_guard__on_exit $?' EXIT", begin);
  const stopCall = guard.indexOf("iva_guard__stop_expected_units", exitTrap);
  const stopFunction = guard.indexOf("iva_guard__stop_expected_units()");
  const stopTimer = guard.indexOf(
    '/usr/bin/systemctl --user stop "$unit"',
    stopFunction,
  );
  const stopOther = guard.indexOf(
    '/usr/bin/systemctl --user stop "$unit"',
    stopTimer + 1,
  );
  const stopMain = guard.indexOf(
    "/usr/bin/systemctl --user stop iva.service",
    stopOther,
  );
  const restoreFunction = guard.indexOf("iva_guard__restore_units()");
  const restoreMain = guard.indexOf(
    "/usr/bin/systemctl --user start iva.service",
    restoreFunction,
  );
  const restoreOther = guard.indexOf(
    '/usr/bin/systemctl --user start "$unit"',
    restoreMain,
  );
  const restoreTimer = guard.indexOf(
    '/usr/bin/systemctl --user start "$unit"',
    restoreOther + 1,
  );
  const openSudo = guard.indexOf("iva_guard_open_sudo_window()");
  const positiveProbe = guard.indexOf(
    "/usr/bin/sudo -n /usr/bin/true",
    openSudo,
  );
  const cleanup = guard.indexOf("iva_guard__cleanup()");
  const ignoreSignals = guard.indexOf("trap '' HUP INT TERM", cleanup);
  const clearExit = guard.indexOf("trap - EXIT", cleanup);
  const invalidate = guard.indexOf("/usr/bin/sudo -k", cleanup);
  const proveGone = guard.indexOf("/usr/bin/sudo -n /usr/bin/true", cleanup);
  const stickyRestop = guard.indexOf(
    "iva_guard__stop_expected_units || true",
    proveGone,
  );
  const recoverCall = guard.indexOf("iva_guard_recover_app;", stickyRestop);
  const appRestop = guard.indexOf(
    "iva_guard__stop_expected_units || true",
    recoverCall,
  );
  const restoreCall = guard.indexOf(
    'iva_guard__restore_units "$IVA_GUARD_STATE"',
    appRestop,
  );
  const restoreRestop = guard.indexOf(
    "iva_guard__stop_expected_units || true",
    restoreCall,
  );

  assert.ok(begin >= 0 && publishState > begin && publishState < armed);
  assert.ok(armed < exitTrap && exitTrap < stopCall);
  assert.ok(stopFunction >= 0 && stopTimer < stopOther && stopOther < stopMain);
  assert.ok(
    restoreFunction >= 0 &&
      restoreMain < restoreOther &&
      restoreOther < restoreTimer,
  );
  assert.ok(openSudo >= 0 && positiveProbe > openSudo);
  assert.ok(
    ignoreSignals > cleanup &&
      ignoreSignals < clearExit &&
      clearExit < invalidate,
  );
  assert.ok(
    invalidate < proveGone &&
      proveGone < stickyRestop &&
      stickyRestop < recoverCall,
  );
  assert.ok(
    recoverCall < appRestop &&
      appRestop < restoreCall &&
      restoreCall < restoreRestop,
  );
  assert.match(
    guard,
    /cannot source guarded-window\.sh while a guard is armed/u,
  );
  assert.match(
    guard,
    /application state requires one armed guard and cannot be replaced/u,
  );
  assert.match(guard, /set -o noclobber/u);
  assert.match(guard, /\/usr\/bin\/ln -T -- "\$tmp" "\$state"/u);
  assert.match(guard, /IVA unit recovery state changed after capture/u);
  assert.match(
    guard,
    /stale recovery state exists; inspect it before retrying/u,
  );
  assert.match(guard, /transitional IVA unit state; nothing was stopped/u);
  assert.match(
    guard,
    /application rollback failed; recovery state preserved; live set/u,
  );
  assert.match(
    guard,
    /IVA restore failed; recovery state preserved; live set/u,
  );
  assert.doesNotMatch(guard, /\beval\b|sudo\s+(?:bash|sh)\s+-c/iu);
});

test("transactional root wrapper restores prior link, unit, enablement, and activity on any failed promotion", async () => {
  const wrapper = await readFile(
    new URL("install-and-start.sh", deployRoot),
    "utf8",
  );
  const cleanup = wrapper.indexOf("cleanup()");
  const ignoreSignals = wrapper.indexOf("trap '' HUP INT TERM", cleanup);
  const clearExit = wrapper.indexOf("trap - EXIT", cleanup);
  const stop = wrapper.indexOf('systemctl stop "$UNIT"', cleanup);
  const restoreCurrent = wrapper.indexOf("restore_current ||", stop);
  const restoreUnit = wrapper.indexOf("if ! restore_unit", restoreCurrent);
  const daemonReload = wrapper.indexOf("systemctl daemon-reload", restoreUnit);
  const restoredUnitInvariant = wrapper.indexOf(
    "loaded_gateway_unit_is_exact",
    daemonReload,
  );
  const restoreEnablement = wrapper.indexOf(
    "restore_enablement ||",
    restoredUnitInvariant,
  );
  const restoreActivity = wrapper.indexOf(
    "restore_activity ||",
    restoreEnablement,
  );
  const verifyRollback = wrapper.indexOf("verify_rollback ||", restoreActivity);
  const removeRelease = wrapper.indexOf(
    "remove_new_release ||",
    verifyRollback,
  );
  const installer = wrapper.indexOf(
    '/usr/bin/env IVA_BITRIX_TRANSACTION=1 /bin/sh "$SCRIPT_DIR/install.sh" "$RELEASE_ID"',
  );
  const loadedUnitInvariant = wrapper.indexOf(
    "\nassert_exact_loaded_gateway_unit\n",
    installer,
  );
  const unitCat = wrapper.indexOf(
    'systemctl cat --no-pager "$UNIT"',
    loadedUnitInvariant,
  );
  const enable = wrapper.indexOf('systemctl enable "$UNIT"', unitCat);
  const restart = wrapper.indexOf('systemctl restart "$UNIT"', enable);
  const socketWait = wrapper.indexOf('while [ ! -S "$SOCKET" ]', restart);
  const health = wrapper.indexOf(
    "health_json=$(/usr/bin/curl --fail --silent --show-error",
    socketWait,
  );
  const curlFailure = wrapper.indexOf(
    "fail 'gateway health request failed'",
    health,
  );
  const parseHealth = wrapper.indexOf("/usr/bin/python3 -c", curlFailure);
  const commit = wrapper.indexOf("CLEANUP_NEEDED=0", parseHealth);
  const validation = wrapper.indexOf('[ "$#" -eq 1 ]');
  const dropinProbe = wrapper.indexOf(
    "\nassert_no_gateway_dropins\n",
    validation,
  );
  const hiddenUnitProbe = wrapper.indexOf(
    "assert_no_hidden_gateway_unit",
    dropinProbe,
  );
  const rollbackSnapshot = wrapper.indexOf(
    "ROLLBACK_ROOT=$(mktemp -d /run/iva-bitrix-rollback.",
    hiddenUnitProbe,
  );

  assert.match(wrapper, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu);
  assert.match(wrapper, /\[ "\$#" -eq 1 \]/u);
  assert.match(wrapper, /\[ "\$\(id -u\)" -eq 0 \]/u);
  assert.ok(
    validation >= 0 &&
      dropinProbe > validation &&
      hiddenUnitProbe > validation &&
      hiddenUnitProbe > dropinProbe &&
      rollbackSnapshot > hiddenUnitProbe,
    "systemd drop-ins and hidden definitions must be rejected before rollback/mutation state is created",
  );
  assert.match(wrapper, /\/etc\/systemd\/system/u);
  assert.match(wrapper, /\/run\/systemd\/system/u);
  assert.match(wrapper, /\/usr\/local\/lib\/systemd\/system/u);
  assert.match(wrapper, /\/usr\/lib\/systemd\/system/u);
  assert.match(wrapper, /\/lib\/systemd\/system/u);
  assert.match(wrapper, /--property=LoadState/u);
  assert.match(wrapper, /--property=FragmentPath/u);
  assert.match(wrapper, /--property=Transient/u);
  assert.ok(cleanup >= 0 && ignoreSignals < clearExit && clearExit < stop);
  assert.ok(
    stop < restoreCurrent &&
      restoreCurrent < restoreUnit &&
      restoreUnit < daemonReload,
  );
  assert.ok(
    daemonReload < restoredUnitInvariant &&
      restoredUnitInvariant < restoreEnablement &&
      restoreEnablement < restoreActivity &&
      restoreActivity < verifyRollback &&
      verifyRollback < removeRelease,
  );
  assert.match(
    wrapper,
    /UNIT_BACKUP=\$ROLLBACK_ROOT\/iva-bitrix-gateway\.service/u,
  );
  assert.match(wrapper, /PREVIOUS_CURRENT=\$\(readlink -- "\$CURRENT_LINK"\)/u);
  assert.match(wrapper, /PREVIOUS_ENABLE_STATE=\$\(systemctl is-enabled/u);
  assert.match(wrapper, /PREVIOUS_ACTIVE_STATE=\$\(systemctl show/u);
  assert.match(
    wrapper,
    /gateway rollback failed; root-only recovery snapshot preserved/u,
  );
  assert.match(
    wrapper,
    /readlink -- "\$CURRENT_LINK"\)" != "releases\/\$RELEASE_ID"/u,
  );
  assert.ok(
    installer >= 0 &&
      installer < loadedUnitInvariant &&
      loadedUnitInvariant < unitCat &&
      unitCat < enable &&
      enable < restart &&
      restart < socketWait &&
      socketWait < health,
  );
  assert.match(wrapper, /systemctl cat --no-pager "\$UNIT"/u);
  assert.match(wrapper, /--property=DropInPaths/u);
  assert.match(wrapper, /systemctl is-active --quiet "\$UNIT"/u);
  assert.match(wrapper, /socket_attempts=\$\(\(socket_attempts \+ 1\)\)/u);
  assert.match(wrapper, /\[ "\$socket_attempts" -lt 40 \]/u);
  assert.match(wrapper, /sleep 0\.25/u);
  assert.ok(
    health < curlFailure && curlFailure < parseHealth && parseHealth < commit,
  );
  assert.match(wrapper, /--connect-timeout 2 --max-time 30/u);
  assert.match(wrapper, /--unix-socket "\$SOCKET" http:\/\/localhost\/health/u);
  assert.match(
    wrapper,
    /data\.get\("ok"\) is True and data\.get\("ready"\) is True/u,
  );
  assert.doesNotMatch(
    wrapper,
    /daemon-reload \|\| true|enable --now|BITRIX_WEBHOOK_URL|\bsudo\b/iu,
  );
});

test("first install rejects vendor, runtime, transient, and unprovable units before mutation", async (t) => {
  const wrapper = await readFile(
    new URL("install-and-start.sh", deployRoot),
    "utf8",
  );
  const validation = wrapper.indexOf('[ "$#" -eq 1 ]');
  assert.ok(validation > 0);
  const functions = wrapper.slice(0, validation);
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-hidden-unit-"));
  const harnessPath = join(root, "hidden-unit-harness.sh");
  const harness = `${functions}
TEST_ROOT=$1
MODE=$2
UNIT=iva-bitrix-gateway.service
UNIT_FILE=$TEST_ROOT/iva-bitrix-gateway.service

systemctl() {
  case "$MODE" in
    absent)
      printf '%s\\n' 'LoadState=not-found' 'FragmentPath=' 'Transient=no'
      ;;
    vendor)
      printf '%s\\n' 'LoadState=loaded' 'FragmentPath=/usr/lib/systemd/system/iva-bitrix-gateway.service' 'Transient=no'
      ;;
    runtime)
      printf '%s\\n' 'LoadState=loaded' 'FragmentPath=/run/systemd/system/iva-bitrix-gateway.service' 'Transient=no'
      ;;
    transient)
      printf '%s\\n' 'LoadState=loaded' 'FragmentPath=' 'Transient=yes'
      ;;
    probe-failure)
      return 1
      ;;
    existing)
      return 99
      ;;
  esac
}

if [ "$MODE" = existing ]; then
  : > "$UNIT_FILE"
fi
assert_no_hidden_gateway_unit
printf '%s\\n' MUTATION
`;
  try {
    await writeFile(harnessPath, harness, { mode: 0o700 });
    for (const mode of ["vendor", "runtime", "transient", "probe-failure"]) {
      await t.test(mode, () => {
        const result = spawnSync("/bin/sh", [harnessPath, root, mode], {
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
        assert.doesNotMatch(result.stdout, /MUTATION/u);
        assert.match(result.stderr, /nothing was changed/iu);
      });
    }
    for (const mode of ["absent", "existing"]) {
      await t.test(mode, () => {
        const result = spawnSync("/bin/sh", [harnessPath, root, mode], {
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^MUTATION$/mu);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy preflights reject stale and drop-in-only systemd overrides before mutation", async (t) => {
  const [wrapper, admin] = await Promise.all([
    readFile(new URL("install-and-start.sh", deployRoot), "utf8"),
    readFile(new URL("admin-install.sh", deployRoot), "utf8"),
  ]);
  const variants = [
    { label: "transactional wrapper", shell: "/bin/sh", source: wrapper },
    { label: "admin boundary", shell: "/usr/bin/bash", source: admin },
  ];
  const cases = [
    { label: "unit-and-stale-dropin", unit: true, kind: "file" },
    { label: "dropin-only", unit: false, kind: "file" },
    { label: "dangling-hostile-dropin", unit: false, kind: "symlink" },
  ];

  for (const variant of variants) {
    await t.test(variant.label, async (t) => {
      const functionMatch = variant.source.match(
        /assert_no_gateway_dropins\(\) \{[\s\S]*?\n\}/u,
      );
      assert.ok(functionMatch, "drop-in preflight function is missing");
      const root = await mkdtemp(join(tmpdir(), "iva-bitrix-dropin-"));
      const harnessPath = join(root, "dropin-harness.sh");
      const harness = `set -eu
UNIT=iva-bitrix-gateway.service
SYSTEM_UNIT_DIRS=$1
fail() {
  printf '%s\\n' "$1" >&2
  exit 37
}
${functionMatch[0]}
assert_no_gateway_dropins
printf '%s\\n' MUTATION > "$2"
`;

      try {
        await writeFile(harnessPath, harness, { mode: 0o700 });
        for (const scenario of cases) {
          await t.test(scenario.label, async () => {
            const systemRoot = join(root, scenario.label, "system");
            const unitPath = join(systemRoot, "iva-bitrix-gateway.service");
            const dropinDir = `${unitPath}.d`;
            const dropinPath = join(dropinDir, "90-hostile.conf");
            const markerPath = join(root, `${scenario.label}.mutation`);
            await mkdir(dropinDir, { recursive: true });
            if (scenario.unit) {
              await writeFile(unitPath, "[Unit]\n", "utf8");
            }
            if (scenario.kind === "symlink") {
              await symlink(join(root, "missing-target.conf"), dropinPath);
            } else {
              await writeFile(
                dropinPath,
                "[Service]\nExecStart=/tmp/hostile\n",
                "utf8",
              );
            }

            const result = spawnSync(
              variant.shell,
              [harnessPath, systemRoot, markerPath],
              { encoding: "utf8" },
            );
            assert.equal(result.status, 37, result.stderr);
            assert.match(result.stderr, /drop-in[\s\S]*nothing was changed/iu);
            await assert.rejects(
              readFile(markerPath),
              (error) => error?.code === "ENOENT",
            );
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("post-reload systemd identity mismatches roll back before enable or restart", async (t) => {
  const wrapper = await readFile(
    new URL("install-and-start.sh", deployRoot),
    "utf8",
  );
  const validation = wrapper.indexOf('[ "$#" -eq 1 ]');
  assert.ok(validation > 0);
  const functions = wrapper.slice(0, validation);
  const cases = [
    "fragment-mismatch",
    "transient",
    "dropin-paths",
    "missing-metadata",
  ];
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-loaded-unit-"));
  const harnessPath = join(root, "loaded-unit-harness.sh");
  const harness = `${functions}
TEST_ROOT=$1
MODE=$2
UNIT=iva-bitrix-gateway.service
UNIT_FILE=$TEST_ROOT/iva-bitrix-gateway.service
INSTALL_ROOT=$TEST_ROOT/install
RELEASES_DIR=$INSTALL_ROOT/releases
CURRENT_LINK=$INSTALL_ROOT/current
RELEASE_ID=0123456789abcdef0123456789abcdef01234567
RELEASE_DIR=$RELEASES_DIR/$RELEASE_ID
ROLLBACK_ROOT=
UNIT_BACKUP=
PREVIOUS_UNIT_PRESENT=0
PREVIOUS_CURRENT_PRESENT=0
PREVIOUS_ENABLE_STATE=absent
PREVIOUS_ACTIVE_STATE=inactive
RELEASE_EXISTED=1
ROLLBACK_ARMED=1
CLEANUP_NEEDED=1

systemctl() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/systemctl.log"
  case "$1" in
    show)
      case "$*" in
        *--property=LoadState*)
          printf '%s\\n' 'LoadState=loaded'
          case "$MODE" in
            fragment-mismatch) printf '%s\\n' 'FragmentPath=/usr/lib/systemd/system/iva-bitrix-gateway.service' ;;
            *) printf 'FragmentPath=%s\\n' "$UNIT_FILE" ;;
          esac
          case "$MODE" in
            transient) printf '%s\\n' 'Transient=yes' ;;
            *) printf '%s\\n' 'Transient=no' ;;
          esac
          case "$MODE" in
            dropin-paths) printf '%s\\n' 'DropInPaths=/etc/systemd/system/iva-bitrix-gateway.service.d/90-hostile.conf' ;;
            missing-metadata) ;;
            *) printf '%s\\n' 'DropInPaths=' ;;
          esac
          ;;
        *) printf '%s\\n' inactive ;;
      esac
      ;;
    is-enabled|is-active) return 1 ;;
    stop|daemon-reload|disable) return 0 ;;
    enable|restart) return 0 ;;
    *) return 1 ;;
  esac
}

stat() {
  printf '%s\\n' root:root
}

printf '%s\\n' '[Unit]' > "$UNIT_FILE"
trap cleanup EXIT
assert_exact_loaded_gateway_unit
systemctl enable "$UNIT"
systemctl restart "$UNIT"
CLEANUP_NEEDED=0
`;

  try {
    await writeFile(harnessPath, harness, { mode: 0o700 });
    for (const mode of cases) {
      await t.test(mode, async () => {
        const caseRoot = join(root, mode);
        await mkdir(caseRoot, { recursive: true });
        const result = spawnSync("/bin/sh", [harnessPath, caseRoot, mode], {
          encoding: "utf8",
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /rolling back/iu);
        const calls = await readFile(join(caseRoot, "systemctl.log"), "utf8");
        assert.doesNotMatch(calls, /^(?:enable|restart) /mu);
        assert.match(calls, /^stop iva-bitrix-gateway\.service$/mu);
        assert.match(calls, /^daemon-reload$/mu);
        await assert.rejects(
          readFile(join(caseRoot, "iva-bitrix-gateway.service")),
          (error) => error?.code === "ENOENT",
        );
      });
    }
    await t.test("exact identity proceeds", async () => {
      const caseRoot = join(root, "exact");
      await mkdir(caseRoot, { recursive: true });
      const result = spawnSync("/bin/sh", [harnessPath, caseRoot, "exact"], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = await readFile(join(caseRoot, "systemctl.log"), "utf8");
      assert.match(calls, /^enable iva-bitrix-gateway\.service$/mu);
      assert.match(calls, /^restart iva-bitrix-gateway\.service$/mu);
      assert.doesNotMatch(calls, /^stop /mu);
      assert.equal(
        await readFile(join(caseRoot, "iva-bitrix-gateway.service"), "utf8"),
        "[Unit]\n",
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback revalidates a restored active unit before enabling or restarting it", async (t) => {
  const wrapper = await readFile(
    new URL("install-and-start.sh", deployRoot),
    "utf8",
  );
  const validation = wrapper.indexOf('[ "$#" -eq 1 ]');
  assert.ok(validation > 0);
  const functions = wrapper.slice(0, validation);
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-restored-unit-"));
  const harnessPath = join(root, "restored-unit-harness.sh");
  const harness = `${functions}
TEST_ROOT=$1
MODE=$2
UNIT=iva-bitrix-gateway.service
UNIT_FILE=$TEST_ROOT/iva-bitrix-gateway.service
INSTALL_ROOT=$TEST_ROOT/install
RELEASES_DIR=$INSTALL_ROOT/releases
CURRENT_LINK=$INSTALL_ROOT/current
RELEASE_ID=0123456789abcdef0123456789abcdef01234567
RELEASE_DIR=$RELEASES_DIR/$RELEASE_ID
ROLLBACK_ROOT=/run/iva-bitrix-rollback.test-$$
UNIT_BACKUP=$TEST_ROOT/iva-bitrix-gateway.service.backup
PREVIOUS_UNIT_PRESENT=1
PREVIOUS_CURRENT_PRESENT=0
PREVIOUS_CURRENT=
PREVIOUS_ENABLE_STATE=enabled
PREVIOUS_ACTIVE_STATE=active
RELEASE_EXISTED=1
ROLLBACK_ARMED=1
CLEANUP_NEEDED=1

mktemp() {
  case "$1" in
    /etc/systemd/system/.iva-bitrix-gateway.service.rollback.XXXXXX)
      printf '%s\\n' "$TEST_ROOT/restored-unit.tmp"
      ;;
    *) return 1 ;;
  esac
}

install() {
  command cp -- "$7" "$8"
}

rm() {
  printf 'rm %s\\n' "$*" >> "$TEST_ROOT/systemctl.log"
  return 0
}

systemctl() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/systemctl.log"
  case "$1" in
    show)
      case "$*" in
        *--property=LoadState*)
          printf '%s\\n' 'LoadState=loaded'
          case "$MODE" in
            fragment-mismatch) printf '%s\\n' 'FragmentPath=/usr/lib/systemd/system/iva-bitrix-gateway.service' ;;
            exact) printf 'FragmentPath=%s\\n' "$UNIT_FILE" ;;
            *) return 1 ;;
          esac
          printf '%s\\n' 'Transient=no' 'DropInPaths='
          ;;
        *--property=ActiveState*)
          cat "$TEST_ROOT/active-state"
          ;;
        *) return 1 ;;
      esac
      ;;
    stop)
      printf '%s\\n' inactive > "$TEST_ROOT/active-state"
      ;;
    restart)
      printf '%s\\n' active > "$TEST_ROOT/active-state"
      ;;
    is-enabled)
      printf '%s\\n' enabled
      ;;
    is-active)
      [ "$(cat "$TEST_ROOT/active-state")" = active ]
      ;;
    daemon-reload|disable|enable)
      return 0
      ;;
    *) return 1 ;;
  esac
}

mkdir -p "$INSTALL_ROOT"
printf '%s\\n' '[Unit]' 'Description=previous' > "$UNIT_BACKUP"
printf '%s\\n' '[Unit]' 'Description=candidate' > "$UNIT_FILE"
printf '%s\\n' active > "$TEST_ROOT/active-state"
trap cleanup EXIT
exit 42
`;

  try {
    await writeFile(harnessPath, harness, { mode: 0o700 });
    await t.test("mismatched restored identity remains stopped", async () => {
      const caseRoot = join(root, "fragment-mismatch");
      await mkdir(caseRoot, { recursive: true });
      const result = spawnSync(
        "/bin/sh",
        [harnessPath, caseRoot, "fragment-mismatch"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 121, result.stderr);
      assert.match(result.stderr, /identity is unsafe; keeping it stopped/u);
      assert.match(result.stderr, /recovery snapshot preserved/u);
      const calls = await readFile(join(caseRoot, "systemctl.log"), "utf8");
      const reload = calls.indexOf("daemon-reload");
      const identity = calls.indexOf(
        "show iva-bitrix-gateway.service --property=LoadState",
      );
      assert.ok(reload >= 0 && reload < identity);
      assert.doesNotMatch(calls, /^(?:enable|restart) /mu);
      assert.doesNotMatch(calls, /^rm .*iva-bitrix-rollback/mu);
      assert.equal(
        await readFile(join(caseRoot, "active-state"), "utf8"),
        "inactive\n",
      );
      assert.equal(
        await readFile(join(caseRoot, "iva-bitrix-gateway.service"), "utf8"),
        "[Unit]\nDescription=previous\n",
      );
    });

    await t.test("exact restored identity may restart", async () => {
      const caseRoot = join(root, "exact");
      await mkdir(caseRoot, { recursive: true });
      const result = spawnSync("/bin/sh", [harnessPath, caseRoot, "exact"], {
        encoding: "utf8",
      });
      assert.equal(result.status, 42, result.stderr);
      assert.doesNotMatch(result.stderr, /rollback failed/u);
      const calls = await readFile(join(caseRoot, "systemctl.log"), "utf8");
      const reload = calls.indexOf("daemon-reload");
      const identity = calls.indexOf(
        "show iva-bitrix-gateway.service --property=LoadState",
      );
      const enable = calls.indexOf("enable iva-bitrix-gateway.service");
      const restart = calls.indexOf("restart iva-bitrix-gateway.service");
      assert.ok(
        reload >= 0 &&
          reload < identity &&
          identity < enable &&
          enable < restart,
      );
      assert.match(calls, /^rm .*iva-bitrix-rollback/mu);
      assert.equal(
        await readFile(join(caseRoot, "active-state"), "utf8"),
        "active\n",
      );
      assert.equal(
        await readFile(join(caseRoot, "iva-bitrix-gateway.service"), "utf8"),
        "[Unit]\nDescription=previous\n",
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-install health failure rolls back an absent unit without stopping it after removal", async () => {
  const wrapper = await readFile(
    new URL("install-and-start.sh", deployRoot),
    "utf8",
  );
  const validation = wrapper.indexOf('[ "$#" -eq 1 ]');
  assert.ok(validation > 0);
  const functions = wrapper.slice(0, validation);
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-first-install-"));
  const harnessPath = join(root, "rollback-harness.sh");
  const harness = `${functions}
TEST_ROOT=$1
UNIT_FILE=$TEST_ROOT/iva-bitrix-gateway.service
INSTALL_ROOT=$TEST_ROOT/install
RELEASES_DIR=$INSTALL_ROOT/releases
CURRENT_LINK=$INSTALL_ROOT/current
RELEASE_ID=0123456789abcdef0123456789abcdef01234567
RELEASE_DIR=$RELEASES_DIR/$RELEASE_ID
ROLLBACK_ROOT=
PREVIOUS_UNIT_PRESENT=0
PREVIOUS_CURRENT_PRESENT=0
PREVIOUS_ENABLE_STATE=absent
PREVIOUS_ACTIVE_STATE=inactive
RELEASE_EXISTED=1
ROLLBACK_ARMED=1
CLEANUP_NEEDED=1

systemctl() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/systemctl.log"
  case "$1" in
    stop)
      [ -e "$UNIT_FILE" ]
      ;;
    show)
      printf '%s\\n' inactive
      ;;
    is-enabled|is-active)
      return 1
      ;;
    daemon-reload|disable)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

stat() {
  printf '%s\\n' root:root
}

mkdir -p "$RELEASE_DIR"
ln -s "releases/$RELEASE_ID" "$CURRENT_LINK"
printf '%s\\n' '[Unit]' > "$UNIT_FILE"
trap cleanup EXIT
exit 42
`;
  try {
    await writeFile(harnessPath, harness, { mode: 0o700 });
    const result = spawnSync("/bin/sh", [harnessPath, root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 42, result.stderr);
    assert.doesNotMatch(result.stderr, /rollback failed/u);
    const calls = await readFile(join(root, "systemctl.log"), "utf8");
    assert.equal(
      calls.split("\\n").filter((line) => line.startsWith("stop ")).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admin installer binds current to the reviewed commit in the versioned layout", async (t) => {
  const admin = await readFile(new URL("admin-install.sh", deployRoot), "utf8");
  const functionMatch = admin.match(/bind_reviewed_source\(\) \{[\s\S]*?\n\}/u);
  assert.ok(functionMatch, "versioned source binder is missing");

  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-versioned-source-"));
  const versions = join(root, "versions");
  const repo = join(root, "repo");
  const current = join(root, "current");
  const expected = "a".repeat(40);
  const matching = join(versions, `0.3.34-${expected.slice(0, 12)}+12345678`);
  const wrong = join(versions, `0.3.34-${"b".repeat(12)}+12345678`);
  const outside = join(root, "outside", `0.3.34-${expected.slice(0, 12)}`);
  const harnessPath = join(root, "bind-reviewed-source.sh");
  const harness = `#!/usr/bin/bash
set -Eeuo pipefail
IVA_LAYOUT=$1
CURRENT_LINK=$2
VERSIONS_DIR=$3
REPO_STORE=$4
EXPECTED_COMMIT=$5
LIVE_SOURCE=
fail() {
  printf '%s\\n' "$1" >&2
  exit 37
}
run_git_repo_as_iva() {
  case "$*" in
    "rev-parse --is-bare-repository") printf '%s\\n' true ;;
    "rev-parse --verify --end-of-options $EXPECTED_COMMIT^{commit}") printf '%s\\n' "$EXPECTED_COMMIT" ;;
    *) return 1 ;;
  esac
}
${functionMatch[0]}
bind_reviewed_source
printf '%s\\n' "$LIVE_SOURCE"
`;

  try {
    await Promise.all([
      mkdir(matching, { recursive: true }),
      mkdir(wrong, { recursive: true }),
      mkdir(outside, { recursive: true }),
      mkdir(repo, { recursive: true }),
    ]);
    await writeFile(harnessPath, harness, { mode: 0o700 });

    await t.test("matching current version succeeds", async () => {
      await symlink(matching, current);
      const result = spawnSync(
        "/usr/bin/bash",
        [harnessPath, root, current, versions, repo, expected],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), matching);
      await rm(current, { force: true });
    });

    for (const scenario of [
      {
        label: "wrong commit prefix fails closed",
        target: wrong,
        error: /does not match the reviewed commit/u,
      },
      {
        label: "target outside versions fails closed",
        target: outside,
        error: /outside the version store/u,
      },
    ]) {
      await t.test(scenario.label, async () => {
        await symlink(scenario.target, current);
        const result = spawnSync(
          "/usr/bin/bash",
          [harnessPath, root, current, versions, repo, expected],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 37, result.stderr);
        assert.match(result.stderr, scenario.error);
        await rm(current, { force: true });
      });
    }

    await t.test("a non-symlink current directory fails closed", async () => {
      await mkdir(current);
      const result = spawnSync(
        "/usr/bin/bash",
        [harnessPath, root, current, versions, repo, expected],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 37, result.stderr);
      assert.match(result.stderr, /current must be a symlink/u);
      await rm(current, { recursive: true, force: true });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admin installer uses a pinned root copy, guards IVA units, and invalidates the caller ticket", async () => {
  const admin = await readFile(new URL("admin-install.sh", deployRoot), "utf8");
  const dropinPreflight = admin.indexOf("\nassert_no_gateway_dropins\n");
  const sourceBind = admin.indexOf("\nbind_reviewed_source\n");
  const stage = admin.indexOf(
    "STAGE_ROOT=$(/usr/bin/mktemp -d /run/iva-bitrix-admin-stage.XXXXXX)",
  );
  const manifestWrite = admin.indexOf(
    'write_manifest > "$MANIFEST_FILE"',
    stage,
  );
  const snapshotCopy = admin.indexOf(
    '/usr/bin/install -o root -g root -m 0600 -- "$source" "$staged"',
    manifestWrite,
  );
  const commitProof = admin.indexOf(
    'run_git_repo_as_iva show "$EXPECTED_COMMIT:$relative"',
    manifestWrite,
  );
  const manifest = admin.indexOf("/usr/bin/sha256sum -c --strict");
  const capture = admin.indexOf("active=$(list_active_units)", manifest);
  const publish = admin.indexOf(
    '/usr/bin/ln -T -- "$tmp_state" "$STATE_FILE"',
    capture,
  );
  const stop = admin.indexOf('stop_unit_set "$EXPECTED_UNITS"', publish);
  const installer = admin.indexOf(
    '/bin/sh "$STAGE_ROOT/$INSTALLER_REL" "$EXPECTED_COMMIT"',
    stop,
  );
  const cleanup = admin.indexOf("cleanup()");
  const echoRestore = admin.indexOf(
    '/usr/bin/stty echo < "$TTY_PATH"',
    cleanup,
  );
  const invalidate = admin.indexOf("invalidate_sudo_ticket", echoRestore);
  const restore = admin.indexOf("restore_expected_units", invalidate);
  const removeState = admin.indexOf('/usr/bin/rm -- "$STATE_FILE"', restore);
  const complete = admin.indexOf("'ADMIN_INSTALL_COMPLETE'", removeState);
  const stopFunction = admin.indexOf("stop_unit_set()");
  const stopTimer = admin.indexOf("iva.timer|iva-*.timer", stopFunction);
  const stopOther = admin.indexOf("iva-*.service)", stopTimer);
  const stopMain = admin.indexOf("stop iva.service", stopOther);
  const restoreFunction = admin.indexOf("restore_expected_units()");
  const restoreMain = admin.indexOf("start iva.service", restoreFunction);
  const restoreOther = admin.indexOf('start "$unit"', restoreMain);
  const restoreTimer = admin.indexOf("iva.timer|iva-*.timer", restoreOther);

  assert.match(admin, /^#!\/usr\/bin\/bash$/mu);
  assert.match(admin, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu);
  assert.match(
    admin,
    /\[\[ \$# -eq 1 && "\$EXPECTED_COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u,
  );
  assert.match(admin, /\[\[ \$\(\/usr\/bin\/id -u\) -eq 0 \]\]/u);
  assert.match(admin, /A dedicated interactive TTY is required/u);
  assert.match(
    admin,
    /ROOT_COPY=\/usr\/local\/lib\/iva-bitrix-admin\/install/u,
  );
  assert.match(admin, /ROOT_DIR=\/usr\/local\/lib\/iva-bitrix-admin/u);
  assert.match(
    admin,
    /fixed root-owned copy from \/usr\/local\/lib\/iva-bitrix-admin/u,
  );
  assert.match(admin, /root:root 700/u);
  assert.match(
    admin,
    /fixed admin helper directory must be root:root mode 700/u,
  );
  assert.match(admin, /root-only admin staging snapshot/u);
  assert.match(admin, /A non-root SUDO_USER is required/u);
  assert.match(admin, /\/usr\/sbin\/runuser -u "\$IVA_USER"/u);
  assert.match(admin, /run_git_repo_as_iva\(\)/u);
  assert.match(
    admin,
    /GIT_OPTIONAL_LOCKS=0[\s\\]+\/usr\/bin\/git --git-dir="\$REPO_STORE"/u,
  );
  assert.match(admin, /CURRENT_LINK=\/home\/iva\/iva\/current/u);
  assert.match(admin, /VERSIONS_DIR=\/home\/iva\/iva\/versions/u);
  assert.match(admin, /REPO_STORE=\/home\/iva\/iva\/repo/u);
  assert.match(admin, /IVA current must be a symlink/u);
  assert.match(admin, /IVA current target is outside the version store/u);
  assert.match(admin, /reviewed commit is absent from the IVA repository/u);
  assert.match(
    admin,
    /rev-parse --verify --end-of-options[\s\\]+"\$EXPECTED_COMMIT\^\{commit\}"/u,
  );
  assert.match(
    admin,
    /embedded admin manifest does not match the reviewed commit/u,
  );
  assert.match(
    admin,
    /IVA current changed while the root snapshot was being prepared/u,
  );
  assert.doesNotMatch(admin, /git -C "\$LIVE_REPO"/u);
  assert.doesNotMatch(admin, /\/usr\/bin\/git -c safe\.directory/u);
  assert.ok(
    sourceBind >= 0 &&
      dropinPreflight >= 0 &&
      stage >= 0 &&
      sourceBind < dropinPreflight &&
      dropinPreflight < stage &&
      stage < manifestWrite &&
      manifestWrite < commitProof &&
      commitProof < snapshotCopy &&
      manifestWrite < snapshotCopy &&
      snapshotCopy < manifest &&
      manifest < capture &&
      capture < publish &&
      publish < stop &&
      stop < installer,
  );
  assert.ok(cleanup >= 0 && echoRestore > cleanup && echoRestore < invalidate);
  assert.ok(
    invalidate < restore && restore < removeState && removeState < complete,
  );
  assert.ok(stopFunction >= 0 && stopTimer < stopOther && stopOther < stopMain);
  assert.ok(
    restoreFunction >= 0 &&
      restoreMain < restoreOther &&
      restoreOther < restoreTimer,
  );
  assert.match(admin, /run_as_sudo_caller \/usr\/bin\/sudo -k/u);
  assert.match(admin, /run_as_sudo_caller \/usr\/bin\/sudo -K/u);
  assert.match(
    admin,
    /run_as_sudo_caller \/usr\/bin\/sudo -n \/usr\/bin\/true/u,
  );
  assert.match(admin, /\.bitrix\.env\.XXXXXX/u);
  assert.match(admin, /BITRIX_CHAT_READ_VERIFIED=false/u);
  assert.match(admin, /secret input was invalid; no secret was installed/u);
  assert.match(
    admin,
    /\/usr\/bin\/rm -rf --one-file-system -- "\$STAGE_ROOT"/u,
  );
  assert.doesNotMatch(admin, /"\$LIVE_REPO\/\$INSTALLER_REL"/u);
  assert.doesNotMatch(
    admin,
    /\beval\b|sudo\s+(?:bash|sh)\s+-c|https:\/\/b24\./iu,
  );
});

test("root-owned secret audit fails closed without printing the webhook", async () => {
  const installer = await readFile(new URL("install.sh", deployRoot), "utf8");
  const audit = await readFile(new URL("audit-secret.py", deployRoot), "utf8");

  assert.match(
    installer,
    /install -o root -g root -m 0755[\s\S]*audit-secret\.py/u,
  );
  assert.match(audit, /^#!\/usr\/bin\/python3$/mu);
  assert.match(audit, /O_NOFOLLOW/u);
  assert.match(audit, /followlinks=False/u);
  assert.match(audit, /scan-blocker:large-file/u);
  assert.match(audit, /scan-blocker:read-error/u);
  assert.match(audit, /\/usr\/bin\/journalctl/u);
  assert.match(audit, /exact-secret-clear:repo-vault-data/u);
  assert.doesNotMatch(
    audit,
    /print\(\s*(?:secret|secret_text|webhook_lines)\b|shell=True/iu,
  );
});

test("staged shell scripts use fixed interpreters on a noexec runtime mount", async () => {
  const [wrapper, admin] = await Promise.all([
    readFile(new URL("install-and-start.sh", deployRoot), "utf8"),
    readFile(new URL("admin-install.sh", deployRoot), "utf8"),
  ]);

  assert.match(
    admin,
    /^\/bin\/sh "\$STAGE_ROOT\/\$INSTALLER_REL" "\$EXPECTED_COMMIT"$/mu,
  );
  assert.match(
    wrapper,
    /^\/usr\/bin\/env IVA_BITRIX_TRANSACTION=1 \/bin\/sh "\$SCRIPT_DIR\/install\.sh" "\$RELEASE_ID"$/mu,
  );
  assert.doesNotMatch(
    admin,
    /^"\$STAGE_ROOT\/\$INSTALLER_REL" "\$EXPECTED_COMMIT"$/mu,
  );
  assert.doesNotMatch(
    wrapper,
    /^\/usr\/bin\/env IVA_BITRIX_TRANSACTION=1 "\$SCRIPT_DIR\/install\.sh" "\$RELEASE_ID"$/mu,
  );
});

test("admin manifest hashes match canonical LF source bytes", async () => {
  const admin = (
    await readFile(new URL("admin-install.sh", deployRoot), "utf8")
  ).replace(/\r\n/gu, "\n");
  const manifest = admin.match(/<<'MANIFEST'\n(?<body>[\s\S]+?)\nMANIFEST/u);
  assert.ok(manifest?.groups?.body);

  const repoRoot = new URL("../../", import.meta.url);
  for (const line of manifest.groups.body.split("\n")) {
    const match = line.match(/^(?<hash>[0-9a-f]{64}) {2}(?<path>.+)$/u);
    assert.ok(match?.groups);
    const source = await readFile(new URL(match.groups.path, repoRoot), "utf8");
    const canonical = source.replace(/\r\n/gu, "\n");
    const actual = createHash("sha256").update(canonical, "utf8").digest("hex");
    assert.equal(actual, match.groups.hash, match.groups.path);
  }
});
