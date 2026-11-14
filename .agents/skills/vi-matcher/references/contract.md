# Контракт запуска

Используй JSON UTF-8. Снимок заявки сохраняй до поиска. Соблюдай явные границы между исходным текстом, свидетельствами и вычисленными статусами.

## intake.json

Объект с `requestId`, `policyVersion`, `city` (пусто, если неизвестен), `remarks[]`, `rows[]`. Для строки:

- `key` — уникальный ключ по документу, листу или странице и исходной строке. `number`, `location`, `text`, `group`, `notes` — исходные реквизиты и товарная группа.
- `quantity` — исходное число или null, `unit` — исходная единица. `category` — нормализованный тип. При наличии заполни `brand`, `model`, `mpn`.
- `kind` — STRICT, OPEN, CLARIFY или REVIEW. Для CLARIFY запиши конкретный вопрос в `clarification`. Для REVIEW сохрани внутреннюю причину в `reviewReason`; этот режим допускает поиск кандидатов, но не точный допуск, аналог или закупку. OPEN используется для общей категории без заданного бренда, модели и артикула.
- `requirements` — список объектов `{key, value, replaceable?}`. Значение содержит обязательное условие и единицу. Для совместимости, безопасности и иных обязательных параметров значение replaceable по умолчанию false. Явно допускаемые отступления требуют подтверждения владельца заявки.

## evidence.json

Совпадающие `requestId`, `policyVersion`, объект `rows` по ключам строк. Запись строки содержит `reason`, `attempts[]` и `cards[]`. В попытке сохраняй `channel` (MCP, VI_SITE, WEB, YANDEX_MANUAL, MCP_VERIFY), `query`, `outcome` (RESULT, MISS, ERROR, UNAVAILABLE), `ids[]`, `reason`. Для аналога добавь `stage: ANALOG`. Причины используй раздельно: NORMALIZATION, CHANNEL_MISS, MISSING_REQUIREMENTS, INCOMPATIBLE, SOURCE_UNAVAILABLE, DELIVERY_UNVERIFIED. При повторах сохраняй все попытки.

Карточка содержит `siteProductId`, `viCode` (если подтверждён), `mpn`, `url`, `title`, `brand`, `model`, `category`, `stage` (EXACT или ANALOG), `verification: {source: "MCP_VERIFY", ref}` только после получения конкретной карточки. `ref` должен указывать на сохранённый ответ MCP или точный фрагмент проверяемого источника. При совпадении нескольких источников сохраняй один объект по ID в пределах стадии и всю историю попыток.

- `checks` — объект по ключам требований со значениями `{status, ref, detail}`. Статус PASS, FAIL, UNKNOWN или DEVIATION. PASS ставь только с подтверждением параметра, DEVIATION только с описанием допустимого отличия. Карточку, найденную только на сайте или вебом, сохраняй без флага подтверждения MCP.
- Для открытого предложения запиши `assumptions`. Для аналога — `differences` и `compatibility`. `vmtRef` заполняй только ссылкой на разрешённый внутренний источник. В клиентский лист внутренний признак не выводится.
- `pack: {size, sourceUnit, orderUnit, ref}` — сколько исходных единиц в одной единице заказа. `price: {amount, currency, at, orderUnit, ref}` — цена именно за единицу заказа. `stock: {status, city, ref}` — наличие (IN_STOCK_MCP, OUT_OF_STOCK, CONFLICT, UNKNOWN). `delivery: {status, city, quantity, ref}` — доставка (CONFIRMED, PICKUP_ONLY, NOT_CONFIRMED) с проверенным количеством в единицах заказа. При отсутствии подтверждения поле опускай.
- `analogPermission: {requestId, decision, keys, by, at}` фиксируется после строгой выдачи. `decision` — STRICT_ONLY или ALLOW_ANALOG_DISCOVERY. При разрешении записывай только согласованные ключи. `approvals[]` содержит отдельные решения `{requestId, key, siteProductId, by, at}` по конкретным предложенным SKU.

## Экспорт

В результате Matcher поле `candidateDiagnostics[]` сохраняет причины по каждому кандидату, ссылку проверки и `selected`. Коды `REQUIREMENT_NOT_VERIFIED` и `REQUIREMENT_MISMATCH` различают недостаток доказательств и проверенное несоответствие. Эти сведения диагностические: пустой массив причин не заменяет итоговый статус, разрешение или согласование. Поле не изменяет правила приёмки и не служит независимым Golden Set.

Используй зависимость `@oai/artifact-tool` из workspace dependency loader. Создай временный рабочий каталог, свяжи его node_modules с каталогом пакетов из loader, скопируй в него `src/export.mjs` и вызови bundled Node с абсолютными путями к `result.json` и `отчёт.xlsx`. В той же папке будут `procurement.txt` и `hunter.txt`. Перед созданием запускай отметку начала операции согласно навыку Spreadsheets.
