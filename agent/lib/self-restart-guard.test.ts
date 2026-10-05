/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { selfRestartViolation } from "./self-restart-guard.ts";

const blocked = (cmd: string) =>
  assert.notEqual(
    selfRestartViolation(cmd),
    null,
    `должна блокироваться: ${cmd}`,
  );
const allowed = (cmd: string) =>
  assert.equal(
    selfRestartViolation(cmd),
    null,
    `не должна блокироваться: ${cmd}`,
  );

test("летальные команды iva CLI блокируются во всех формах вызова", () => {
  blocked("iva restart");
  blocked("iva stop");
  blocked("iva reset");
  blocked("iva full-reset");
  blocked("iva update");
  blocked("iva rollback"); // флип current + рестарт убивает ход ровно так же
  blocked("iva doctor"); // ремонтные ветки доктора сами рестартуют iva.service
  blocked("cd /home/shima/iva && iva restart");
  blocked("node bin/iva.mjs restart");
  blocked("./bin/iva.mjs update");
  blocked("npm run iva -- restart");
  blocked("sleep 5; iva restart"); // отложенный — переигрывается точно так же
});

test("systemctl с летальным глаголом по iva.service блокируется", () => {
  blocked("systemctl --user restart iva");
  blocked("systemctl --user restart iva.service");
  blocked("systemctl --user stop iva");
  blocked("systemctl --user kill iva.service");
  blocked("systemctl --user try-restart iva");
  blocked("sudo systemctl restart iva.service");
  blocked("systemctl --user restart iva-telegram-poll iva.service"); // iva.service в списке юнитов
});

test("обход кавычками и обёртками не работает (ревью P1)", () => {
  blocked('systemctl --user restart "iva.service"');
  blocked("iva 'restart'");
  blocked('iva "restart"');
  blocked('bash -c "iva restart"');
  blocked("sh -c 'systemctl --user stop iva'");
  blocked("timeout 30 iva restart");
  blocked("env FOO=bar iva restart");
  blocked("TZ=UTC iva restart"); // голое присваивание — та же обёртка без слова env
  blocked("nohup iva restart");
  blocked("sudo -n systemctl kill iva");
  blocked("while :; do iva restart; done"); // shell-слова цикла — тоже обёртки
});

test("массовое убийство процессов node/eve блокируется", () => {
  blocked("pkill node");
  blocked("pkill -9 -f node");
  blocked('pkill -f "eve start"');
  blocked("killall node");
  blocked("killall -9 eve");
});

test("диагностика и безопасные операции по iva-юнитам проходят", () => {
  allowed("systemctl --user status iva");
  allowed("systemctl --user status iva.service iva-telegram-poll");
  allowed("journalctl --user -u iva.service -n 100");
  allowed("systemctl --user list-units 'iva*'");
  allowed("systemctl --user restart iva-telegram-poll"); // мост — не процесс агента
  allowed("systemctl --user restart iva-memory-daily.timer");
  allowed("systemctl --user daemon-reload");
  allowed("iva usage");
  allowed("iva login");
  allowed("npx eve build");
});

test("упоминания в аргументах — не команды (ревью P3)", () => {
  allowed("rg -n 'iva restart' docs/");
  allowed('grep -rn "systemctl --user restart iva" .');
  allowed("echo 'iva restart'");
  allowed('printf "после правок нужен iva restart\\n" >> notes.md');
  allowed("git log --grep 'iva update'");
});

test("летальный глагол одной команды не дотягивается до iva из следующей", () => {
  allowed(
    "systemctl --user stop some-other.service; systemctl --user status iva",
  );
  allowed("systemctl --user restart caddy && journalctl -u iva -n 5");
});

test('слова с "iva" внутри и невинные kill не матчатся', () => {
  allowed("deriva restart"); // не команда iva
  allowed("pkill -f chromium");
  allowed("kill -0 12345");
});

test("текст отказа объясняет модели, что предложить пользователю", () => {
  const msg = selfRestartViolation("iva restart");
  assert.ok(msg);
  assert.match(msg, /ЗАБЛОКИРОВАНО/);
  assert.match(msg, /\/restart/);
  assert.match(msg, /#68/);
});

test("iva plugin trust|enable|update|sync из bash блокируются: плагин с кодом ставит тап владельца", () => {
  for (const verb of ["trust", "enable", "update", "sync"]) {
    blocked(`iva plugin ${verb} relay`);
    blocked(`iva plugin ${verb}`);
    blocked(`node bin/iva.mjs plugin ${verb} relay`);
    blocked(`cd ~/iva/current && iva "plugin" ${verb} relay`);
    blocked(`npm run iva -- plugin ${verb}`);
    blocked(`bash -c 'iva plugin  ${verb} relay'`);
  }
});

test("iva plugin install-proposal из bash блокируется: установку по предложению запускает только тап в Bridge", () => {
  blocked("iva plugin install-proposal a5bdc6f1401c");
  blocked("node bin/iva.mjs plugin install-proposal a5bdc6f1401c </dev/null");
  blocked("npm run iva -- plugin install-proposal a5bdc6f1401c");
  blocked(`bash -c 'iva plugin install-proposal a5bdc6f1401c'`);
  blocked(
    "mv data/plugin-proposals/relay-a5bdc6f1401c data/plugin-proposals/.taken-a5bdc6f1401c && iva plugin install-proposal a5bdc6f1401c",
  );
  allowed("iva plugin propose drafts/relay");
  allowed("rg -n 'iva plugin install-proposal' docs/");
});

test("остальные подкоманды iva plugin проходят: их гвард не трогает", () => {
  for (const verb of [
    "remove",
    "disable",
    "untrust",
    "list",
    "add",
    "propose",
    "marketplace",
  ])
    allowed(`iva plugin ${verb} relay`);
  allowed("iva plugin trusted");
  allowed("iva plugin updates");
  allowed("rg -n 'iva plugin trust' docs/");
});

test("npm run iva без -- и npx iva блокируются для всего списка глаголов", () => {
  for (const verb of [
    "restart",
    "stop",
    "reset",
    "full-reset",
    "update",
    "rollback",
    "doctor",
    "plugin trust x",
    "plugin enable x",
    "plugin update x",
    "plugin sync",
    "plugin install-proposal abc",
  ]) {
    blocked(`npm run iva ${verb}`);
    blocked(`npm run iva -- ${verb}`);
    blocked(`npx iva ${verb}`);
    blocked(`npx iva -- ${verb}`);
    blocked(`cd ~/iva && npm  run  iva ${verb}`);
  }
  allowed("npm run iva plugin propose x");
  allowed("npx iva plugin propose x");
  allowed("npm run iva-something restart");
  allowed("npx iva-something restart");
  allowed("npm run iva usage");
  allowed("rg -n 'npm run iva restart' docs/");
});
