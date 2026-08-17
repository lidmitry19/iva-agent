# Trace - журнал хода

Ядро пишет одну строку JSONL на событие: от апдейта, который принял Bridge, до ответа,
который доставил Outbox. Читателей двое - вьюер плагина `trace` и `iva trace`, - поэтому
контракт описан здесь, а не в коде (ADR-0010). Термины - по `CONTEXT.md`.

Файл: `data/trace/YYYY-MM-DD.jsonl` в каталоге данных (`ASSISTANT_DATA_DIR`, по умолчанию
`./data`). Пишут два процесса: агент и мост. Append-only, одна строка на запись.

## Схема события

Полей ровно семь, порядок всегда такой:

| Поле      | Что это                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `ts`      | ISO-8601 **UTC**, момент записи                                                 |
| `turn`    | ключ хода - три случая, см. ниже                                                |
| `session` | сессия eve (пустая, пока ход не начался)                                        |
| `source`  | `telegram`, `bridge`, `web`, `http`, `rollup`, `digest`, `cron`, `unknown`      |
| `kind`    | группа: `bridge`, `inbound`, `gate`, `context`, `turn`, `eve`, `outbox`, `stop` |
| `name`    | конкретное событие внутри группы                                                |
| `data`    | объект: имена, тайминги, размеры, содержимое                                    |

`source` равен `unknown`, когда событие eve пришло без вида канала. `ts` записан в UTC, а
**файл дня** назван по часовому поясу установки (`ASSISTANT_TIMEZONE`): около полуночи
первые строки файла несут метку предыдущих UTC-суток. Так и задумано - журнал режет дни
так же, как их режет vault.

Строка не длиннее 16 КБ **в байтах UTF-8**. Событие, которое не влезло, теряет содержимое
и метится `data.traceTrimmed: true`; имена, тайминги и размеры остаются всегда.

## Три пространства ключа `turn`

1. **До появления хода** - ключ апдейта `tg:<chatId>:<messageId>`. Его умеют посчитать и
   мост, и ядро; `update_id` ядру не виден.
2. **После старта хода** - `turnId` eve (`turn_0`, `turn_1`, ...). Шаги субагента идут с
   суффиксом: `turn_3#planner`, тот же ключ, что в `data/usage.jsonl`.
3. **У ночного хода ключа хода нет вовсе.** Свёртка, дайджест и прочие cron-отправки идут
   через клиент eve, а он отдаёт только id сессии, поэтому их строки `gate.outbound` и
   `outbox.*` несут `turn: ""`, непустую `session` и `source` из {`rollup`, `digest`,
   `cron`}. События eve того же ночного хода при этом несут `turn_N` - их пишет хук
   внутри агента.

**Как читатель собирает один ход**

- _Ход из чата:_ взять `turn.bound`, собрать всё, у чего `turn` равен его
  `data.updateKey` (мост, inbound, гейт входа), плюс всё, у чего `turn` равен его `turn`
  (события eve, Outbox, Стоп), и отсортировать по `ts`.
- _Ночной ход:_ группировать по `session` (и `source`), а не по `turn`.

Колбэки (`⏹ Стоп`, кнопки `/menu`) получают ключ `tg:<chatId>:cb:<callbackId>`, и
**делает его только мост**: до `runTelegramInbound` колбэк не доходит, поэтому такие
строки `bridge.*` остаются сиротами - ни `turn.bound`, ни `inbound.*` у них не будет.

## Каталог событий

