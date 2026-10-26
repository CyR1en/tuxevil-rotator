# Model pricing audit — 2026-10-25

Prices are USD per million tokens. This audit covers every entry in `src/types.ts` and the standalone telemetry receiver. Only confirmed rates were changed; model availability and routing were not changed.

## Official sources

| Provider / models | Source | Result |
| --- | --- | --- |
| Google Gemini 4 Argon, all effort aliases | https://ai.google.dev/gemini-api/docs/pricing | Standard input 2, output 10, cached input 0.10 through November 30, 2026; then 4 / 20 / 0.20. Implicit caching only: removed explicit cache-storage price. |
| Google Gemini 3.6 Flash, all effort aliases | Same Google source | Corrected to introductory 0.75 / 3.75 / 0.075, storage 0.50 per million tokens/hour through December 31, 2026. All four rates double January 1, 2027. |
| Google Gemini 3.8 Flash | Same Google source | Existing introductory rates confirmed, same as 3.6 above. |
| Google Gemini 3.1 Pro and Gemini 3 Flash | Same Google source, preview sections | Existing base text input/output rates retained: 2 / 12 and 0.50 / 3. Long-context and modality tiers are not represented. |
| Claude Opus 4.6 and Sonnet 4.6 | https://platform.claude.com/docs/en/about-claude/pricing | Existing base input/output rates confirmed: 5 / 25 and 3 / 15. |
| OpenAI GPT-5.6 Sol | https://developers.openai.com/api/docs/pricing | Corrected Standard short-context rates to 4 / 20 / 0.40. Promotion available at least through November 21, 2026; no automatic expiry or assumed replacement price. |
| OpenAI GPT-5.6 Terra/Luna, GPT-6 Astra/Sol/Luna | Same OpenAI source | Existing Standard short-context input/output/cache rates confirmed. |
| Ollama GPT-OSS 20b/120b, DeepSeek v4.1 Flash/v4 Pro, GLM 5.2/5.3/5.3 Flash, Gemma4, Kimi K2.6/K2.7 Code/K3, MiniMax M2.7/M3, Mistral Large 3/4, Nemotron 3 Nano/Super/Ultra | https://ollama.com/pricing | Existing application rates confirmed, including published cache rates; stale receiver entries corrected and missing application entries mirrored. Size aliases retain the corresponding model price. |
| OpenCode Big Pickle, Nemotron 3 Ultra Free / 3.5 Lightning Free | https://opencode.ai/docs/zen/ | Zero prices confirmed. Free-tier access restrictions are separate from prices. |

## Unconfirmed and historical entries

The current Google page does not list Gemini 3.7 Flash. Its existing introductory estimate and original verification date are preserved, not newly certified. Antigravity GPT-OSS 120b-medium has no confirmed matching paid API price; its historical 2 / 10 estimate is unchanged and is not the Ollama GPT-OSS price.

Ollama's current table omits DeepSeek v4 Flash :0731, v4 Pro :0813, Qwen3.5 :397b and GLM 5.1. Their historical application estimates remain unchanged. Receiver-only DeepSeek v4 Flash :preview is likewise retained without confirmation.

OpenCode's current page omits MiMo v2.5 Free, Ling 3.0 Flash Fin Free and Muse Spark 1.3 Contributor Free. Their previous zero estimates are preserved, not verified as currently available. Receiver-only Ling 3.0 Tiny Free and Laguna S 2.1 Free retain historical estimates; their names alone do not establish zero cost.

## Estimation limits and maintenance

These are static snapshots, not live billing schedules. Recheck Argon before December 1, Flash before January 1 and GPT-5.6 Sol after November 21. No date-sensitive repricing was introduced.

Application spend logs and receiver savings use aggregate input/output counts. Cached-input/storage metadata does not add cache-aware billing. Estimates omit cache writes, long-context surcharges, audio/image rates, batch/flex/priority discounts, regional premiums, tools, off-peak pricing, subscription credits and taxes. API-equivalent value is not actual subscription savings. Historical aggregate telemetry may be recalculated at today's table; existing persisted spend records are not migrated.

Provider prices differ (for example MiniMax M3 on Ollama versus OpenCode); no other provider's rate was substituted for missing evidence. Dynamic family fallbacks remain estimates for unseen models. The receiver mirror includes all application entries, with a regression test to detect drift, while retaining receiver-only historical entries.
