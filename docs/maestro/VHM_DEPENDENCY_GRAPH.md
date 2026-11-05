# VHM · зависимости

Стрелка означает, что этап справа требует результата этапа слева для приёмки. Локальные фикстуры, независимая разметка и аудит источников могут начаться раньше. [Реестр задач](VHM_WORKSTREAM_REGISTRY.md)

```mermaid
flowchart LR
  Audit["Аудит базы"] --> Rules["VHM-101 Политика"]
  Audit --> Source["VHM-301 Источники"]
  Audit --> Truth["VHM-501 Независимая разметка"]
  Rules --> Intake["VHM-201/202 Intake"]
  Rules --> Approval["VHM-102 Согласование"]
  Rules --> Policy["VHM-502 Конфигурация"]
  Intake --> Recovery["VHM-302 Поиск"]
  Source --> Recovery
  Recovery --> Accept["VHM-401 Matcher"]
  Approval --> Accept
  Accept --> Supply["VHM-402 Поставка"]
  Accept --> Export["VHM-601 Экспорт"]
  Supply --> Gate["E03.6 Evidence gate"]
  Truth --> Gate
  Intake --> Gate
  Export --> App["VHM-602 Приложение"]
  Source --> App
  Policy --> App
  Gate --> App
  App --> Review["Owner review и отдельное разрешение rollout"]
```

Исключительное владение файлом действует до integration gate. Maestro распределяет изменения общей спецификации и entrypoint. Изменение интерфейса сначала проходит Contract Review со всеми потребителями.
