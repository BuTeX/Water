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

- `/debts` - debt summary with the street map card.
- `/house 12` - house summary.
- `/link 12` - submit a house-link request for admin approval.
- `/me` - show the linked house.
- `/pay 12 1500 comment` - submit a payment claim.
- `/pending` - admin-only pending payment claims.
- `/approve 123` - admin-only approve a claim.
- `/reject 123` - admin-only reject a claim.
- `/approve_link 123` - admin-only approve a house-link request.
- `/reject_link 123` - admin-only reject a house-link request.

Payments approved through MAX are saved with source `max`.

Payment claims from residents require an image screenshot. The bot accepts either order: payment details first and then the screenshot, or screenshot first and then payment details.
If an account is not linked to a house, the resident can send `/link 12` or use the "Привязать дом" button. The request appears in the admin panel and is sent to MAX admins for approval.
