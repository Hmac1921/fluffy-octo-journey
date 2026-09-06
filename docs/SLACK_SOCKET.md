## Socket Mode (local development)

This project supports two ways to receive Slack events:

- Socket Mode (recommended for local dev): set `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`.
- Webhook mode (ExpressReceiver): set `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` and expose your server via a public URL (ngrok, ingress).

Env variables:

- `SLACK_BOT_TOKEN` — bot token (xoxb-...)
- `SLACK_SIGNING_SECRET` — signing secret for webhook mode
- `SLACK_APP_TOKEN` — app-level token (xapp-...) for Socket Mode

Socket Mode usage:

1. Add the tokens to your `.env` (do not commit secrets).
2. Run the server in dev mode:

```bash
pnpm start
```

3. The server will initialize Bolt in Socket Mode and handle events without needing a public URL.

Notes:

- Ensure your Slack app has the `connections:write` scope and you generate an App-Level Token (`xapp-...`).
- For production, use the ExpressReceiver approach with a signed public endpoint and proper auth.
