/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Таблицы гварда T2: что блокируется до exec и что обязано проходить. Стиль — как у
// self-restart-guard.test.ts: хелперы печатают саму команду, по одному test() на правило.
import { strict as assert } from "node:assert";
import test from "node:test";
import { schedulerBypassViolation } from "./scheduler-bypass-guard.ts";

const blocked = (cmd: string) =>
  assert.notEqual(
    schedulerBypassViolation(cmd),
    null,
    `должна блокироваться: ${cmd}`,
  );
const allowed = (cmd: string) =>
  assert.equal(
    schedulerBypassViolation(cmd),
    null,
    `не должна блокироваться: ${cmd}`,
  );

test("R1: systemd-run в командной позиции блокируется в любой форме", () => {
  for (const cmd of [
    'systemd-run --user --on-calendar="10:00" iva remind "позвонить"',
    "systemd-run --user --on-calendar=10:00 /home/shima/.local/bin/iva remind x",
    "sudo systemd-run --user date",
    "bash -c 'systemd-run --user --on-calendar=10:00 iva notify x'",
    "nohup systemd-run --user true",
    "/usr/bin/systemd-run --user true",
  ]) {
    blocked(cmd);
  }
});

test("R2: crontab блокируется везде, кроме чтения через -l", () => {
  for (const cmd of [
    "crontab -",
    "crontab -e",
    "crontab -r",
    "crontab /tmp/cron.txt",
    "crontab",
    "crontab -u shima -",
    "sudo crontab -",
  ]) {
    blocked(cmd);
  }
});

test("R3: at и batch (отложенный запуск) блокируются", () => {
  for (const cmd of [
    "at now + 1 hour",
    "echo 'iva notify x' | at 09:00",
    "batch",
    "sudo at 09:00 -f ~/job.sh",
  ]) {
    blocked(cmd);
  }
});

test("R4: systemctl start/enable/--now чужого юнита блокируется", () => {
  for (const cmd of [
    "systemctl --user start remind.timer",
    "systemctl --user enable --now x.timer",
    "systemctl --user link ~/x.service",
    "systemctl --user restart remind.timer",
    "systemctl --user reenable remind.timer",
    "systemctl --user edit remind.timer",
    "systemctl --user restart iva-telegram-poll caddy.service",
  ]) {
    blocked(cmd);
  }
});

test("R5: запись в ~/.config/systemd/user блокируется", () => {
  for (const cmd of [
    "cat > ~/.config/systemd/user/x.timer <<EOF",
    "tee ~/.config/systemd/user/x.timer",
    "cp x.timer ~/.config/systemd/user/",
    "ln -s ~/x.timer ~/.config/systemd/user/x.timer",
    "install -m 0644 x.service ~/.config/systemd/user/x.service",
    "mkdir -p ~/.config/systemd/user",
    "rm ~/.config/systemd/user/x.timer",
    "printf '[Unit]\\n' > $HOME/.config/systemd/user/x.timer",
    "sed -i s/OnCalendar=x/OnCalendar=y/ ~/.config/systemd/user/x.timer",
    "bash -c 'echo x > ~/.config/systemd/user/x.timer'",
  ]) {
    blocked(cmd);
  }
});

test("R6: свой скрипт в ~/.iva-scripts блокируется", () => {
  for (const cmd of [
    "mkdir -p ~/.iva-scripts",
    "cat > ~/.iva-scripts/remind.sh <<EOF",
    "chmod +x ~/.iva-scripts/remind.sh",
    "bash ~/.iva-scripts/remind.sh",
    "~/.iva-scripts/remind.sh",
    "cp x.sh /home/shima/.iva-scripts/",
    "sudo bash -c 'chmod +x ~/.iva-scripts/remind.sh'",
  ]) {
    blocked(cmd);
  }
});