| `kind`.`name`                                                     | `data`                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.admitted` / `bridge.dropped`                              | `updateId`, `chatId`, `messageId`, `kind` (`message`/`callback`), `decision` (`owned`/`terminal-drop`/`unownable`/`write-failed`) |
| `bridge.delivered` / `bridge.rejected`                            | те же поля плюс `accepted` (`true`/`false`/`"handled"`), `ms`                                                                     |
| `inbound.received`                                                | `chatId`, `chatType`, `messageId`, `userId`, `allowlisted`; содержимое: `text`                                                    |
| `inbound.accepted` / `inbound.dropped`                            | `chatId`, `chatKey`, `parts`, `partChars[]`; содержимое: `context[]`                                                              |
| `gate.inbound` / `gate.web`                                       | `surface`, `blocked`, `reason`, `flags[]`, `truncatedChars`, `chars`                                                              |
| `turn.bound`                                                      | `chatKey`, `updateKey`                                                                                                            |
| `context.parts`                                                   | `core`, `persona`, `moc`, `daily` - размеры файлов памяти в байтах, `unit`, `approximate`                                         |
| `eve.turn.started` / `turn.completed` / `turn.cancelled`          | `sequence`                                                                                                                        |
| `eve.turn.failed` / `eve.step.failed`                             | `sequence`, `stepIndex`, `code`; содержимое: `message`, `details`                                                                 |
| `eve.step.started`                                                | `sequence`, `stepIndex`                                                                                                           |
| `eve.step.completed`                                              | `sequence`, `stepIndex`, `finishReason`, `usage {in,out,cacheRead,cacheWrite,costUsd?}`                                           |
| `eve.actions.requested`                                           | `sequence`, `stepIndex`, `actions[{kind,callId,toolName\|name}]`; содержимое: `args[]` позиция в позицию с `actions`              |
| `eve.action.result`                                               | `sequence`, `stepIndex`, `status`, `callId`, `toolName`, `isError`, `errorCode?`; содержимое: `result`, `error`                   |
| `eve.message.completed`                                           | `sequence`, `stepIndex`, `finishReason`; содержимое: `message`                                                                    |
| `eve.message.received`                                            | `sequence`, `parts`; содержимое: `message`                                                                                        |
| `eve.reasoning.completed`                                         | `sequence`, `stepIndex`; содержимое: `reasoning`                                                                                  |
| `eve.subagent.started` / `subagent.completed` / `subagent.called` | `callId`, `subagentName`, `name`, `childSessionId`; содержимое: `output`                                                          |
| события eve внутри субагента                                      | те же поля плюс `subagent`, `parentCallId`                                                                                        |
| `gate.outbound`                                                   | `clean`, `findings[]` (`тип:имя`, без превью секрета), `chars`; содержимое: `text` - уже **после** редактуры                      |
| `outbox.delivered` / `outbox.failed`                              | `ok`, `delivered`, `fellBack`, `error`, `chars`, `ms`                                                                             |
| `stop.requested` / `stop.idle` / `stop.failed`                    | `chatKey`, `outcome`                                                                                                              |

У любого события eve в `data` может оказаться `sessionId` (если он есть в payload), а в
содержимом - `input` (и `inputChars`): хук копирует оба по имени.

**`gate.outbound` бывает без парного `outbox.*`.** Служебные реплики канала (статус
«Работаю...», объяснение сбоя, пометка про медиа) проходят тот же outbound-гейт, но мимо
шва Outbox, и дают строку гейта в одиночку. Не жди события доставки после каждого
вердикта.

Пометки писателя в `data`: `traceTrimmed` - событие поехало без содержимого;
`traceUnreadable` - payload не сериализуется. Пометки в значениях: `…[truncated]` - строка
или список обрезаны, `…[deep]` - вложенность глубже четырёх уровней, `…[keys]` - сколько
полей было у обрезанного объекта, `…[unreadable]` - поле не прочиталось.

### Чего в журнале нет

- **Дельта-события** (`message.appended`, `reasoning.appended`, `action.partial`). Они
  повторяют накопленный текст сотни раз за ход; итог приходит в `*.completed`.
- **Состав контекста от самого eve.** CORE, PERSONA и время инжектят динамические
  инструкции eve, а отчитаться изнутри они не могут. `context.parts` даёт **размер тех же
  файлов на диске** в момент старта хода - приближение, о чём говорит само событие
  (`approximate: true`).
- **Вердикты гейта вне хода.** Санитайзер зовут и скрипты, и юнит-тесты: без ключа хода
  вердикт прицепить некуда, поэтому такие вызовы не пишут ничего. Метка хода в процессе
  живёт 60 секунд: если разбор медиа одного входящего занял больше минуты, следующий за
  ним вердикт гейта в журнал не попадёт.

## Содержимое: тумблер и потолки

`data/settings.json`, поле `captureContent` (по умолчанию включено):

```json
{ "captureContent": false }
```

Выключенный тумблер оставляет имена, тайминги и размеры - ход виден целиком, только без
текста. Каждое поле содержимого обрезано 2000 знаками с пометкой `…[truncated]`.

Размеры пишутся только для **строковых** полей содержимого, как `<ключ>Chars` (`text` →
`textChars`). У массивов - `args[]`, `context[]` - размера нет: их количество уже лежит в
`data` как `actions[]` и `parts`.

## Хранение

14 дней: сегодняшний файл и 13 предыдущих. Чистка идёт по **дате в имени файла**, никогда
по mtime (ADR-0002: время файла врёт после копирования и восстановления), и запускается на
первой записи журнала в процессе и потом на каждой смене файла дня. Файлы с именами не по
шаблону `YYYY-MM-DD.jsonl` не трогаются.

## Что гарантировано читателю

- Каждая строка - самостоятельный валидный JSON; битая строка не портит соседние.
- Ошибка записи никогда не ломает и не тормозит ход: она уходит в лог службы (не чаще раза
  в минуту) и на этом всё.
- В один файл пишут два процесса, поэтому порядок строк - порядок записи, а не порядок
  событий хода. Сортируй по `ts`.
