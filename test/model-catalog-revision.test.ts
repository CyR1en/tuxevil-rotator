import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/types.js";
import { getModelCatalogRevision } from "../src/model-catalog-revision.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import { AccountRotator } from "../src/rotator.js";
import { buildOverview, DashboardLiveHub } from "../src/dashboard-live.js";
import { buildModelCatalogResponse } from "../src/dashboard.js";
import { signal } from "@preact/signals";
import { createModelCatalogState, type CatalogRoutingState } from "../src/web/state/model-catalog.js";
import { initDb } from "../src/db-store.js";

process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "models-catalog-revision-"));

function fixture() {
  let config: Config = { accounts: [], requestsPerRotation: 5, proxyPort: 0, rotateOnQuotaDrop: 0, quotaPollIntervalMs: 60_000 };
  let ollama = ["fixture-model"];
  let codex = ["gpt-5.6-terra"];
  const active = new Set(["ollama", "openai-codex", "opencode-zen"]);
  const source = {
    getConfig: () => config,
    getOllamaModels: () => ollama,
    getCodexModels: () => codex,
    hasActiveProvider: (id: string) => active.has(id),
  };
  return {
    source, active,
    setConfig: (extra: Partial<Config>) => { config = { ...config, ...extra }; },
    setOllama: (ids: string[]) => { ollama = ids; },
    setCodex: (ids: string[]) => { codex = ids; },
  };
}

describe("live Models catalog revision", () => {
  beforeEach(() => dynamicCatalog.reset());
  afterEach(() => dynamicCatalog.reset());

  it("changes for provider order, switches, model switches, and the review policy", () => {
    const cases: Partial<Config>[] = [
      { providerOrder: ["ollama", "opencode-zen"] },
      { disabledProviders: ["ollama"] },
      { disabledModels: ["ollama/fixture-model"] },
      { autoEnableNewModels: false },
    ];
    for (const settings of cases) {
      const { source, setConfig } = fixture();
      const before = getModelCatalogRevision(source);
      setConfig(settings);
      assert.notEqual(getModelCatalogRevision(source), before, JSON.stringify(settings));
    }
    const { source, setConfig } = fixture();
    setConfig({ autoEnableNewModels: false, disabledProviders: ["ollama"] });
    const waiting = getModelCatalogRevision(source);
    setConfig({ reviewedModels: ["ollama/fixture-model"] });
    assert.notEqual(getModelCatalogRevision(source), waiting, "reviewed state changes even while a provider is off");
  });

  it("changes when an account removes a provider from route selection", () => {
    const { source, active } = fixture();
    const before = getModelCatalogRevision(source);
    active.delete("opencode-zen");
    assert.notEqual(getModelCatalogRevision(source), before);
  });

  it("changes for discovered Ollama and Codex model IDs", () => {
    const { source, setOllama, setCodex } = fixture();
    const before = getModelCatalogRevision(source);
    setOllama(["fixture-model", "second-model"]);
    const ollama = getModelCatalogRevision(source);
    assert.notEqual(ollama, before);
    setCodex(["gpt-5.6-terra", "gpt-6-fixture"]);
    assert.notEqual(getModelCatalogRevision(source), ollama);
  });

  it("includes Google runtime discovery and displayed metadata, excluding quota countdowns", () => {
    const { source } = fixture();
    const before = getModelCatalogRevision(source);
    const response = (maxTokens: number, remainingFraction = 1, resetTime = "2026-10-12T00:00:00Z") => ({
      models: { "gemini-revision-fixture": { maxTokens, quotaInfo: { remainingFraction, resetTime } } },
    });
    dynamicCatalog.updateFromEndpointResponse(response(128_000));
    const discovered = getModelCatalogRevision(source);
    assert.notEqual(discovered, before);
    dynamicCatalog.updateFromEndpointResponse(response(128_000, 0.5, "2026-10-13T00:00:00Z"));
    assert.equal(getModelCatalogRevision(source), discovered);
    dynamicCatalog.updateFromEndpointResponse(response(256_000));
    assert.notEqual(getModelCatalogRevision(source), discovered);
  });

  it("ignores unrelated configuration changes", () => {
    const { source, setConfig } = fixture();
    const before = getModelCatalogRevision(source);
    assert.match(before, /^[a-f0-9]{32}$/);
    setConfig({ requestsPerRotation: 20, quotaPollIntervalMs: 120_000, globalRequestDelayMs: 100 });
    assert.equal(getModelCatalogRevision(source), before);
  });

  it("streams real rotator revisions through the overview and refreshes global Models changes", async () => {
    await initDb();
    const rotator = new AccountRotator(fixture().source.getConfig());
    rotator.stopQuotaPolling();
    const first = rotator.getStatus();
    assert.match(first.modelCatalogRevision ?? "", /^[a-f0-9]{32}$/);
    const initial = buildOverview(first, Date.now(), { database: false });
    assert.equal(initial.modelCatalogRevision, first.modelCatalogRevision);
    const hub = new DashboardLiveHub({ getStatus: () => rotator.getStatus(), capabilities: () => ({ database: false }) });
    hub.collect();
    const live = signal<CatalogRoutingState | null>(initial);
    let reads = 0;
    const state = createModelCatalogState(async () => { reads++; return buildModelCatalogResponse(rotator); });
    const stop = state.watchRouting(live);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 1);
      await rotator.setProviderEnabled("ollama", false);
      const patch = hub.collect().find((message) => message.type === "overview");
      assert.ok(patch && patch.type === "overview");
      assert.notEqual(patch.data.modelCatalogRevision, first.modelCatalogRevision);
      live.value = { ...live.value!, ...patch.data };
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 2);
      assert.equal(state.catalog.value!.providers.find((provider) => provider.id === "ollama")!.enabled, false);
      assert.ok(!hub.collect().some((message) => message.type === "overview" && message.data.modelCatalogRevision));

      rotator.setOllamaModels(["live-revision-model"]);
      const discovery = hub.collect().find((message) => message.type === "overview");
      assert.ok(discovery && discovery.type === "overview");
      assert.ok(discovery.data.modelCatalogRevision);
      live.value = { ...live.value!, ...discovery.data };
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 3);
      assert.ok(state.catalog.value!.models.some((model) => model.id === "live-revision-model"));
    } finally {
      stop();
    }
  });
});