test("R7: прямой вызов api.telegram.org блокируется", () => {
  for (const cmd of [
    "curl -s https://api.telegram.org/bot$T/sendMessage -d text=hi",
    "wget -qO- https://api.telegram.org/bot$T/getMe",
    "http POST https://api.telegram.org/bot$T/sendMessage",
    "python3 -c \"urllib.request.urlopen('https://api.telegram.org/bot1/sendMessage')\"",
    "node -e \"fetch('https://api.telegram.org/bot1/sendMessage')\"",
    "TG=https://api.telegram.org; curl $TG/bot1/sendMessage",
    'echo "curl https://api.telegram.org/bot1/sendMessage" > send.sh',
    "curl https://api.telegram.org/bot$T/sendMessage && rm -f /tmp/x",
  ]) {
    blocked(cmd);
  }
});

test("R8: sleep как таймер перед следующей командой блокируется", () => {
  for (const cmd of [
    "sleep 3600 && iva notify x",
    "sleep 3600; iva notify x",
    "sleep 1h && iva remind x",
    "sleep 90 && curl https://example.com",
    "(sleep 3600; iva notify x) &",
    "while true; do sleep 3600; iva notify x; done",
    "sleep $DELAY && iva notify x",
    "sleep 30m 30s && iva notify x",
    // Форма, которой учит промпт: абсолютный путь через $HOME и присваивания впереди.
    "sleep 3600 && $HOME/.local/bin/iva notify x",
    "sleep 3600; $HOME/.local/bin/iva remind x",
    "sleep 1h && $HOME/.local/bin/iva remind x",
    "sleep 3600 && TZ=UTC iva notify x",
    "sleep 3600 && /usr/bin/env iva notify x",
    "while true; do sleep 3600; $HOME/.local/bin/iva notify x; done",
  ]) {
    blocked(cmd);
  }
});

test("обёртки, кавычки, подстановки и переносы строк не спасают", () => {
  for (const cmd of [
    '"systemd-run" --user true',
    "systemd-run --user --on-calendar='10:00' true",
    "sudo -n systemd-run --user true",
    "env FOO=1 systemd-run --user true",
    "timeout 5 systemd-run --user true",
    "nohup systemd-run --user true",
    "command systemd-run --user true",
    "exec systemd-run --user true",
    "nice systemd-run --user true",
    'bash -c "systemd-run --user true"',
    "sh -c 'crontab -'",
    "echo hi\nsystemd-run --user true",
    "$(systemd-run --user true)",
    "`crontab -`",
    "while :; do crontab -; done",
    "if true; then systemd-run --user true; fi",
  ]) {
    blocked(cmd);
  }
});

test("разрешённые: чтение, статус, упоминания в аргументах, короткий sleep", () => {
  for (const cmd of [
    "systemctl --user status iva",
    "systemctl --user status iva.service iva-telegram-poll",
    "journalctl --user -u iva.service -n 100",
    "systemctl --user list-timers",
    "systemctl --user daemon-reload",
    "systemctl --user restart iva-telegram-poll",
    "systemctl --user restart iva-memory-daily.timer",
    "systemctl --user cat iva",
    "crontab -l",
    "crontab -l | grep iva",
    "crontab -u shima -l",
    "crontab -l > ~/cron.bak",
    "rg 'systemd-run' docs/",
    "grep -rn crontab agent/",
    "which systemd-run",
    "man crontab",
    'echo "crontab"',
    "echo 'systemd-run --user' >> notes.md",
    "sleep 2",
    "sleep 2 && ls",
    "sleep 3600",
    "sleep 30; iva notify x",
    'grep -rn "curl https://api.telegram.org" .',
    "rg api.telegram.org scripts/",
    "git log --grep api.telegram.org",
    "curl https://example.com/health",
    "wget -qO- https://example.com",
    "cat ~/.config/systemd/user/iva.service",
    "ls ~/.config/systemd/user",
    "sed -n 1,5p ~/.config/systemd/user/iva.service",
    "ls ~/.iva-scripts",
    "cat ~/.iva-scripts/remind.sh",
    "grep -r curl ~/.iva-scripts",
    "atq",
    "date",
    "cat file",
    'iva notify "hi"',
    'iva remind "hi"',
    "sudo systemctl --user status iva",
    'bash -c "crontab -l"',
    "timeout 5 journalctl -u iva -n 5",
    "env FOO=1 rg systemd-run docs/",
  ]) {
    allowed(cmd);
  }
});

