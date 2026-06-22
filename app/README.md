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

Для ручной отправки email-бекапа базы:

```bash
npm run backup:email
```

Команда требует SMTP-переменные окружения. В production еженедельная отправка включается через `BACKUP_EMAIL_ENABLED=true`.

## Telegram-бот

Бот запускается вместе с сервером, если заданы переменные:

```bash
TELEGRAM_BOT_TOKEN="token-from-botfather" TELEGRAM_ADMIN_IDS="123456789" npm run dev
```

Основные команды и кнопки: `/debts`, `/house 12`, `/link h12-xxxxxxxxxxxx`, `/me`, `/pay 12 1500 комментарий`. Дата платежа ставится автоматически текущим днем. Для платежа обязательно приложить фото-скрин; если дом привязан к Telegram-аккаунту, через кнопку "Отправить платеж" можно вводить только сумму.
