# Quickstart

Run the full local stack from a clean clone.

## Prerequisites

- Node.js 20+ and npm 10+
- Docker with Compose
- An OpenAI-compatible LLM endpoint and API key for live answers

## Three commands

```bash
cp .env.example .env
npm install
npm run setup
```

Before running `npm run setup`, set the required values in `.env`:

```bash
JWT_SECRET=<32+ character random secret>
CONNECTION_ENCRYPTION_KEY=<32-byte base64 or hex key>
CONNECTION_RECOVERY_PASSPHRASE=<12+ character passphrase>
LLM_API_KEY=<provider key>
```

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`npm run setup` starts the Docker databases and waits for health, applies the app
schema, seeds the demo accounts and default model, then starts the API and web app
together. Open `http://localhost:5173`; the API listens on `http://localhost:4000`.

Without an LLM key the app still starts, but answer requests fail with `503` until
a provider is configured.

## Next steps

1. [Local setup](local-setup.md) — service commands, schema re-application, and troubleshooting.
2. [Demo data](demo-data.md) — connect the UI to the sample analytics database.
3. [Configuration](../reference/configuration.md) — every variable, default, and hard limit.
