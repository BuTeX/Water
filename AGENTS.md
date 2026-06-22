# Контекст проекта для Codex

Этот файл - быстрый вход в проект для будущих сессий Codex. Перед изменениями сначала прочитай его, затем `README.md`, `app/README.md` и при необходимости локальную базу знаний в `docs/knowledge-base/`.

## Что это за проект

`Water Payments` - учет взносов, расходов и публичной отчетности по общей скважине и насосной станции на улице Уютная.

Главная идея: единая база платежей и расходов, поверх которой работают веб-страницы, админка и боты. Долг не хранится как ручное число, а считается из месяца старта дома, ставок, месячных начислений, платежей и распределений платежей.

Production на момент последнего описания:

- Railway: `https://yutnaya.up.railway.app`
- публичный дашборд: `/`
- админка: `/admin`
- GitHub: `https://github.com/BuTeX/Water.git`
- основная ветка: `main`

## Текущее состояние

Фактический стек сейчас - no-deps MVP из ADR-0002:

- Node.js HTTP-сервер на стандартных модулях.
- SQLite через CLI `sqlite3`, путь по умолчанию `app/db/water.sqlite`, в production `DB_PATH=/data/water.sqlite`.
- Python-скрипты для инициализации, импорта Excel, smoke-check и рендера карточки дашборда для ботов.
- Vanilla HTML/CSS/JS, mobile-first.
- Dockerfile для Railway/Render.
- Ручной бекап production SQLite: в админке есть "Скачать базу SQLite"; `app/src/backup.mjs` делает безопасный SQLite `.backup`.

Важно: часть ранней базы знаний говорит, что Telegram/MAX отложены, но текущий код уже содержит Telegram- и MAX-ботов, админские API, заявки платежей со скриншотами и модерацию. При расхождении верь коду, корневому `README.md`, `docs/deployment.md` и `docs/max-bot.md`; старые документы в `docs/knowledge-base/` использовать как историю решений и продуктовый контекст.

## Команды

Запуск из папки `app`:

```bash
npm run init-db
npm run import:excel
npm test
npm run dev
```

Полезные варианты:

```bash
AS_OF_MONTH=2026-06 npm run dev
STRICT_IMPORT_CHECK=1 npm test
DB_PATH=/data/water.sqlite npm start
```

`npm test` запускает `scripts/smoke_check.py`, а не JS test runner. Smoke-check проверяет наличие домов, платежей, расходов, неотрицательные итоги и уникальность access codes; при `STRICT_IMPORT_CHECK=1` сверяет эталонные суммы импорта.

## Структура

- `README.md` - паспорт проекта, Railway, локальный запуск, Telegram-команды.
- `app/README.md` - краткий локальный quickstart.
- `docs/deployment.md` - Railway/Render/VPS, env vars, production SQLite volume.
- `docs/max-bot.md` - настройка MAX-бота, webhook/polling, команды.
- `docs/knowledge-base/` - локальная база знаний, продуктовый контекст, ADR, импорт Excel, эталонные суммы. Папка игнорируется git, но важна локально.
- `data/raw/` - исходный Excel. Игнорируется git.
- `scripts/` - разовые скрипты анализа Excel до появления приложения.
- `app/src/server.mjs` - HTTP-сервер, маршруты, сессии админки, загрузка/скачивание SQLite, запуск ботов.
- `app/src/repository.mjs` - бизнес-операции и агрегаты: дашборд, дом по коду, админские данные, платежи, расходы, начисления, дома, CSV.
- `app/src/calculations.mjs` - расчет месяцев, ставок, начислений, долга, переплаты и статусов месяцев.
- `app/src/sql.mjs` - подготовка SQLite, применение `schema.sql`, простые миграции и SQL-helpers.
- `app/src/backup.mjs` - безопасный SQLite `.backup` для ручного скачивания базы из админки.
- `app/src/telegram_bot.mjs` - Telegram long polling, команды, кнопки, привязка дома, заявки платежей со скриншотом, подтверждение/отклонение.
- `app/src/max_bot.mjs` - MAX API, webhook/long polling, команды, карта улицы, заявки платежей со скриншотом.
- `app/db/schema.sql` - схема SQLite и seed ставок/категорий.
- `app/scripts/init_db.py` - применяет схему к SQLite.
- `app/scripts/import_excel.py` - импортирует Excel из `data/raw`, создает дома, платежи, расходы и allocation-строки.
- `app/scripts/smoke_check.py` - основной тестовый контур.
- `app/scripts/render_dashboard_card.py` - PNG-карточка дашборда для Telegram/MAX.
- `app/public/index.html`, `admin.html`, `house.html` - текущий публичный UI, админка и страница дома.
- `app/public/next.html`, `next-admin.html`, `next-house.html`, `next.css` - альтернативный новый дизайн на тех же API.
- `app/public/client.js` - общий frontend controller для старого и нового дизайна.

## Данные и расчет

Источник исторических данных: `data/raw/Таблица оплат электроэнергии насосной станции.xlsx`.

Активные дома из текущего импорта: `18, 19, 20, 21, 23, 24, 26, 28, 30, 31, 32, 34, 36, 37, 38, 40, 41, 42, 43`.

Базовые ставки:

- май 2025 - июнь 2026: `500 RUB/мес.`
- с июля 2026: `1000 RUB/мес.`

Дополнительные начисления:

