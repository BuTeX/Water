# Деплой MVP

Приложение не является статическим сайтом: ему нужен Node.js-процесс и постоянный файл SQLite. Поэтому для первого запуска подходят Railway, Render с persistent disk или обычный VPS.

## Рекомендация для быстрого запуска

Самый короткий путь сейчас: Railway.

Текущий production:

- Railway domain: `https://yutnaya.up.railway.app`
- Админка: `https://yutnaya.up.railway.app/admin`
- GitHub repo: `https://github.com/BuTeX/Water.git`
- Деплой идет из ветки `main`.
- Railway использует `railway.toml`, корневой `Dockerfile` и healthcheck `/healthz`.

Почему:

- умеет запускать Dockerfile из репозитория;
- умеет подключать volume для SQLite;
- дает публичный домен сервиса без отдельного домена;
- меньше ручной серверной настройки, чем VPS.

Render тоже подходит, но persistent disk доступен для paid web service. Конфиг `render.yaml` уже добавлен.

Важно: рабочая база `app/db/water.sqlite` не должна уходить в публичный репозиторий. В базе есть рабочие ссылки домов и история платежей. Если репозиторий публичный, публикуем только код, а данные переносим на сервер отдельно или вводим через админку.

## Что уже подготовлено

- `Dockerfile` запускает приложение в контейнере.
- `railway.toml` задает Dockerfile и healthcheck для Railway.
- `render.yaml` задает Docker-сервис, `/data` volume и секрет `ADMIN_PASSWORD` для Render.
- При первом старте с `DB_PATH=/data/water.sqlite` приложение создает пустую базу по схеме, если файла базы еще нет.
- В production запуск запрещен с паролем админки `admin`.

## Переменные окружения

Обязательные:

```text
NODE_ENV=production
DB_PATH=/data/water.sqlite
ADMIN_PASSWORD=<сложный пароль>
```

`ADMIN_PASSWORD` нужен для входа в `/admin`. Если его не задать, публичная часть приложения запустится, но админка не позволит войти.

Обычно `PORT` выставляет хостинг. На Railway не задавайте `PORT` и `HOST` вручную: Railway сам передает порт, а приложение слушает на всех интерфейсах.

Если нужно задать порт вручную на другом хостинге:

```text
PORT=4173
```

Telegram-бот:

```text
TELEGRAM_BOT_TOKEN=<токен от BotFather>
TELEGRAM_ADMIN_IDS=<ваш числовой Telegram ID>
TZ=Europe/Moscow
```

`TELEGRAM_BOT_TOKEN` включает бота. Если переменная не задана, сайт и админка работают без Telegram. `TELEGRAM_ADMIN_IDS` задает, кто может сразу добавлять подтвержденные платежи и кому приходят заявки от остальных жителей. Перед первым уведомлением администратор должен написать боту в личку `/start`, иначе Telegram не даст боту отправить ему сообщение.

Еженедельный email-бекап:

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

`BACKUP_EMAIL_ENABLED=true` включает планировщик. Без SMTP-переменных приложение продолжит работать, но отправка бекапов будет отключена с предупреждением в логах. По умолчанию бекап формируется через безопасную SQLite-команду `.backup`, сжимается в `water-backup-*.sqlite.gz` и отправляется на `v.dulec@yandex.ru`. В текущей архитектуре весь важный persistent state находится в SQLite; скриншоты платежей хранятся у Telegram/MAX, а в базе лежат их идентификаторы.

Для Yandex Mail нужен пароль приложения типа "Mail"; обычный пароль аккаунта не использовать. Если в конкретном аккаунте/регионе `smtp.yandex.com` не принимает соединение, можно попробовать `SMTP_HOST=smtp.yandex.ru`.

Расписание использует локальное время Node-процесса. В Docker-образ добавлен `tzdata`, поэтому на Railway задайте `TZ=Europe/Moscow`; стандартное расписание тогда будет воскресенье 03:00 по Москве.

## Railway

1. Создать проект в Railway из GitHub-репозитория с этим кодом.
2. Проверить, что сервис использует `railway.toml` и корневой `Dockerfile`.
3. Добавить volume и примонтировать его в `/data`.
4. Добавить переменные окружения из раздела выше.
5. Запустить деплой.
6. Открыть публичный Railway domain.
7. Открыть `/admin`, войти с `ADMIN_PASSWORD` и загрузить локальный файл `app/db/water.sqlite` в блоке "База SQLite".
8. Для email-бекапа создать в Yandex ID пароль приложения для почты и добавить SMTP-переменные в Railway Variables.

Админка будет доступна по `/admin`.
Перед тестом Telegram-платежей лучше открыть `/admin` и в блоке "Экспорт" скачать "База SQLite". Этот файл можно потом загрузить обратно через блок "База SQLite", чтобы откатить тестовые пополнения.
Для теста email-бекапа после деплоя можно временно запустить `npm run backup:email` в окружении приложения или выставить ближайшее `BACKUP_EMAIL_WEEKDAY`/`BACKUP_EMAIL_TIME`, проверить письмо и вернуть воскресенье 03:00.
Также в админке есть кнопка "Отправить бекап на почту", которая дергает защищенный `POST /api/admin/backup-email`.

### Текущие заметки по Railway

- Публичный проект уже поднят на `https://yutnaya.up.railway.app`.
- Репозиторий публичный: `https://github.com/BuTeX/Water.git`.
- После `git push` в `main` Railway должен автоматически запускать новый деплой.
- Рабочая база должна храниться не в git, а в Railway volume `/data` как `/data/water.sqlite`.
- Состояние email-бекапов хранится на том же volume как `/data/backup-email-state.json`.
- Если публичная страница открывается, но данных нет, вероятнее всего на сервере пустая SQLite-база. Нужно открыть `/admin`, войти с `ADMIN_PASSWORD` и загрузить локальную `app/db/water.sqlite` через блок "База SQLite".
- Если вход в админку возвращает `Admin login is disabled. Set ADMIN_PASSWORD.`, в Railway Variables не задан `ADMIN_PASSWORD`.
- На Railway не задавать `PORT` и `HOST` вручную.

## Render

1. Создать Blueprint из GitHub-репозитория.
2. Render прочитает `render.yaml`.
3. При первом создании Render попросит ввести `ADMIN_PASSWORD`.
4. После деплоя открыть `https://water-payments.onrender.com` или фактический адрес сервиса.

Админка будет доступна по `/admin`.

## VPS

На VPS удобнее всего запускать тот же Dockerfile, но дополнительно нужны:

- домен или публичный IP;
- HTTPS через Caddy/Nginx;
- регулярная копия `/data/water.sqlite`;
- автозапуск контейнера после перезагрузки.

Для первого общего доступа лучше не начинать с VPS, если нет уже готового сервера.
