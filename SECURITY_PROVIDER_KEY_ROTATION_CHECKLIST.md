# Provider Key Rotation Checklist

Use this checklist after any suspected credential exposure in logs.

## 0) Immediate containment
- [ ] Pause non-essential automation if needed.
- [ ] Remove or disable any debug logs that print provider config objects.
- [ ] Confirm redaction helper is active in runtime paths.

## 1) Rotate AI provider keys

### Anthropic
- Console: https://console.anthropic.com/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `ANTHROPIC_API_KEY`.

### Groq
- Console: https://console.groq.com/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `GROQ_API_KEY`.

### Google Gemini
- Console: https://aistudio.google.com/
- [ ] Delete old key.
- [ ] Create new key.
- [ ] Update `GEMINI_API_KEY`.

### SambaNova
- Console: https://cloud.sambanova.ai/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `SAMBANOVA_API_KEY`.

### Together AI
- Console: https://api.together.xyz/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `TOGETHER_API_KEY`.

### Cerebras
- Console: https://cloud.cerebras.ai/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `CEREBRAS_API_KEY`.

### Mistral
- Console: https://console.mistral.ai/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `MISTRAL_API_KEY`.

### OpenRouter
- Console: https://openrouter.ai/
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `OPENROUTER_API_KEY`.

### NVIDIA NIM
- Console: https://build.nvidia.com/ (or NVIDIA API dashboard)
- [ ] Revoke old key.
- [ ] Create new key.
- [ ] Update `NVIDIA_API_KEY`.

## 2) Rotate exchange and notification credentials (recommended)

### KuCoin
- Console: https://www.kucoin.com/account/api
- [ ] Disable old API key.
- [ ] Create new key + restrict permissions/IP.
- [ ] Update `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, `KUCOIN_API_PASSPHRASE`.

### Telegram (if used)
- [ ] Regenerate bot token with BotFather if exposure suspected.
- [ ] Update `TELEGRAM_TOKEN`.

## 3) Deploy rotated secrets safely
- [ ] Update environment for both `dex-bot` and `dex-bot-paper`.
- [ ] Restart with env refresh:
  - `pm2 restart dex-bot --update-env`
  - `pm2 restart dex-bot-paper --update-env`
- [ ] Validate both are online: `pm2 list`.

## 4) Evidence cleanup and verification
- [ ] Flush PM2 logs: `pm2 flush`.
- [ ] Verify no raw keys appear in recent logs.
- [ ] Confirm `/api/ai-quota` works and no secret debug output is emitted.

## 5) Hardening follow-up
- [ ] Keep `DEBUG_AI_QUOTA` unset/false in production.
- [ ] Use redaction helper for any new debug/error logging touching config objects.
- [ ] Prefer logging `hasApiKey` booleans over full provider configs.