- `2025-05`: +2300, итого 2800
- `2025-07`: +3000, итого 3500
- `2025-12`: +2000, итого 2500

Эталон полной оплаты с мая 2025 по июнь 2026 включительно: `14300 RUB`.

Контрольные суммы текущего Excel на `2026-06-13`:

- активных домов: 19
- платежей: 222
- сумма платежей: 233150 RUB
- расходов: 15
- сумма расходов: 169874 RUB
- остаток кассы: 63276 RUB
- общий долг: 17650 RUB
- авансы: 4800 RUB

Поздние старты:

- дом 23: `2025-06`
- дом 30: `2025-09`
- дом 34: `2026-03`
- дом 37: `2025-07`

Важные правила:

- дом активен, если по нему есть хотя бы одна оплата в Excel;
- месяц старта активного дома при импорте = месяц первой оплаты, но не раньше `2025-05`;
- платежи 29-30 апреля 2025 считаются платежами за май 2025;
- расходы уменьшают общий баланс кассы, но не долг конкретного дома;
- платежи распределяются от старых незакрытых месяцев к будущим как аванс;
- дом `36` не закрыт: текущий долг 500 RUB;
- не использовать старый ориентир 14000 RUB.

## API и страницы

Публичное:

- `GET /healthz`
- `GET /`
- `GET /h/:accessCode`
- `GET /next`
- `GET /next/h/:accessCode`
- `GET /api/dashboard`
- `GET /api/house/:accessCode`

Админка:

- `GET /admin`
- `GET /next/admin`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/admin/summary`
- `POST /api/admin/payments`
- `DELETE /api/admin/payments/:id`
- `POST /api/admin/expenses`
- `POST /api/admin/monthly-charge`
- `POST /api/admin/houses`
- `GET /api/export/{houses|payments|expenses}.csv`
- `GET /api/admin/database`
- `POST /api/admin/database`

Telegram/MAX:

- `GET /api/admin/telegram`
- `GET /api/admin/telegram/data`
- `GET /api/admin/telegram/file?fileId=...`
- `POST /api/admin/telegram/users`
- `POST /api/admin/telegram/users/link`
- `POST /api/admin/telegram/claims/review`
- `GET /api/admin/max`
- `GET /api/admin/max/data`
- `GET /api/admin/max/claim-screenshot?claimId=...`
- `POST /api/admin/max/users`
- `POST /api/admin/max/users/link`
- `POST /api/admin/max/claims/review`
- `POST /api/max/webhook`

## Окружение

Обязательное для production:

- `NODE_ENV=production`
- `DB_PATH=/data/water.sqlite`
- `ADMIN_PASSWORD=<secret>`

Опционально:

- `PORT`
- `BIND_HOST`
- `COOKIE_SECURE`
- `AS_OF_MONTH`
- `STRICT_IMPORT_CHECK`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_IDS`
- `MAX_BOT_TOKEN`
- `MAX_ADMIN_IDS`
- `MAX_BOT_WEBHOOK_URL`
- `MAX_BOT_WEBHOOK_SECRET`
- `MAX_BOT_POLLING_ENABLED=true` для локального MAX polling без публичного HTTPS
- `TZ=Europe/Moscow`

В production без `ADMIN_PASSWORD` публичная часть работает, но вход в админку отключен.

## Бекап production

Автоматическую отправку на почту свернули: Railway таймаутит исходящий SMTP к Yandex, а отдельный email-провайдер для такого маленького проекта не нужен.

Рабочая схема:

- В `/admin` в блоке "Экспорт" нажать "Скачать базу SQLite".
- Endpoint: `GET /api/admin/database`, доступен только после админского логина.
- `app/src/backup.mjs` делает безопасный SQLite `.backup`, поэтому скачивается консистентная копия живой базы.
- Скачанный файл хранить вручную в локальном/Yandex Disk-хранилище с датой в имени.
- В текущей архитектуре весь важный persistent state находится в SQLite; скриншоты платежей хранятся у Telegram/MAX, а в базе лежат их идентификаторы.

## Git и приватность

Git отслеживает код, деплойные файлы и публичные документы. Игнорируются:

- `data/raw/`
- `docs/knowledge-base/`
- `app/db/*.sqlite`
- `app/db/backups/`
- `app/db/last-import-report.json`
- временные Python/cache/OS файлы

Не коммитить рабочую SQLite-базу, Excel, приватные ссылки домов, пароли, токены ботов и реальные секреты. Для production база должна жить на Railway volume `/data/water.sqlite`; переносить ее через админский блок "База SQLite" или безопасный backup/restore.

## Как работать дальше

- Перед изменениями сверяйся с `AGENTS.md`, `README.md`, `app/README.md`, свежими docs и фактическим кодом.
- Для расчетов сначала смотри `app/src/calculations.mjs`, затем `app/src/repository.mjs` и `app/scripts/smoke_check.py`.
- Для изменений схемы правь `app/db/schema.sql` и при необходимости миграции в `app/src/sql.mjs`.
- Для UI учитывай, что `client.js` обслуживает и старый, и новый дизайн; не ломай `data-page` и `data-house-prefix`.
- После изменений в расчетах, импорте или схеме запускай `npm test`; для эталонной сверки используй `STRICT_IMPORT_CHECK=1 npm test`.
- Если трогаешь production/deploy, проверяй `docs/deployment.md`, `Dockerfile`, `railway.toml` и `render.yaml`.
