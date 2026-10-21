import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import {
  getAntigravityContextWindow,
  getEffectiveAntigravityModels,
  isDynamicallyAvailableAntigravityModel,
} from "../src/providers/google-antigravity/catalog.js";
import {
  isTieredEffortModel,
  openAIToAntigravityBody,
} from "../src/providers/google-antigravity/translators.js";
import { getModelSpec, setModelSpecsOverride } from "../src/compat/model-specs.js";
import { extractQuotas } from "../src/providers/google-antigravity/quota.js";
import { getModelPricing, applyModelAlias } from "../src/types.js";
import type { GoogleQuotaResponse } from "../src/types.js";

describe("DynamicModelRegistry", () => {
  beforeEach(() => {
    dynamicCatalog.reset();
  });

  it("starts with an empty dynamic registry", () => {
    assert.deepEqual(dynamicCatalog.getAllModels(), []);
    assert.equal(dynamicCatalog.getModel("gemini-3.8-flash-high"), undefined);
  });

  it("publishes only Antigravity models present in the current quota snapshot", () => {
    assert.deepEqual(getEffectiveAntigravityModels().map(({ id }) => id), []);
    assert.equal(isDynamicallyAvailableAntigravityModel("claude-opus-4-6-thinking"), false);

    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-future-flash": {
          quotaInfo: { remainingFraction: 0.9 },
        },
      },
    });

    assert.deepEqual(
      getEffectiveAntigravityModels().map(({ id }) => id),
      ["gemini-future-flash"],
    );
    assert.equal(isDynamicallyAvailableAntigravityModel("gemini-future-flash"), true);
    assert.equal(isDynamicallyAvailableAntigravityModel("claude-opus-4-6-thinking"), false);
  });

  it("dynamically ingests new models from fetchAvailableModels response", () => {
    const mockResponse: GoogleQuotaResponse = {
      defaultAgentModelId: "gemini-4.0-flash-tiered",
      models: {
        "gemini-4.0-flash-tiered": {
          displayName: "Gemini 4.0 Flash (Tiered)",
          maxTokens: 2097152,
          maxOutputTokens: 65536,
          supportsThinking: true,
          thinkingBudget: -1,
          supportsImages: true,
          supportsVideo: true,
          quotaInfo: { remainingFraction: 0.95 },
        },
        "gemini-4.0-pro-high": {
          displayName: "Gemini 4.0 Pro (High)",
          maxTokens: 2097152,
          maxOutputTokens: 65536,
          supportsThinking: true,
          thinkingBudget: 16000,
          quotaInfo: { remainingFraction: 0.95 },
        },
        "claude-opus-5-thinking": {
          displayName: "Claude Opus 5 (Thinking)",
          maxTokens: 1048576,
          maxOutputTokens: 64000,
          supportsThinking: true,
          thinkingBudget: 32768,
          quotaInfo: { remainingFraction: 0.8 },
        },
      },
      tieredModelIds: {
        flash: ["gemini-4.0-flash-tiered"],
      },
    };

    const newCount = dynamicCatalog.updateFromEndpointResponse(mockResponse);
    assert.equal(newCount, 3);
    assert.equal(dynamicCatalog.getDefaultAgentModelId(), "gemini-4.0-flash-tiered");

    // 1. Check gemini-4.0-flash-tiered
    const flash4 = dynamicCatalog.getModel("gemini-4.0-flash-tiered");
    assert.ok(flash4);
    assert.equal(flash4.ctx, 2097152);
    assert.equal(flash4.quotaPool, "gemini");
    assert.equal(flash4.isTiered, true);
    assert.equal(flash4.thinkingBudget, -1);
    assert.equal(flash4.isThinking, true);

    // 2. Check gemini-4.0-pro-high
    const pro4 = dynamicCatalog.getModel("gemini-4.0-pro-high");
    assert.ok(pro4);
    assert.equal(pro4.ctx, 2097152);
    assert.equal(pro4.quotaPool, "gemini");
    assert.equal(pro4.isTiered, false);
    assert.equal(pro4.thinkingBudget, 16000);

    // 3. Check claude-opus-5-thinking
    const opus5 = dynamicCatalog.getModel("claude-opus-5-thinking");
    assert.ok(opus5);
    assert.equal(opus5.quotaPool, "claude");
  });

  it("keeps a reconciled union of models advertised by active accounts", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-account-a": { quotaInfo: { remainingFraction: 1 } } },
    }, "account-a@example.com");
    dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-account-b": { quotaInfo: { remainingFraction: 1 } } },
    }, "account-b@example.com");

    assert.ok(dynamicCatalog.getModel("gemini-account-a"));
    assert.ok(dynamicCatalog.getModel("gemini-account-b"));

    dynamicCatalog.updateFromEndpointResponse({ models: {} }, "account-a@example.com");
    assert.equal(dynamicCatalog.getModel("gemini-account-a"), undefined);
    assert.ok(dynamicCatalog.getModel("gemini-account-b"));

    dynamicCatalog.retainAccounts(["account-a@example.com"]);
    assert.equal(dynamicCatalog.getModel("gemini-account-b"), undefined);
    assert.deepEqual(dynamicCatalog.getAllModels(), []);
  });

  it("rejects late snapshots after an account leaves the active generation set", () => {
    dynamicCatalog.retainAccounts([{ id: "account-a", generation: "gen-1" }]);
    const capturedEpoch = dynamicCatalog.captureAccountEpoch("account-a", "gen-1");
    assert.equal(typeof capturedEpoch, "number");
    dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-before-removal": { quotaInfo: { remainingFraction: 1 } } },
    }, "account-a", "gen-1");

    dynamicCatalog.retainAccounts([]);
    assert.equal(dynamicCatalog.getModel("gemini-before-removal"), undefined);
    dynamicCatalog.retainAccounts([{ id: "account-a", generation: "gen-1" }]);
    assert.equal(dynamicCatalog.updateFromEndpointResponse({
      models: { "gemini-late-after-removal": { quotaInfo: { remainingFraction: 1 } } },
    }, "account-a", "gen-1", capturedEpoch as number), 0);
    assert.equal(dynamicCatalog.getModel("gemini-late-after-removal"), undefined);
  });

  it("never treats quota bucket sentinels as discovered models", () => {
    const newCount = dynamicCatalog.updateFromEndpointResponse({
      models: {
        gemini: { quotaInfo: { remainingFraction: 0.75 } },
        claude: { quotaInfo: { remainingFraction: 0.5 } },
        "gemini-real-dynamic-model": { quotaInfo: { remainingFraction: 1 } },
      },
    });

    assert.equal(newCount, 1);
    assert.equal(dynamicCatalog.getModel("gemini"), undefined);
    assert.equal(dynamicCatalog.getModel("claude"), undefined);
    assert.equal(dynamicCatalog.wasDiscovered("gemini"), false);
    assert.equal(dynamicCatalog.wasDiscovered("claude"), false);
    assert.equal(dynamicCatalog.wasDiscovered("gemini-real-dynamic-model"), true);
  });

  it("keeps a known-good snapshot when the runtime response is malformed", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-known-good": { quotaInfo: { remainingFraction: 1 } },
      },
    }, "account-a");

    assert.equal(dynamicCatalog.updateFromEndpointResponse(
      { models: null } as unknown as GoogleQuotaResponse,
      "account-a",
    ), 0);
    assert.ok(dynamicCatalog.getModel("gemini-known-good"));

    assert.equal(dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-null-entry": null,
        "gemini-array-entry": [],
      },
      tieredModelIds: {
        invalid: [null, 42],
      },
    } as unknown as GoogleQuotaResponse, "account-a"), 0);
    assert.ok(dynamicCatalog.getModel("gemini-known-good"));
  });

  it("rejects prototype-sensitive model IDs without replacing a known-good snapshot", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-known-good": { quotaInfo: { remainingFraction: 1 } },
      },
    }, "account-a");
    const unsafe = JSON.parse(
      '{"models":{"__proto__":{"quotaInfo":{"remainingFraction":1}}}}',
    ) as GoogleQuotaResponse;

    assert.equal(
      dynamicCatalog.updateFromEndpointResponse(unsafe, "account-a"),
      0,
    );
    assert.ok(dynamicCatalog.getModel("gemini-known-good"));
    assert.equal(dynamicCatalog.wasDiscovered("__proto__"), false);
  });

  it("skips malformed entries and non-finite metadata without losing valid models", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-null-entry": null,
        "gemini-valid-entry": {
          maxTokens: Number.POSITIVE_INFINITY,
          maxOutputTokens: Number.NaN,
          thinkingBudget: Number.POSITIVE_INFINITY,
          quotaInfo: { remainingFraction: 0.5 },
        },
      },
      tieredModelIds: {
        invalid: [null, 42, ""],
      },
    } as unknown as GoogleQuotaResponse);

    assert.equal(dynamicCatalog.getModel("gemini-null-entry"), undefined);
    assert.deepEqual(getModelSpec("gemini-valid-entry"), {
      maxOutputTokens: 65536,
      thinkingBudget: 24576,
      isThinking: true,
      contextWindow: 1_000_000,
    });
  });

  it("preserves Gemini family defaults for quota-only dynamic metadata", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-5.0-flash": { quotaInfo: { remainingFraction: 0.75 } },
      },
    }, "account@example.com");

    assert.deepEqual(getModelSpec("gemini-5.0-flash"), {
      maxOutputTokens: 65536,
      thinkingBudget: 24576,
      isThinking: true,
      contextWindow: 1_000_000,
    });

    const body = openAIToAntigravityBody({
      model: "gemini-5.0-flash",
      messages: [{ role: "user", content: "ping" }],
    }) as { request: { generationConfig?: Record<string, unknown> } };
    assert.deepEqual(body.request.generationConfig, {
      maxOutputTokens: 32768,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 },
    });
  });

  it("seeds sparse known models from their exact static specs", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "claude-sonnet-4-5": { quotaInfo: { remainingFraction: 0.75 } },
      },
    });

    assert.deepEqual(getModelSpec("claude-sonnet-4-5"), {
      maxOutputTokens: 64000,
      thinkingBudget: 32768,
      isThinking: true,
      contextWindow: 200_000,
    });
  });

  it("keeps historical quota-pool provenance after a dynamic model disappears", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-ephemeral-vnext": { quotaInfo: { remainingFraction: 1 } },
      },
    }, "account-a");
    dynamicCatalog.updateFromEndpointResponse({ models: {} }, "account-a");

    assert.equal(dynamicCatalog.getModel("gemini-ephemeral-vnext"), undefined);
    assert.equal(dynamicCatalog.wasDiscovered("gemini-ephemeral-vnext"), true);
    assert.equal(dynamicCatalog.resolveQuotaPool("gemini-ephemeral-vnext"), "gemini");
  });

  it("exposes dynamic model specs through getModelSpec", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-5.0-ultra": {
          maxTokens: 5000000,
          maxOutputTokens: 100000,
          supportsThinking: true,
          thinkingBudget: 50000,
        },
      },
    });

    const spec = getModelSpec("gemini-5.0-ultra");
    assert.deepEqual(spec, {
      maxOutputTokens: 100000,
      thinkingBudget: 50000,
      isThinking: true,
      contextWindow: 5000000,
    });
  });

  it("prefers case-insensitive operator substring specs over dynamic metadata", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-5.0-ultra": {
          maxTokens: 5000000,
          maxOutputTokens: 100000,
          supportsThinking: true,
          thinkingBudget: 50000,
        },
      },
    });
    setModelSpecsOverride({
      GeMiNi: {
        maxOutputTokens: 12345,
        thinkingBudget: 6789,
        isThinking: true,
        contextWindow: 222222,
      },
    });

    try {
      assert.deepEqual(getModelSpec("GEMINI-5.0-ULTRA"), {
        maxOutputTokens: 12345,
        thinkingBudget: 6789,
        isThinking: true,
        contextWindow: 222222,
      });
    } finally {
      setModelSpecsOverride(null);
    }
  });

  it("uses runtime constraints for bundled IDs unless an operator overrides them", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-3.8-flash-high": {
          maxOutputTokens: 2048,
          supportsThinking: false,
          quotaInfo: { remainingFraction: 1 },
        },
      },
    });

    assert.deepEqual(getModelSpec("gemini-3.8-flash-high"), {
      maxOutputTokens: 2048,
      thinkingBudget: -1,
      isThinking: false,
      contextWindow: 1_000_000,
    });
    const runtimeBody = openAIToAntigravityBody({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 10_000,
    }) as { request: { generationConfig?: Record<string, unknown> } };
    assert.equal(runtimeBody.request.generationConfig?.maxOutputTokens, 2048);
    assert.equal(runtimeBody.request.generationConfig?.thinkingConfig, undefined);

    setModelSpecsOverride({
      "gemini-3.8": {
        maxOutputTokens: 4096,
        thinkingBudget: 1000,
        isThinking: true,
        contextWindow: 500_000,
      },
    });
    try {
      assert.deepEqual(getModelSpec("gemini-3.8-flash-high"), {
        maxOutputTokens: 4096,
        thinkingBudget: 1000,
        isThinking: true,
        contextWindow: 500_000,
      });
    } finally {
      setModelSpecsOverride(null);
    }
  });

  it("merges partial substring overrides over bundled specs without invalid payload numbers", () => {
    setModelSpecsOverride({
      "gemini-3.8": {
        maxOutputTokens: 1000,
        isThinking: true,
      },
    });

    try {
      assert.deepEqual(getModelSpec("gemini-3.8-flash-high"), {
        maxOutputTokens: 1000,
        thinkingBudget: -1,
        isThinking: true,
        contextWindow: 1_000_000,
      });

      const body = openAIToAntigravityBody({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "ping" }],
      }) as { request: { generationConfig?: Record<string, unknown> } };
      const serialized = JSON.parse(JSON.stringify(body)) as typeof body;
      assert.deepEqual(serialized.request.generationConfig?.thinkingConfig, {
        includeThoughts: true,
      });
    } finally {
      setModelSpecsOverride(null);
    }
  });

  it("merges partial exact overrides over runtime-discovered specs", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-5.0-ultra": {
          maxTokens: 5_000_000,
          maxOutputTokens: 100_000,
          supportsThinking: true,
          thinkingBudget: 50_000,
          minThinkingBudget: 2_000,
          quotaInfo: { remainingFraction: 1 },
        },
      },
    });
    setModelSpecsOverride({
      "gemini-5.0-ultra": { maxOutputTokens: 60_000 },
    });

    try {
      assert.deepEqual(getModelSpec("gemini-5.0-ultra"), {
        maxOutputTokens: 60_000,
        thinkingBudget: 50_000,
        minThinkingBudget: 2_000,
        isThinking: true,
        contextWindow: 5_000_000,
      });

      setModelSpecsOverride({
        "gemini-5.0-ultra": { thinkingBudget: 0 },
      });
      assert.equal(getModelSpec("gemini-5.0-ultra").thinkingBudget, 0);
    } finally {
      setModelSpecsOverride(null);
    }
  });

  it("exposes dynamic context windows through getAntigravityContextWindow", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-future-supermodel": {
          maxTokens: 4000000,
        },
      },
    });

    assert.equal(getAntigravityContextWindow("gemini-future-supermodel"), 4000000);
  });

  it("dynamically recognizes tiered models in isTieredEffortModel without code changes", () => {
    assert.equal(isTieredEffortModel("gemini-4.0-flash-tiered"), true);
    assert.equal(isTieredEffortModel("gemini-4.0-flash-tiered-high"), false);
    assert.equal(isTieredEffortModel("gemini-future-tiered"), true);
    assert.equal(isTieredEffortModel("gemini-future-pro"), false);
  });

  it("extracts pool quota via dynamically discovered models", () => {
    dynamicCatalog.updateFromEndpointResponse({
      models: {
        "gemini-future-super-flash": {
          quotaInfo: { remainingFraction: 0.77 },
        },
      },
    });

    const rawData = {
      models: {
        "gemini-future-super-flash": {
          quotaInfo: { remainingFraction: 0.77 },
        },
      },
    };
    const quotas = extractQuotas(rawData, []);
    const gemini = quotas.find((q) => q.modelKey === "gemini");
    assert.ok(gemini, "should resolve newly discovered model to gemini quota pool");
    assert.equal(gemini.percentRemaining, 77);
  });

  it("resolves model pricing dynamically by family for unlisted future models", () => {
    // Unlisted future Flash model falls back to Flash pricing
    const flashPrice = getModelPricing("gemini-4.5-flash-hyper");
    assert.ok(flashPrice);
    assert.equal(flashPrice.inputPer1M, 0.5);
    assert.equal(flashPrice.outputPer1M, 3.0);

    // Unlisted future Pro model falls back to Pro pricing
    const proPrice = getModelPricing("gemini-5.0-pro-ultra");
    assert.ok(proPrice);
    assert.equal(proPrice.inputPer1M, 2.0);
    assert.equal(proPrice.outputPer1M, 12.0);

    // Unlisted future Opus model falls back to Opus pricing
    const opusPrice = getModelPricing("claude-opus-5-super");
    assert.ok(opusPrice);
    assert.equal(opusPrice.inputPer1M, 5.0);
    assert.equal(opusPrice.outputPer1M, 25.0);
  });

  it("routes gemini-3.8-flash variants directly to upstream models", () => {
    assert.equal(applyModelAlias("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
    assert.equal(applyModelAlias("gemini-3.8-flash-medium"), "gemini-3.8-flash-medium");
    assert.equal(applyModelAlias("gemini-3.8-flash-low"), "gemini-3.8-flash-low");
  });

  it("does not alias or fallback unknown models so upstream errors are preserved", () => {
    assert.equal(applyModelAlias("gemini-3.8-flash-tiered"), "gemini-3.8-flash-tiered");
    assert.equal(applyModelAlias("gemini-nonexistent-model"), "gemini-nonexistent-model");
  });
});
