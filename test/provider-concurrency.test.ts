// Concurrency rules differ by pool: Ollama Cloud (modelKey="session")
// has no per-account limit; Antigravity quota pools keep the
// maxConcurrentRequestsPerAccount guard so long streams don't pile up
// on a single account.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(
  join(tmpdir(), "rotator-concurrency-"),
);

import { initDb } from "../src/db-store.js";
import { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";

before(async () => {
  await initDb();
});

function makeAccount(
  provider: "ollama" | "google-antigravity",
  modelKey: string,
  inFlight: number,
): AccountRuntime {
  const acc: AccountRuntime = {
    config: {
      email: `${provider}@example.com`,
      credentials: [{ provider }],
    },
    accessToken: provider === "google-antigravity" ? "fake" : null,
    tokenExpires: 0,
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [
      {
        modelKey,
        displayName: modelKey,
        percentRemaining: 100,
        resetTime: null,
        timerType: "fresh",
        providerId: provider,
      } as AccountRuntime["quota"][number],
    ],
    lastQuotaPoll: 0,
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: inFlight,
    inFlightByModel: { [modelKey]: inFlight },
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "2026-08-10",
    healthScore: 1,
    tokenBucket: { tokens: 50, lastRefillAt: Date.now() },
  };
  return acc;
}

describe("AccountRotator concurrency rules per provider", () => {
  function makeRotator(acc: AccountRuntime): any {
    const rotator = new AccountRotator({
      proxyPort: 51200,
      rotateOnQuotaDrop: 20,
      routingPolicy: "timer-first",
      quotaPollIntervalMs: 300000,
      requestsPerRotation: 5,
      maxConcurrentRequestsPerAccount: 1,
      maxConcurrentRequestsPerProjectModel: 1,
      accounts: [acc.config],
    });
    rotator.stopQuotaPolling();
    return rotator;
  }

  it("Ollama session pool ignores per-account concurrency limit", () => {
    const acc = makeAccount("ollama", "session", 5);
    const rotator = makeRotator(acc);
    const now = Date.now();
    assert.equal(
      rotator.isAvailableForModel(acc, "session", now),
      true,
      "Ollama session pool must stay available regardless of inFlight count",
    );
  });

  it("Antigravity claude pool enforces per-account concurrency limit", () => {
    const acc = makeAccount("google-antigravity", "claude", 5);
    const rotator = makeRotator(acc);
    const now = Date.now();
    assert.equal(
      rotator.isAvailableForModel(acc, "claude", now),
      false,
      "Antigravity claude pool must reject when inFlight >= maxConcurrentRequestsPerAccount",
    );
  });

  it("Antigravity gemini pool enforces per-account concurrency limit", () => {
    const acc = makeAccount("google-antigravity", "gemini", 5);
    const rotator = makeRotator(acc);
    const now = Date.now();
    assert.equal(
      rotator.isAvailableForModel(acc, "gemini", now),
      false,
      "Antigravity gemini pool must reject when inFlight >= maxConcurrentRequestsPerAccount",
    );
  });

  it("startRequest does not track in-flight for the Ollama session pool", () => {
    const acc = makeAccount("ollama", "session", 0);
    acc.inFlightByModel = {};
    const rotator = makeRotator(acc);
    rotator.startRequest(acc, "session");
    assert.deepEqual(
      acc.inFlightByModel,
      {},
      "Ollama session pool must not increment inFlightByModel",
    );
    assert.equal(
      acc.inFlightRequests,
      0,
      "Ollama session pool must not increment inFlightRequests",
    );
  });

  it("startRequest/finishRequest do not track raw Ollama model names", () => {
    const acc = makeAccount("ollama", "session", 0);
    acc.inFlightByModel = {};
    const rotator = makeRotator(acc);
    rotator.setOllamaModels(["gemma4:31b"]);
    rotator.startRequest(acc, "gemma4:31b", "ollama");
    rotator.finishRequest(acc, "gemma4:31b", "ollama");
    assert.deepEqual(
      acc.inFlightByModel,
      {},
      "Raw Ollama model names must not be tracked as in-flight",
    );
    assert.equal(acc.inFlightRequests, 0);
  });

  it("tracks a Google model even when Ollama advertises the same id", () => {
    const acc = makeAccount("google-antigravity", "gemini", 0);
    acc.inFlightByModel = {};
    const rotator = makeRotator(acc);
    const model = "gemini-3.8-flash-high";
    rotator.setOllamaModels([model]);

    rotator.startRequest(acc, model, "google-antigravity");
    assert.equal(acc.inFlightByModel[model], 1);
    assert.equal(acc.inFlightRequests, 1);

    rotator.finishRequest(acc, model, "google-antigravity");
    assert.deepEqual(acc.inFlightByModel, {});
    assert.equal(acc.inFlightRequests, 0);
  });

  it("Antigravity models still track in-flight through startRequest", () => {
    const acc = makeAccount("google-antigravity", "claude", 0);
    const rotator = makeRotator(acc);
    rotator.startRequest(acc, "claude");
    assert.equal(
      acc.inFlightByModel["claude"],
      1,
      "Antigravity claude pool must still increment in-flight",
    );
    assert.equal(acc.inFlightRequests, 1);
    rotator.finishRequest(acc, "claude");
    assert.deepEqual(
      acc.inFlightByModel,
      {},
      "Antigravity claude pool must decrement on finishRequest",
    );
    assert.equal(acc.inFlightRequests, 0);
  });
});
