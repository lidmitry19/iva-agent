# Trace — журнал хода

Ядро пишет одну строку JSONL на событие: от приёма апдейта мостом до доставки ответа.
Читают журнал вьюер плагина `trace` и `iva trace` — контракт описан здесь, а не в коде
(ADR-0010). Термины — по `CONTEXT.md`.

Файл: `data/trace/YYYY-MM-DD.jsonl` (каталог данных — `ASSISTANT_DATA_DIR`, по умолчанию
`./data`). Пишут два процесса: агент и Bridge. Append-only, одна строка — один write.

## Схема события

Полей ровно семь, порядок фиксирован:

| Поле      | Что это                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `ts`      | ISO-8601 UTC, момент записи                                                     |
| `turn`    | ключ хода, два пространства — см. ниже                                          |
| `session` | сессия eve (пустая строка, пока ход не начался)                                 |
| `source`  | откуда событие: `telegram`, `bridge`, `web`, `http`, `rollup`, `digest`, `cron` |
| `kind`    | группа: `bridge`, `inbound`, `gate`, `context`, `turn`, `eve`, `outbox`, `stop` |
| `name`    | конкретное событие внутри группы                                                |
| `data`    | объект: имена, тайминги, размеры, содержимое                                    |

Строка не длиннее 16 КБ (считаются БАЙТЫ UTF-8). Событие, которое не влезло, теряет
содержимое и метится `data.traceTrimmed: true` — размеры и имена остаются всегда.

## Два пространства ключа `turn`

1. **До старта хода** — ключ апдейта `tg:<chatId>:<messageId>` (у колбэков
   `tg:<chatId>:cb:<callbackId>`). Его знают и мост, и ядро: `update_id` ядру не виден.
2. **После старта хода** — `turnId` eve (`turn_0`, `turn_1`, …). Шаги субагента идут с
   суффиксом: `turn_3#planner` — тот же ключ, что в `data/usage.jsonl`.

Сшивает пространства событие `turn.bound`: в нём лежат и `turn` (turnId), и
`data.updateKey`. Один ход читается так: взять `turn.bound`, собрать всё с его
`data.updateKey` (мост, inbound, гейт входа) и всё с его `turn` (события eve, Outbox,
Стоп), отсортировать по `ts`.

## Каталог событий

Содержимое (текст, аргументы, результаты) пишется под тумблером `captureContent`;
размеры полей содержимого (`<ключ>Chars`) пишутся ВСЕГДА.

| `kind`.`name`                                                     | `data`                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.admitted` / `bridge.dropped`                              | `updateId`, `chatId`, `messageId`, `kind` (`message`/`callback`), `decision` (`owned`/`terminal-drop`/`unownable`/`write-failed`) |
| `bridge.delivered` / `bridge.rejected`                            | те же поля плюс `accepted` (`true`/`false`/`"handled"`), `ms`                                                                     |
| `inbound.received`                                                | `chatId`, `chatType`, `messageId`, `userId`, `allowlisted`; содержимое: `text`                                                    |
| `inbound.accepted` / `inbound.dropped`                            | `chatId`, `chatKey`, `parts`, `partChars[]`; содержимое: `context[]`                                                              |
| `gate.inbound` / `gate.web`                                       | `surface`, `blocked`, `reason`, `flags[]`, `truncatedChars`, `chars`                                                              |
| `turn.bound`                                                      | `chatKey`, `updateKey`                                                                                                            |
| `context.parts`                                                   | `core`, `persona`, `moc`, `daily` — размеры файлов памяти в байтах, `unit`, `approximate`                                         |
| `eve.turn.started` / `turn.completed` / `turn.cancelled`          | `sequence`                                                                                                                        |
| `eve.turn.failed` / `eve.step.failed`                             | `sequence`, `stepIndex`, `code`; содержимое: `message`, `details`                                                                 |
| `eve.step.started`                                                | `sequence`, `stepIndex`                                                                                                           |
| `eve.step.completed`                                              | `sequence`, `stepIndex`, `finishReason`, `usage {in,out,cacheRead,cacheWrite,costUsd?}`                                           |
| `eve.actions.requested`                                           | `sequence`, `stepIndex`, `actions[{kind,callId,toolName\|name}]`; содержимое: `args[]` (позиция в позицию с `actions`)            |
| `eve.action.result`                                               | `sequence`, `stepIndex`, `status`, `callId`, `toolName`, `isError`, `errorCode?`; содержимое: `result`, `error`                   |
| `eve.message.completed`                                           | `sequence`, `stepIndex`, `finishReason`; содержимое: `message`                                                                    |
| `eve.message.received`                                            | `sequence`, `parts`; содержимое: `message`                                                                                        |
| `eve.reasoning.completed`                                         | `sequence`, `stepIndex`; содержимое: `reasoning`                                                                                  |
| `eve.subagent.started` / `subagent.completed` / `subagent.called` | `callId`, `subagentName`, `name`, `childSessionId`; содержимое: `output`                                                          |
| события eve внутри субагента                                      | те же поля плюс `subagent`, `parentCallId`                                                                                        |
| `gate.outbound`                                                   | `clean`, `findings[]` (`тип:имя`, без превью секрета), `chars`; содержимое: `text` — уже ПОСЛЕ редактуры                          |
| `outbox.delivered` / `outbox.failed`                              | `ok`, `delivered`, `fellBack`, `error`, `chars`, `ms`                                                                             |
| `stop.requested` / `stop.idle` / `stop.failed`                    | `chatKey`, `outcome`                                                                                                              |

Служебные пометки в `data`: `traceTrimmed` — событие поехало без содержимого;
`traceUnreadable` — payload не сериализуется. В значениях: `…[truncated]` — строка или
список обрезаны, `…[deep]` — вложенность глубже четырёх уровней, `…[keys]` — сколько
полей было у обрезанного объекта, `…[unreadable]` — поле не прочиталось.

### Чего в журнале нет

- **Дельта-события** (`message.appended`, `reasoning.appended`, `action.partial`). Они
  несут накопительный текст сотни раз за ход; итог приходит в `*.completed`.
- **Состав контекста от eve.** CORE, PERSONA и время инжектят динамические инструкции
  eve, и отчитаться изнутри они не могут. `context.parts` даёт РАЗМЕР ТЕХ ЖЕ ФАЙЛОВ на
  диске в момент старта хода — приближение, о чём говорит `approximate: true`.
- **События гейтов вне хода.** Санитайзер зовут и скрипты, и тесты: без ключа хода
  вердикт писать некуда, поэтому такие вызовы не пишут ничего.

## Содержимое: тумблер и потолки

`data/settings.json`, поле `captureContent` (по умолчанию включено):

```json
{ "captureContent": false }
```

Выключенный тумблер оставляет имена, тайминги и размеры — ход по-прежнему виден целиком,
но без текста. Каждое поле содержимого обрезано 2000 знаками с пометкой `…[truncated]`.

## Хранение

14 дней: сегодняшний файл и 13 предыдущих. Чистка идёт по ДАТЕ В ИМЕНИ файла, никогда по
mtime (ADR-0002: время файла врёт после копирования и восстановления), и запускается при
первой записи нового дня. Файлы с именами не по шаблону `YYYY-MM-DD.jsonl` не трогаются.

## Гарантии для читателя

- Каждая строка — самостоятельный валидный JSON; битая строка не портит соседние.
- Ошибка записи никогда не ломает и не тормозит ход: она уходит в лог службы (не чаще
  раза в минуту) и на этом всё.
- Журнал пишут два процесса в один файл; порядок строк — порядок записи, а не порядок
  событий хода. Сортируй по `ts`.
