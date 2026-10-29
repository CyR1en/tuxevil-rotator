# OpenClaw

Connect OpenClaw to tuxevil-rotator by adding a custom provider to `~/.openclaw/openclaw.json`.

## Automatic connection and reasoning

```bash
tuxevil-rotator install-agent --target openclaw --rotator-url http://127.0.0.1:51200/v1
# Or configure all detected agents:
tuxevil-rotator install-agent --target auto --rotator-url http://127.0.0.1:51200/v1
```

OpenClaw participates in `auto` when its state directory exists and in `all` unconditionally. The installer honors `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`, adds a provider using `openai-completions` (or preserves an existing API choice), and maps the live catalog to reasoning/vision/context metadata. Codex models include `compat.supportsReasoningEffort: true` and their `compat.supportedReasoningEfforts` list. Existing compatibility overrides are preserved.

Choose a Codex model from the rotator provider, then send `/think high` or another supported level. Higher levels such as `xhigh` and `max` are exposed only when advertised. `/think off` does not guarantee zero reasoning on subscription models that cannot disable reasoning. See [OpenClaw thinking levels](https://docs.openclaw.ai/tools/thinking).

The command backs up existing JSON, preserves API keys and the active model, and adds discovered model refs to an existing agent allowlist without replacing it. It does not restart the gateway or alter the default thinking level. Re-run it to refresh the catalog; offline reruns retain the existing inventory. Invalid JSON/JSON5 requiring a parser is left untouched with an error rather than overwritten.

## Configuration

Edit `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "antigravity": {
        "baseUrl": "http://localhost:51200/v1",
        "apiKey": "tuxevil",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini-3.8-flash-high",
            "name": "Gemini 3.8 Flash High",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1048576,
            "maxTokens": 65536
          },
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 65536
          },
          {
            "id": "claude-opus-4-6-thinking",
            "name": "Claude Opus 4.6 Thinking",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 65536
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity/gemini-3.8-flash-high"
      }
    }
  }
}
```

## Anthropic-Compatible Mode

For Claude models, you can alternatively use the Anthropic Messages API:

```json
{
  "models": {
    "providers": {
      "antigravity-anthropic": {
        "baseUrl": "http://localhost:51200",
        "apiKey": "tuxevil",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6",
            "contextWindow": 200000,
            "maxTokens": 65536
          }
        ]
      }
    }
  }
}
```

## Virtual Key Authentication

If you have Virtual Keys configured, replace `"tuxevil"` in `apiKey` with your `rk-...` key.

You can also store keys in the auth profiles file at `~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "version": 1,
  "profiles": {
    "antigravity:default": {
      "type": "api_key",
      "provider": "antigravity",
      "key": "rk-your-virtual-key-here"
    }
  }
}
```

## CLI Commands

```bash
openclaw models list                          # List configured models
openclaw models set antigravity/gemini-3.8-flash-high  # Switch default model
openclaw status                               # Check gateway status
```

## Notes

- The `"mode": "merge"` setting adds the antigravity provider alongside existing built-in providers. Use `"replace"` to disable all other providers.
- Model `id` values must match what the rotator returns from `GET /v1/models`
- Use `"openai-completions"` for `/v1/chat/completions` or `"openai-responses"` for `/v1/responses`; `"anthropic-messages"` selects the Anthropic adapter
