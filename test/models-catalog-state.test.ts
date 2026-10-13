import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@preact/signals";
import type { ModelCatalogResponse } from "../src/dashboard-types.js";
import { buildModelRows } from "../src/web/lib/models.js";
import { createModelCatalogState, type CatalogRoutingState } from "../src/web/state/model-catalog.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function catalog(ollama = true, zen = true, routed = "opencode-zen"): ModelCatalogResponse {
  return {
    ok: true,
    providers: [
      { id: "opencode-zen", name: "Zen", credentialKind: "api-key", enabled: zen },
      { id: "ollama", name: "Ollama", credentialKind: "api-key", enabled: ollama },
    ],
    models: ["opencode-zen", "ollama"].map((providerId) => ({
      id: "big-pickle", providerId, contextWindow: 128_000, quotaPool: "session",
      source: "catalog", offReason: null, modelSwitch: "on", routed: providerId === routed,
    })),
    autoEnableNewModels: true,
  };
}

function fleet(): CatalogRoutingState {
  return {
    modelCatalogRevision: "initial",
    accounts: [
      { id: "zen-account", email: "same@example.test", provider: "opencode-zen", status: "ready" },
      { id: "ollama-account", email: "same@example.test", provider: "ollama", status: "ready" },
    ],
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Models catalog lifecycle", () => {
  it("does not let a pending initial GET undo a completed mutation", async () => {
    const oldGet = deferred<ModelCatalogResponse>();
    const state = createModelCatalogState(() => oldGet.promise);
    state.catalog.value = catalog();
    const load = state.loadCatalog();
    await turn();
    const latest = catalog(false, false);
    await state.change(async () => latest);
    assert.equal(state.catalog.value, latest, "the mutation is usable while the old GET is pending");

    oldGet.resolve(catalog());
    await load;
    assert.equal(state.catalog.value, latest, "the initial response must not restore obsolete switches");
  });

  it("keeps the newest switches when distinct mutation responses become ready in reverse order", async () => {
    const responseA = deferred<ModelCatalogResponse>();
    const responseB = deferred<ModelCatalogResponse>();
    const started: string[] = [];
    const state = createModelCatalogState(async () => catalog());
    state.catalog.value = catalog();
    const first = state.change(() => { started.push("ollama"); return responseA.promise; });
    const second = state.change(() => { started.push("zen"); return responseB.promise; });

    responseB.resolve(catalog(false, false));
    await turn();
    assert.deepEqual(started, ["ollama"], "the second API write waits for the first response");
    responseA.resolve(catalog(false, true));
    await Promise.all([first, second]);
    assert.deepEqual(state.catalog.value!.providers.map((provider) => provider.enabled), [false, false]);
    assert.deepEqual(started, ["ollama", "zen"]);
  });

  it("does not let an obsolete GET failure replace a successful mutation's state", async () => {
    const oldGet = deferred<ModelCatalogResponse>();
    const state = createModelCatalogState(() => oldGet.promise);
    const load = state.loadCatalog();
    await turn();
    await state.change(async () => catalog(false, false));
    oldGet.reject(new Error("obsolete load failed"));
    await load;
    assert.equal(state.catalogError.value, null);
  });

  for (const status of ["disabled", "flagged"] as const) {
    it(`refreshes the routed label when a live account is ${status} elsewhere`, async () => {
      let response = catalog();
      let reads = 0;
      const state = createModelCatalogState(async () => { reads++; return response; });
      const live = signal<CatalogRoutingState | null>(fleet());
      const stop = state.watchRouting(live);
      try {
        await turn();
        assert.equal(reads, 1);
        response = catalog(true, true, "ollama");
        live.value = { ...live.value!, accounts: live.value!.accounts.map((account) => account.id === "zen-account" ? { ...account, status } : account) };
        await turn();
        const row = buildModelRows(state.catalog.value!, {})[0];
        assert.equal(row.offerings.find((offering) => offering.routed)?.providerId, "ollama");
        assert.equal(reads, 2);
      } finally {
        stop();
      }
    });
  }

  it("reloads global catalog revisions and coalesces live updates behind an outstanding read", async () => {
    const pending = deferred<ModelCatalogResponse>();
    let reads = 0;
    const latest = catalog(false, false, "ollama");
    const state = createModelCatalogState(() => {
      reads++;
      return reads === 2 ? pending.promise : Promise.resolve(reads === 1 ? catalog() : latest);
    });
    const live = signal<CatalogRoutingState | null>(fleet());
    const stop = state.watchRouting(live);
    try {
      await turn();
      live.value = { ...live.value!, modelCatalogRevision: "switches-changed" };
      await turn();
      assert.equal(reads, 2);
      live.value = { ...live.value!, modelCatalogRevision: "order-changed" };
      live.value = { ...live.value!, modelCatalogRevision: "models-discovered" };
      await turn();
      assert.equal(reads, 2, "only one catalog GET runs at a time");
      pending.resolve(catalog());
      await turn();
      assert.equal(reads, 3, "one follow-up GET covers the latest live state");
      assert.equal(state.catalog.value, latest);
    } finally {
      pending.resolve(catalog());
      stop();
    }
  });

  it("ignores ordinary activity, reloads on focus, and stops subscriptions on leaving Models", async () => {
    let reads = 0;
    const state = createModelCatalogState(async () => { reads++; return catalog(); });
    const live = signal<CatalogRoutingState | null>(fleet());
    const focus = new EventTarget();
    const stop = state.watchRouting(live, focus);
    await turn();
    live.value = {
      ...live.value!, accounts: live.value!.accounts.map((account) => ({ ...account, status: "active", totalRequests: 100, lastUsed: 1234 })),
    };
    await turn();
    assert.equal(reads, 1, "request counts and active/ready transitions do not refetch the catalog");
    focus.dispatchEvent(new Event("focus"));
    await turn();
    assert.equal(reads, 2);
    stop();
    live.value = { ...live.value!, modelCatalogRevision: "after-unmount" };
    focus.dispatchEvent(new Event("focus"));
    await turn();
    assert.equal(reads, 2);
  });
});