test("летальное правило одной позиции не дотягивается до соседней", () => {
  allowed("crontab -l; echo ok");
  allowed("systemctl --user status iva; systemctl --user list-timers");
  allowed("sleep 3600");
  blocked("(crontab -l; echo x) | crontab -");
});

test("текст отказа называет правило и замену", () => {
  const msg = schedulerBypassViolation("systemd-run --user true");
  assert.ok(msg);
  assert.match(msg, /^ЗАБЛОКИРОВАНО:/);
  // Тул есть в списке с T5: отказ обязан послать модель в remind, а не учить отказывать
  // пользователю и не обещать, что инструмент когда-нибудь появится.
  assert.match(msg, /remind: он посчитает/u);
  assert.doesNotMatch(msg, /появится|пока его нет/iu);
  for (const [cmd, what] of [
    ["systemd-run --user true", "systemd-run: свой таймер"],
    ["crontab -e", "crontab: запись расписания"],
    ["at now + 1 hour", "at/batch: отложенный запуск"],
    [
      "systemctl --user start remind.timer",
      "systemctl: запуск или включение своего юнита",
    ],
    ["tee ~/.config/systemd/user/x.timer", "запись в ~/.config/systemd/user"],
    ["bash ~/.iva-scripts/remind.sh", "~/.iva-scripts: свой скрипт"],
    [
      "curl https://api.telegram.org/bot1/getMe",
      "прямой вызов api.telegram.org",
    ],
    ["sleep 3600 && iva notify x", "sleep как таймер перед следующей командой"],
  ] as const) {
    const text = schedulerBypassViolation(cmd);
    assert.ok(text, `должна блокироваться: ${cmd}`);
    assert.ok(
      text.includes(what),
      `в тексте отказа для "${cmd}" нет правила "${what}": ${text}`,
    );
  }
});

test("якоря QA: ослабление против main — приклеенный редирект и ранний выход", () => {
  for (const cmd of [
    // Приклеенный редирект/stdin к имени команды (X1-X7, X10).
    "crontab>/dev/null /tmp/j",
    "systemd-run>/dev/null --user --on-active=1h /bin/true",
    "at>/dev/null now + 1 hour",
    "systemctl>/dev/null --user start my.timer",
    "crontab</tmp/j",
    "at</tmp/job",
    "batch</tmp/job",
    "sleep>/dev/null 3600; curl -s https://example.com/ping",
    // Ранний выход съедал проверку путей той же позиции (Y1-Y6).
    "crontab -l > ~/.iva-scripts/remind.sh",
    "crontab -l > ~/.config/systemd/user/my.timer",
    "crontab -l -u api.telegram.org",
    "systemctl --user cat iva > ~/.config/systemd/user/copy.service",
    "systemctl --user show iva > ~/.iva-scripts/state.sh",
    "systemctl --user status api.telegram.org > /tmp/x",
  ]) {
    blocked(cmd);
  }
});

test("якоря QA: штатные команды — /dev/null, обвязка сна, Environment=", () => {
  for (const cmd of [
    // Читатель с подавлением шума (R7-R9, R17, R18, R22).
    "grep -rn api.telegram.org agent/ 2>/dev/null",
    "ls ~/.iva-scripts 2>/dev/null",
    "cat ~/.config/systemd/user/iva.service 2>/dev/null",
    "head -20 ~/.config/systemd/user/iva.service > /dev/null",
    "wc -l ~/.iva-scripts/*.sh 2>/dev/null",
    "grep -c api.telegram.org agent/lib/telegram.ts 2>/dev/null | cat",
    // Обвязка сна и обрывки редиректов — не нагрузка (L8, L10-L14).
    "exec sleep 3600 & wait",
    "while true; do sleep 120; done",
    "sleep 120 > /dev/null 2>&1",
    "sleep 120 2>&1",
    "sleep 120; :",
    "sleep 120; true",
    // Присваивание — не юнит (C8).
    "systemctl --user restart Environment=FOO",
  ]) {
    allowed(cmd);
  }
});

