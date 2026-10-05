# Personal release 0.4.12

Base: official `v0.4.12` (5cf8f1963c8297e244655fa4f3dc6f1764030283).
Update channel stays `origin/release/personal-production` in the personal fork.

## Retained differences

- The explicitly configured `release/personal-production` channel follows its
  reviewed branch tip, retaining owner patches after official tags; normal upstream
  release/beta behavior is unchanged and backward updates are still refused.
- Bitrix read-only gateway and its deployment/tests remain unchanged.
- Exact-name retirement of obsolete Bitrix sync and night watchdog units is
  adapted to the upstream systemd lifecycle class; owner units stay intact.
- `tasks` list accepts `verifyBitrix: true`. Brief requests it to refresh linked
  task titles, statuses and deadlines through the local gateway. Completed and
  declined tasks are excluded; deleted, unavailable, denied and invalid responses
  are excluded with a warning. Unlinked local tasks still work. Verification is
  read-only and never reconstructs omitted tasks from memory.
- Legacy digest tool, skill, schedule, script and tests are removed as upstream
  replaced them with Brief. All calendar/mail/Telegram/plugin/goal/weather sources
  and proactive behavior from upstream remain present.

## Installation settings

This owner's previous enabled digest ran at 08:00 Asia/Yekaterinburg. Migrate
settings atomically to `proactive.briefTimes: ["08:00"]`; do not add a second slot.
Keep the old digest setting inert for rollback compatibility. Preserve the current
ChatGPT subscription provider and all credentials/custom data on the server.

## Verification and recovery

Typecheck, lint, build, updater/Brief/Bitrix tests use mocks, never live model or
Telegram API calls. Post-deploy verify the active commit, both services, local
health, custom capabilities and settings. Actual Telegram delivery is left to
the owner. Restore the saved runtime and settings if activation fails; stop services
and restore backed-up data as well if a migration prevents backward compatibility.
Future upstream synchronization is a separate task.

## Validation evidence

- Node 24.17.0: typecheck passed; lint findings in the new helper were fixed and
  all changed TypeScript files passed lint.
- Targeted Brief/update/channel/systemd tests: 55 passed. Additional update UI,
  rebuild, reporting and freshness tests: 70 passed. Bitrix gateway tests: 85 passed.
- Full upstream suite: 3913 tests, 3903 passed, 9 failed, 1 skipped. With an explicit
  test-only Git identity and uv in PATH, the relevant environment failures pass;
  six failures reproduce identically in the clean official v0.4.12 archive
  (lock inode replacement, flaky mock Claude pipe, installer host reboot guard,
  outdated flock expectation and repair directory ordering). The same-length card
  test passes in isolation. These are not introduced by the personal diff.
- Immutable-layout build with copied custom files passed; health probe on an
  isolated port passed without invoking a model or Telegram delivery. Both custom
  Bitrix tools are present in the generated runtime.
