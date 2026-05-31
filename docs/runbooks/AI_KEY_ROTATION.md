# AI And Credential Rotation Runbook

Use this when provider calls fail, quotas are exhausted, or any credential may
have leaked into logs, backups, screenshots, or chat.

## Symptoms

- `AI fallback chain failed for <symbol> [strategy]`
- `AI brain failure`
- provider-specific `rate-limited`, `unauthorized`, `model unavailable`, or no-response errors
- `/health` reports `ai.status = missing_api_key` or an open AI circuit

Trading can continue in technical-fallback mode when configured, but signal
quality is degraded. Disable technical fallback during rotation if you want no
new entries while AI is unavailable.

## Immediate Containment

1. Pause non-essential automation if needed.
2. Confirm no debug path logs provider config objects or raw env values.
3. Confirm secret redaction helpers are active in runtime logging.
4. Rotate the suspected credentials before investigating old logs.

## Rotate AI Providers

| Provider | Console | Env var |
|---|---|---|
| Anthropic | `https://console.anthropic.com/settings/keys` | `ANTHROPIC_API_KEY` |
| Groq | `https://console.groq.com/keys` | `GROQ_API_KEY` |
| Gemini | `https://aistudio.google.com/app/apikey` | `GEMINI_API_KEY` |
| Cerebras | `https://cloud.cerebras.ai/platform/users/api_keys` | `CEREBRAS_API_KEY` |
| Mistral | `https://console.mistral.ai/` | `MISTRAL_API_KEY` |
| NVIDIA NIM | `https://build.nvidia.com/settings/api-keys` | `NVIDIA_API_KEY` |
| OpenRouter | `https://openrouter.ai/keys` | `OPENROUTER_API_KEY` |
| SambaNova | `https://cloud.sambanova.ai/apis` | `SAMBANOVA_API_KEY` |
| Together AI | `https://api.together.xyz/settings/api-keys` | `TOGETHER_API_KEY` |

For each provider:

1. Revoke the old key.
2. Create a new key.
3. Update the local `.env` or PM2 environment source.
4. Restart affected bots with env refresh.

## Rotate Exchange And Notification Credentials

KuCoin:

1. Disable the old API key at `https://www.kucoin.com/account/api`.
2. Create a new key with the minimum required permissions.
3. Restrict IP if the operating environment supports it.
4. Update `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, and `KUCOIN_API_PASSPHRASE`.

Telegram, if configured:

1. Regenerate the bot token with BotFather if exposed.
2. Update `TELEGRAM_TOKEN`.

## Deploy Rotated Secrets

```powershell
pm2 restart dex-bot --update-env
pm2 restart dex-bot-paper --update-env
pm2 restart dex-bot-perps --update-env
pm2 save --force
pm2 status
```

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:3002/health
Invoke-RestMethod http://127.0.0.1:3003/health
Invoke-RestMethod http://127.0.0.1:3004/health
pm2 logs dex-bot --lines 80 --nostream
pm2 logs dex-bot-paper --lines 80 --nostream
```

Healthy signs:

- AI status is no longer `missing_api_key`.
- Provider logs show successful validation/fallback decisions.
- No raw secret value appears in PM2 logs.
- POST routes that need admin tokens still fail closed when the token is absent.

## Cleanup

1. Flush or archive contaminated logs only after rotation is complete.
2. Delete leaked backup files such as `data/self-evolution-backups/` if they contain secrets.
3. Verify `.env`, backup folders, and generated artifacts remain gitignored.
4. Keep `DEBUG_AI_QUOTA` unset or false in production.
5. Log `hasApiKey` booleans, never full provider configs.