// T32, дефект 1: `env A=1 cmd` нормализация снимала, а голое `A=1 cmd` — нет, хотя shell
// видит обе формы одинаково. Команда оставалась не в командной позиции, и гвард её не
// находил.
test("T32: ведущее присваивание не прячет команду — как и обёртка env", () => {
  for (const cmd of [
    "TZ=UTC crontab /tmp/j",
    "TZ=UTC systemd-run --user --on-active=1h /bin/true",
    "FOO=1 BAR=2 at now + 1 hour",
    "sleep 3600 && TZ=UTC iva notify x",
  ]) {
    blocked(cmd);
  }
  // Паритет с обёрткой: один и тот же вызов через env судится так же.
  for (const cmd of ["TZ=UTC crontab /tmp/j", "env TZ=UTC crontab /tmp/j"]) {
    blocked(cmd);
  }
  // Слово с равенством, но не в начале позиции, командой не становится.
  allowed("systemctl --user restart Environment=FOO");
});

// T32, дефект 2: разрез по `&` рвал `2>&1` надвое, хвост `2>` делал читателя писателем —
// и совершенно штатный `grep … >/dev/null 2>&1` по каталогу юнитов блокировался.
test("T32: дуп дескриптора не разделитель команд", () => {
  for (const cmd of [
    "grep -rn iva ~/.config/systemd/user >/dev/null 2>&1",
    "cat ~/.iva-scripts/x.sh >/dev/null 2>&1",
    "ls ~/.config/systemd/user >&2",
  ]) {
    allowed(cmd);
  }
  // Настоящая запись в те же каталоги по-прежнему блокируется: правило не ослабло.
  for (const cmd of [
    "grep -rn iva ~/.config/systemd/user > ~/.iva-scripts/out.txt 2>&1",
    "echo x &> ~/.config/systemd/user/my.timer",
    "crontab /tmp/j 2>&1",
  ]) {
    blocked(cmd);
  }
  // Фон и `&&` остаются разделителями — иначе вторая команда ушла бы из-под суда.
  blocked("echo hi & crontab /tmp/j");
  blocked("echo hi && crontab /tmp/j");
  // `>&слово` в bash — перенаправление обоих потоков в ФАЙЛ `crontab`, команда не
  // запускается (проверено живым bash). Отсюда отсутствие отказа, и это не ослабление.
  allowed("echo hi>&crontab /tmp/j");
});

// T32 v2: правила путей и хоста судят весь сегмент, а не имя команды, поэтому снятие
// префикса уносило из-под суда саму улику — запретный путь лежал в ЗНАЧЕНИИ присваивания
// или обёртки. Форма исполнима: значение раскрывает внутренний shell (`bash -c`).
test("T32: путь и хост в значении присваивания или обёртки судятся, а не теряются", () => {
  for (const cmd of [
    "URL=https://api.telegram.org/bot1:2/sendMessage bash -c 'curl -s $URL -d chat_id=1 -d text=hi'",
    "S=~/.iva-scripts/remind.sh bash -c 'echo curl > $S'",
    "U=~/.config/systemd/user/my.timer sh -c 'cp /tmp/u $U'",
    "H=api.telegram.org curl -s https://$H/bot1:2/sendMessage",
    "D=~/.iva-scripts tee $D/x.sh",
    // Та же дыра через `env` была и до ветки — закрывается тем же судом по сегменту.
    "env URL=https://api.telegram.org/bot1:2/sendMessage bash -c 'curl -s $URL'",
  ]) {
    blocked(cmd);
  }
  // Имя команды по-прежнему судится по снятому сегменту: обёртка не делает читателя
  // писателем, иначе `sudo grep …` стало бы ложным срабатыванием.
  for (const cmd of [
    "sudo grep -rn iva ~/.config/systemd/user",
    "timeout 30 cat ~/.config/systemd/user/iva.service",
    "bash -c 'cat ~/.iva-scripts/remind.sh'",
  ]) {
    allowed(cmd);
  }
});

// T75: отправка файла через curl в api.telegram.org режется, и отказ обязан назвать штатный
// путь — иначе модель отвечает «отправить вложение не могу».
test("T75: отказ по api.telegram.org называет инструмент send_file", () => {
  const text = schedulerBypassViolation(
    "curl -F document=@vault/attachments/x.pdf https://api.telegram.org/bot1:2/sendDocument",
  );
  assert.ok(text);
  assert.match(text, /send_file/);
});
