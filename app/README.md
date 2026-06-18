# Water Payments MVP

Локальное MVP приложения учета платежей и расходов.

## Стек

- Node.js HTTP-сервер без внешних npm-зависимостей.
- SQLite-база в `db/water.sqlite`.
- Python-импорт Excel через `openpyxl` и стандартный `sqlite3`.
- Vanilla HTML/CSS/JS.

## Быстрый старт

```bash
npm run init-db
npm run import:excel
npm test
npm run dev
```

После запуска:

- публичный дашборд: `http://localhost:4173/`;
- админка: `http://localhost:4173/admin`;
- пароль администратора по умолчанию: `admin`.

Пароль можно заменить переменной окружения:

```bash
ADMIN_PASSWORD="new-password" npm run dev
```

Для фиксации расчетного месяца:

```bash
AS_OF_MONTH=2026-06 npm run dev
```
