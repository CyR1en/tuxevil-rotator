import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { initDb, closeDb } from "../../src/db-store.js";
import { AccountRotator } from "../../src/rotator.js";
import { dynamicCatalog } from "../../src/providers/google-antigravity/dynamic-catalog.js";
import { getAccountIdentity } from "../../src/account-identity.js";
import { FileSettingsRepository } from "../../src/settings-repository.js";

const localFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network access in restart fixture"); };
await initDb();
const rotator = new AccountRotator({
  proxyPort: 0, requestsPerRotation: 5, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300000,
  accounts: ["a", "b"].map((id) => ({ email: `${id}@example.test`, credentials: [
    { provider: "google-antigravity", refreshToken: `fake-${id}`, projectId: `project-${id}` },
  ] })),
});
rotator.stopQuotaPolling();
const accounts = (rotator as unknown as { accounts: import("../../src/types.js").AccountRuntime[] }).accounts;
const id = getAccountIdentity(accounts[0]);
const mode = process.argv[2];
const path = join(process.env.TUXEVIL_ROTATOR_DIR!, "state.json");
if (mode === "write") {
  dynamicCatalog.updateFromEndpointResponse({ models: { "future-only": { maxTokens: 234567 } } }, id);
  dynamicCatalog.updateFromEndpointResponse({ models: { "other-only": {} } }, getAccountIdentity(accounts[1]));
  await rotator.saveState();
} else if (mode === "failure") {
  const previous = readFileSync(path, "utf8");
  const repository = FileSettingsRepository.prototype as unknown as { writeToDisk: (...args: unknown[]) => Promise<void> };
  const original = repository.writeToDisk;
  repository.writeToDisk = async () => { throw new Error("injected write failure"); };
  dynamicCatalog.updateFromEndpointResponse({ models: { "recovered-only": {} } }, id);
  try {
    await rotator.saveState();
    assert.equal(readFileSync(path, "utf8"), previous);
    assert.ok(rotator.getStatus().recentEvents.some((event) => /Failed to save state.*injected write failure/.test(event.message)));
  } finally {
    repository.writeToDisk = original;
  }
  await rotator.saveState();
} else if (mode.startsWith("poll-")) {
  accounts[0].accessToken = "fake-access";
  accounts[0].tokenExpires = Date.now() + 3600000;
  rotator.ensureValidTokenForProvider = async () => {};
  const quota: import("../../src/types.js").ModelQuota[] = [{ displayName: "Gemini", timerType: "fresh", modelKey: "gemini", percentRemaining: 77, resetTime: "", providerId: "google-antigravity" }];
  accounts[0].quota = quota;
  const payload = mode === "poll-empty" ? { models: {} } : mode === "poll-malformed" ? { models: null } : { models: { "future-only": {} } };
  globalThis.fetch = async (input) => {
    assert.match(String(input), /fetchAvailableModels/);
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
  const previous = readFileSync(path, "utf8");
  await rotator.pollAccountQuota(accounts[0]);
  assert.deepEqual(accounts[0].quota, quota);
  // Wait for the actual debounce; flushPendingStateSave itself calls saveState.
  const deadline = Date.now() + 5000;
  while (mode !== "poll-malformed" && readFileSync(path, "utf8") === previous && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (mode === "poll-malformed") {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(readFileSync(path, "utf8"), previous);
  } else {
    assert.notEqual(readFileSync(path, "utf8"), previous, "poll must schedule a durable write");
  }
} else {
  const expected = process.argv[3];
  assert.equal(dynamicCatalog.hasModelForAccount(getAccountIdentity(accounts[1]), "other-only"), true);
  assert.equal(dynamicCatalog.hasModelForAccount(getAccountIdentity(accounts[1]), "future-only"), false);
  if (expected === "none") {
    assert.equal(dynamicCatalog.getModel("future-only"), undefined);
    assert.equal(dynamicCatalog.hasModelForAccount(id, "future-only"), mode === "read-legacy");
    assert.equal(dynamicCatalog.wasDiscovered("future-only"), true);
    assert.equal(rotator.getModelCatalog().some((m) => m.id === "future-only"), false);

  } else {
    assert.equal(dynamicCatalog.hasModelForAccount(id, expected), true);
    assert.ok(rotator.getModelCatalog().some((m) => m.id === expected));
    if (mode === "read-metadata") assert.equal(dynamicCatalog.getModel(expected)?.ctx, 234567);
  }
}
if (mode === "read-legacy") {
  const { startProxy } = await import("../../src/proxy.js");
  const { getProviderAdapter } = await import("../../src/providers/registry.js");
  const { stopVersionChecker } = await import("../../src/version-check.js");
  const { stopNotificationPoller } = await import("../../src/notification-poller.js");
  const adapter = getProviderAdapter("google-antigravity");
  let forwards = 0;
  adapter.ensureValidToken = async () => {};
  adapter.forwardRequest = async () => {
    forwards++;
    throw new Error("Legacy history must not forward before discovery");
  };
  const server = startProxy(rotator, 0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await localFetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "future-only", messages: [{ role: "user", content: "legacy availability" }] }),
    });
    const body = await response.text();
    assert.equal(response.status, 404, body);
    assert.equal(forwards, 0);
    assert.equal(dynamicCatalog.hasModelForAccount(id, "future-only"), true);
    assert.equal(dynamicCatalog.wasDiscovered("future-only"), true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    stopVersionChecker();
    stopNotificationPoller();
  }
}
await closeDb();
