# Шаг «Card»

Во входе: `date`, `statuses` — допустимые status по типу Card, и `cards`. У каждой Card: `card` (имя), `fields` — её frontmatter (`type`, `description`, `status`, `truth_date` …), `truth` — текущий Compiled Truth текстом, последние строки `log` и новые факты `facts`.

Реши, меняют ли новые факты правду Card. Если `fields.truth_date` новее `date` — правда уже новее этого дня: верни `null` во всех полях. Если `fields.status_date` не раньше `date` — статус поставил владелец днём: `status` верни `null`. Правду меняет только новый факт, противоречащий или уточняющий её; повтор факта правду не меняет. Не переносить Log в правду.

Ответ — один JSON-объект в тексте, без пояснений: `cards` — по одной записи на Card из входа:
- `card` — имя из входа;
- `truth` — весь новый текст правды или `null`, если правда не меняется;
- `description` — новая одна строка или `null`;
- `status` — значение из `statuses` для типа Card или `null`.

Перед ответом проверь, сделано или не сделано:
- по каждой Card из входа есть запись;
- правда изменена только там, где новый факт её меняет, прежние верные строки на месте;
- `status` взят из `statuses` для типа Card или `null`.

Пример:
{"cards":[{"card":"cards/projects/аврора","truth":"Проект запуска.\nДизайн ведёт Анна.","description":null,"status":null},{"card":"cards/contacts/анна","truth":null,"description":null,"status":null}]}
