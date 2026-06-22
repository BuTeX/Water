# Water Payments

Проект для учета взносов, расходов и прозрачной отчетности по обслуживанию общей скважины и насосной станции на улице.

База знаний проекта находится в [docs/knowledge-base/README.md](docs/knowledge-base/README.md).

## Паспорт проекта

- Публичный сервер Railway: `https://yutnaya.up.railway.app`
- Публичный дашборд: `https://yutnaya.up.railway.app/`
- Админка: `https://yutnaya.up.railway.app/admin`
- GitHub-репозиторий: `https://github.com/BuTeX/Water.git`
- Основная ветка: `main`
- Локальная рабочая папка у владельца: `D:\YandexDisk\Codex\Water`

Railway подключен к GitHub-репозиторию и деплоит изменения из `main`. Конфигурация деплоя лежит в `railway.toml`, приложение собирается через корневой `Dockerfile`, healthcheck идет по `/healthz`.

В production база SQLite должна лежать на Railway volume по пути `/data/water.sqlite`. Локальная база `app/db/water.sqlite` не коммитится в публичный репозиторий. Если после деплоя сайт пустой, нужно зайти в `/admin` и загрузить рабочий файл базы через блок "База SQLite" либо проверить, что на Railway подключен volume `/data`.

Для входа в админку на Railway обязательно должна быть задана переменная `ADMIN_PASSWORD`. Сам пароль в README, git и сообщения коммитов не записывать.

## Текущая рабочая гипотеза

Лучший первый шаг - mobile-first сайт/PWA с единой базой платежей, админкой, публичным read-only дашбордом и Telegram-ботом как быстрым каналом для жителей.

MAX-бот или MAX Mini App стоит добавлять только если жители действительно пользуются MAX и есть возможность пройти подключение к платформе MAX для партнеров.

## Как работать по этой базе

1. Ответить на вопросы в `02-open-questions.md`.
2. Зафиксировать выбранный вариант реализации в `decisions/`.
3. Сформировать техническое задание и MVP backlog.
4. Реализовать приложение итерациями через Codex.

## Локальное приложение

Первое рабочее MVP находится в папке [app](app).

Запуск:

```bash
cd app
npm run init-db
npm run import:excel
npm test
npm run dev
```

После запуска:

- публичный дашборд: `http://127.0.0.1:4173/`;
- админка: `http://127.0.0.1:4173/admin`;
- пароль администратора по умолчанию: `admin`.

## Telegram-бот

Бот включается переменными окружения:

```text
TELEGRAM_BOT_TOKEN=<токен от BotFather>
TELEGRAM_ADMIN_IDS=<ваш числовой Telegram ID>
```

Команды:

- `/debts` - общая сводка и список должников;
- `/house 12` - информация по дому;
- `/link h12-xxxxxxxxxxxx` - привязать дом в личке по коду доступа;
- `/me` - посмотреть свой привязанный дом;
- `/pay 12 1500 комментарий` - отправить платеж со скрином.

В личке бот также показывает кнопки для основных действий. Если дом привязан к Telegram-аккаунту, платеж можно начать кнопкой "Отправить платеж" и ввести только сумму. Дата платежа ставится автоматически текущим днем. Скриншот платежа обязателен: без фото заявка не создается. Если платеж отправляет администратор из `TELEGRAM_ADMIN_IDS`, он сразу записывается в базу. Платежи остальных жителей сохраняются как заявки и приходят администратору в личку с кнопками "Подтвердить" и "Отклонить".

## Еженедельный email-бекап

Production может раз в неделю отправлять сжатый SQLite-бекап на почту. Для Railway задайте переменные:

```text
BACKUP_EMAIL_ENABLED=true
BACKUP_EMAIL_TO=v.dulec@yandex.ru
BACKUP_EMAIL_WEEKDAY=sunday
BACKUP_EMAIL_TIME=03:00
TZ=Europe/Moscow
SMTP_HOST=smtp.yandex.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<yandex-login-or-email>
SMTP_PASSWORD=<app-password-for-mail>
BACKUP_EMAIL_FROM=<same-email-as-smtp-user>
```

`SMTP_PASSWORD` должен быть паролем приложения Yandex Mail, не обычным паролем аккаунта. Для ручной проверки отправки из окружения приложения есть команда:

```bash
cd app
npm run backup:email
```
