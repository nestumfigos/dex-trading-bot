# AI Provider Key Rotation Runbook

**Symptom in logs:** `AI brain failure N: AI circuit opened for 180s` (8+ events / hour, 2026-05-23). All providers in the fallback chain (Claude → Cerebras → Nvidia → Groq → Gemini → OpenRouter → SambaNova → Together) returning rejection / no response.

**Cause:** API keys revoked / expired / hit quota. Earlier session noted Anthropic + Groq keys were rotated into the .env files in `data/self-evolution-backups/` (those were removed via filter-branch in commit `09407a94`). Keys in current `.env` may be old / wrong.

**Impact:** AI brain off-line → bot falls back to technical-signal-only mode. Technical-only entries have higher false-positive rate. Trading still happens but with degraded discrimination.

## Verify what's broken

```bash
# Count AI failures in last hour of live log
grep -c "AI brain failure\|circuit opened" logs/combined-$(date +%Y-%m-%d).log

# See which provider returned what
grep -E "rate-limited|model unavailable|fallback chain failed" logs/combined-$(date +%Y-%m-%d).log | tail -30
```

## Rotation steps

### 1. Anthropic (Claude)
- Console: https://console.anthropic.com/settings/keys
- Action: revoke any old keys, create a new `sk-ant-...` key
- Update `.env`:
  ```
  ANTHROPIC_API_KEY=sk-ant-...
  ANTHROPIC_ENABLED=true
  ```
- Restart bot. Should see `AI fallback X [strategy]: used=claude after= final=...` in logs.

### 2. Groq
- Console: https://console.groq.com/keys
- Action: create new `gsk_...` key
- `.env`:
  ```
  GROQ_API_KEY=gsk_...
  GROQ_MODEL=llama-3.3-70b-versatile
  ```
- Free tier: 30 req/min, 14400 req/day. Bot caps at 150/min to leave buffer.

### 3. Gemini
- Console: https://aistudio.google.com/app/apikey
- Action: create new API key under the same Google Cloud project
- `.env`:
  ```
  GEMINI_API_KEY=AIza...
  GEMINI_MODEL=gemini-2.0-flash-exp
  ```
- Free tier: 200 req/day. Bot caps at 150 to leave buffer.

### 4. (Optional fallback providers — only if primary chain still unstable)

| Provider | Console | Env var |
|---|---|---|
| Cerebras | https://cloud.cerebras.ai/platform/users/api_keys | `CEREBRAS_API_KEY` |
| Nvidia | https://build.nvidia.com/settings/api-keys | `NVIDIA_API_KEY` |
| OpenRouter | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
| SambaNova | https://cloud.sambanova.ai/apis | `SAMBANOVA_API_KEY` |
| Together | https://api.together.xyz/settings/api-keys | `TOGETHER_API_KEY` |

## Verify after rotation

```bash
# Restart both bots (start.bat watchers auto-restart on kill)
taskkill /PID <live-node-pid> /F
taskkill /PID <paper-node-pid> /T /F

# Wait 30s for restart, then sample log
sleep 30
grep -E "AI (validation|fallback)" logs/combined-$(date +%Y-%m-%d).log | tail -20
```

Healthy output looks like:
```
AI validation BOB [momentum]: used=claude final=BUY
AI validation NUMI [momentum]: used=cerebras after=claude final=HOLD
```

Failure means at least one provider in the chain is succeeding.

Unhealthy output (current state 2026-05-23):
```
AI fallback chain failed for X [momentum]
AI brain failure N: AI response unavailable
```

## Secret hygiene

- **DO NOT** commit `.env` (it's gitignored).
- **DO NOT** commit `data/self-evolution-backups/` — that dir is gitignored after the 2026-05-22 incident where leaked keys forced filter-branch.
- Use 1Password / Bitwarden for the rotation, not pasted into chat.

## Why the bot keeps running with no keys

`ALLOW_TECHNICAL_FALLBACK_ON_AI_FAILURE=true` in `.env` permits technical-signal entries when the AI brain circuit is open AND `AI_UNAVAILABLE_MIN_CONFIRMATIONS` (default 3) technical confirmations are present. So trading continues but at reduced quality.

Set `ALLOW_TECHNICAL_FALLBACK_ON_AI_FAILURE=false` to fully halt entries until AI recovers — useful during key rotation if you want zero trades from the degraded chain.
