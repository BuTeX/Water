# MAX bot

MAX bot is enabled with environment variables:

```text
MAX_BOT_TOKEN=<MAX bot token>
MAX_ADMIN_IDS=<comma-separated numeric MAX user IDs of admins>
MAX_BOT_WEBHOOK_URL=https://yutnaya.up.railway.app/api/max/webhook
MAX_BOT_WEBHOOK_SECRET=<5-256 chars: A-Z, a-z, 0-9, _ or ->
TZ=Europe/Moscow
```

Production should use webhook delivery. On startup the app calls `POST /subscriptions` in MAX API and subscribes the bot to `message_created` and `bot_started`.

For local testing without public HTTPS, use long polling:

```text
MAX_BOT_POLLING_ENABLED=true
```

Commands:

- `/debts` - debt summary.
- `/house 12` - house summary.
- `/link h12-xxxxxxxxxxxx` - link a MAX account to a house.
- `/me` - show the linked house.
- `/pay 12 1500 comment` - submit a payment claim.
- `/pending` - admin-only pending payment claims.
- `/approve 123` - admin-only approve a claim.
- `/reject 123` - admin-only reject a claim.

Payments approved through MAX are saved with source `max`.
