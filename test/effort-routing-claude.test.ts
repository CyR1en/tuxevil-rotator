// Anthropic Messages requests pick an effort alias's target from
// output_config.effort or their thinking settings.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Config } from "../src/types.js";

process.env.TUXEVIL_ROTATOR_TELEMETRY = "off";

const [translators, types, modelCatalog] = await Promise.all([
  import("../src/providers/google-antigravity/translators.js"),
  import("../src/types.js"),
  import("../src/model-catalog.js"),
]);

const ALIAS = "gemini-3.8-flash";
const TARGETS = { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" };

function messages(extra: Record<string, unknown> = {}) {
  return {
    model: ALIAS,
    max_tokens: 4096,
    messages: [{ role: "user" as const, content: "Hi" }],
    ...extra,
  };
}

const target = (request: ReturnType<typeof messages>) =>
  translators.anthropicToAntigravityBody(request as never).catalogModel;

describe("Claude-style effort routing", () => {
  beforeEach(() => types.setEffortRoutingOverride({ [ALIAS]: { defaultEffort: "medium", targets: TARGETS } }));
  afterEach(() => types.setEffortRoutingOverride(null));

  it("uses output_config.effort", () => {
    assert.equal(target(messages({ output_config: { effort: "high" } })), TARGETS.high);
    assert.equal(target(messages({ output_config: { effort: "LOW" } })), TARGETS.low);
  });

  it("maps thinking budgets to levels", () => {
    const budget = (tokens: number) => target(messages({ thinking: { type: "enabled", budget_tokens: tokens } }));
    assert.equal(budget(1024), TARGETS.low);
    assert.equal(budget(3999), TARGETS.low);
    assert.equal(budget(4000), TARGETS.medium, "Claude Code's think");
    assert.equal(budget(15_999), TARGETS.medium);
    assert.equal(budget(16_000), TARGETS.high);
    assert.equal(budget(31_999), TARGETS.high, "Claude Code's ultrathink");
  });

  it("asks for low when thinking is off and for the default when it is adaptive or absent", () => {
    assert.equal(target(messages({ thinking: { type: "disabled" } })), TARGETS.low);
    assert.equal(target(messages({ thinking: { type: "adaptive" } })), TARGETS.medium);
    assert.equal(target(messages()), TARGETS.medium);
  });

  it("prefers output_config.effort over thinking, and the latest per-message effort over both", () => {
    assert.equal(
      target(messages({ output_config: { effort: "low" }, thinking: { type: "enabled", budget_tokens: 31_999 } })),
      TARGETS.low,
    );
    assert.equal(
      target(
        messages({
          output_config: { effort: "high" },
          messages: [
            { role: "user", content: "Plan it" },
            { role: "assistant", content: "Done" },
            { role: "system", content: [], output_config: { effort: "low" } },
            { role: "user", content: "Summarize" },
          ],
        }),
      ),
      TARGETS.low,
    );
  });

  it("keeps unmapped levels on the default", () => {
    assert.equal(target(messages({ output_config: { effort: "max" } })), TARGETS.medium);
  });

  it("leaves OpenAI requests to reasoning_effort", () => {
    const body = translators.openAIToAntigravityBody(
      { model: ALIAS, reasoning_effort: "low", messages: [{ role: "user", content: "Hi" }] },
      { routingEffort: "high" },
    );
    assert.equal(body.catalogModel, TARGETS.low);
    assert.equal(body.displayModel, ALIAS);
  });

  it("checks the switch of the level a Claude request resolves to", () => {
    const config = { accounts: [], disabledModels: [`google-antigravity/${TARGETS.high}`] } as unknown as Config;
    const source = { getConfig: () => config, getOllamaModels: () => [], getCodexModels: () => [], hasActiveProvider: () => true };
    const high = translators.anthropicToAntigravityBody(messages({ thinking: { type: "enabled", budget_tokens: 20_000 } }) as never);
    assert.equal(modelCatalog.isRequestOff(source, { ...high, providerId: "google-antigravity" }), true);
    const low = translators.anthropicToAntigravityBody(messages({ thinking: { type: "enabled", budget_tokens: 2_000 } }) as never);
    assert.equal(modelCatalog.isRequestOff(source, { ...low, providerId: "google-antigravity" }), false);
  });
});
