# Hermes

Connect Hermes AI agent to tuxevil-rotator using a custom provider configuration.

## Automatic connection and reasoning

```bash
tuxevil-rotator install-agent --target hermes --rotator-url http://127.0.0.1:51200/v1
```

The command honors `HERMES_HOME` (default `~/.hermes`) and adds or updates the named rotator endpoint, populates model context metadata and marks discovered Codex models as reasoning-capable using a named-provider `model_overrides` entry. It preserves existing keys (including `key_env`), API mode, the selected model and `agent.reasoning_effort`. It does not inject a fixed `extra_body.reasoning_effort` or per-model effort override that would prevent interactive changes.

Select the rotator provider and a Codex model, then use `/reasoning low`, `/reasoning medium`, `/reasoning high`, `/reasoning xhigh` or `/reasoning max` as supported by that model. The current valid efforts are published in `/v1/models` under `meta.reasoning_efforts`; Hermes controls the native picker. These settings are passed through the rotator as `reasoning_effort` for Chat Completions or `reasoning.effort` for Responses. See [Hermes custom endpoints](https://hermes-agent.nousresearch.com/docs/integrations/providers).

Re-run installation to refresh the stored model inventory. If the endpoint is offline, existing models remain. Existing configuration is backed up before writing. PyYAML is needed to update a non-JSON YAML file safely; without it the command preserves the file and reports the missing parser. New configurations can be written as JSON, which is valid YAML.

## Configuration

Edit `~/.hermes/config.yaml`:

```yaml
model:
  default: gemini-3.8-flash-high
  provider: custom
  base_url: http://localhost:51200/v1
  api_key: tuxevil
```

## Alternative: Named Custom Provider

For more control or multiple endpoints, use the `custom_providers` section:

```yaml
custom_providers:
  - name: antigravity
    base_url: http://localhost:51200/v1
    api_mode: chat_completions
```

Then select it with:

```bash
hermes model
# Select "Custom endpoint", choose "antigravity"
```

Or switch mid-session:

```
/model custom:antigravity:gemini-3.8-flash-high
```

## Interactive Setup

```bash
hermes model
# Select "Custom endpoint (self-hosted / VLLM / etc.)"
# API base URL: http://localhost:51200/v1
# API key: tuxevil
# Model name: gemini-3.8-flash-high
```

## Available Models

```
gemini-3.8-flash-high     gemini-3.8-flash-medium    gemini-3.8-flash-low
gemini-3.6-flash-high     gemini-3.6-flash-medium    gemini-3.6-flash-low
gemini-3.1-pro-high       gemini-3.1-pro-low
claude-sonnet-4-6         claude-opus-4-6-thinking
gpt-oss-120b-medium
```

## Notes

- The `OPENAI_BASE_URL` / `LLM_MODEL` environment variables are not supported in current Hermes — use `config.yaml`
- For Anthropic-compatible mode, set `api_mode: anthropic_messages` in the named provider config and use `claude-sonnet-4-6` or `claude-opus-4-6-thinking` as the model
