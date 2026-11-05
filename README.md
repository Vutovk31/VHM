# VI Matcher

Открой проект в Codex и отправь заявку с запросом «Подбери товары ВИ через $vi-matcher». Навык управляет поиском через подключённый MCP ВИ, сайт и внешний веб-поиск. Результаты и состояние лежат в `runs/<id>/`. Для согласования продолжай ту же заявку, указывая её ID.

- [Регламент пилотного навыка](.agents/skills/vi-matcher/references/reglement.md)
- [Контракт данных и экспорт Excel](.agents/skills/vi-matcher/references/contract.md)
- [Пилот и измерение охвата](docs/pilot.md)

Для локальной проверки нужен Node.js 22+ и команда `node --test`. Экспорт использует пакет из Codex Workspace Dependencies. Политика и обработчик доступны из репозитория, а вызовы коннекторов выполняются в сессии Codex.

## VHM Core

- [Канонический регламент](docs/policy/VHM_MATCHING_POLICY.md)
- [Аудит исходного состояния](docs/policy/VHM_FORENSIC_AUDIT.md)
- [Управление черновой политикой](docs/policy/VHM_POLICY_ADMIN_GUIDE.md)
- [Maestro](docs/maestro.md)

Подготовка неизменяемого снимка структурированной заявки:

```sh
node src/intake.mjs request.csv runs/request-intake.json request-001 1.1.0
```

CSV использует заголовки `text,quantity,unit` и допускает явно размеченные `number,location,group,category,brand,model,mpn,viCode,siteProductId,series`. Пятый аргумент задаёт разделитель, если CSV использует точку с запятой. Для структурированного JSON передай массив строк или объект с `rows` и городом `city`. Снимок сохраняет исходные значения и отклоняет перезапись. Это промежуточный контракт перед адаптацией к существующему Matcher. Варианты поиска из `src/search-plan.mjs` используют явные поля и нормализованное имя. Извлечение типизированных полей из свободного текста, прямой вход Excel и автоматическое исполнение маршрутов ещё открыты.
