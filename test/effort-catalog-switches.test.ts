import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { AccountRotator } from "../src/rotator.js";
import type { Config } from "../src/types.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "rotator-effort-catalog-"));
const envOverrides = {
  TUXEVIL_ROTATOR_DIR: fixtureDir,
  TUXEVIL_ROTATOR_TELEMETRY: "off",
  TUXEVIL_ROTATOR_ADMIN_TOKEN: "",
  PI_ROTATOR_ADMIN_TOKEN: "",
  DATABASE_URL: "",
};
const previousEnv = new Map(Object.keys(envOverrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, envOverrides);

const [compat, modelCatalog, types, adminAuth, proxy, versionChecker, notificationPoller] =
  await Promise.all([
    import("../src/compat.js"),
    import("../src/model-catalog.js"),
    import("../src/types.js"),
    import("../src/admin-auth.js"),
    import("../src/proxy.js"),
    import("../src/version-check.js"),
    import("../src/notification-poller.js"),
  ]);
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

const ALIAS = "gemini-3.8-flash-low";
const TARGET = "gemini-3.8-flash-medium";
const key = (id: string) => `google-antigravity/${id}`;

function makeRotator(settings: Partial<Config> = {}, ollamaModels: string[] = []): AccountRotator {
  const config: Config = {
    accounts: [{
      email: "effort-catalog@example.test",
      credentials: [{ provider: "google-antigravity", refreshToken: "fake-refresh", projectId: "fake-project" }],
    }],
    proxyPort: 0,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    ...settings,
  };
  return {
    getConfig: () => config,
    getOllamaModels: () => ollamaModels,
    getCodexModels: () => [],
    hasActiveProvider: (providerId: string) => providerId === "google-antigravity" || (providerId === "ollama" && ollamaModels.length > 0),
    getStatus: () => ({ accounts: [] }),
    saveState() {},
    recordProxyEvent() {},
    getActiveAccount() {
      throw new Error("A disabled effort alias must be rejected before account admission");
    },
  } as unknown as AccountRotator;
}

describe("effort alias catalog switches", () => {
  let server: Server | undefined;

  beforeEach(() => {
    setAntigravityModelsForTest([
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
    ]);
    adminAuth.setPersistedAdminToken("fixture-admin-token");
    types.setEffortRoutingOverride({
      [ALIAS]: { defaultEffort: "medium", targets: { medium: TARGET } },
    });
  });

  afterEach(async () => {
    types.setEffortRoutingOverride(null);
    adminAuth.setPersistedAdminToken(null);
    versionChecker.stopVersionChecker();
    notificationPoller.stopNotificationPoller();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  async function start(rotator: AccountRotator): Promise<string> {
    server = proxy.startProxy(rotator, 0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("does not rebuild a disabled catalog id from its enabled effort target", () => {
    const rotator = makeRotator({ disabledModels: [key(ALIAS.toUpperCase())] });
    assert.equal(modelCatalog.resolveModelRoute(rotator, ALIAS).kind, "off");
    const ids = compat.buildOpenAIModelCatalog(rotator).map((entry) => entry.id);
    assert.ok(!ids.includes(ALIAS), "the public catalog advertised an alias whose route is off");
    assert.ok(ids.includes(TARGET), "an off alias must not hide its enabled concrete target");
  });

  it("does not rebuild a catalog id waiting for review from its reviewed effort target", () => {
    const rotator = makeRotator({ autoEnableNewModels: false, reviewedModels: [key(TARGET)] });
    assert.equal(modelCatalog.resolveModelRoute(rotator, ALIAS).kind, "off");
    const ids = compat.buildOpenAIModelCatalog(rotator).map((entry) => entry.id);
    assert.ok(!ids.includes(ALIAS), "the public catalog advertised an alias waiting for review");
    assert.deepEqual(ids, [TARGET]);
  });

  it("hides a colliding alias when its default target is off, while retaining other concrete models", () => {
    const rotator = makeRotator({ disabledModels: [key(TARGET)] });
    assert.equal(modelCatalog.resolveModelRoute(rotator, ALIAS).kind, "provider");
    const request = compat.openAIToAntigravityBody({ model: ALIAS, messages: [{ role: "user", content: "hello" }] });
    assert.equal(modelCatalog.isRequestOff(rotator, { ...request, providerId: "google-antigravity" }), true);
    const ids = compat.buildOpenAIModelCatalog(rotator).map((entry) => entry.id);
    assert.ok(!ids.includes(ALIAS), "the public catalog advertised an alias whose default target is off");
    assert.ok(!ids.includes(TARGET));
    assert.ok(ids.includes("gemini-3.8-flash-high"));
  });

  it("keeps an enabled colliding alias and uses its default target's metadata", () => {
    const rotator = makeRotator();
    types.setEffortRoutingOverride(null);
    const targetEntry = compat.buildOpenAIModelCatalog(rotator).find((entry) => entry.id === TARGET);
    assert.ok(targetEntry);
    types.setEffortRoutingOverride({
      [ALIAS]: { defaultEffort: "medium", targets: { medium: TARGET } },
    });
    const catalog = compat.buildOpenAIModelCatalog(rotator);
    const aliases = catalog.filter((entry) => entry.id === ALIAS);
    assert.deepEqual(aliases, [{ ...targetEntry, id: ALIAS }]);
    assert.ok(!catalog.some((entry) => entry.id === TARGET));
  });

  it("keeps a configured unlisted alias when its target is reviewed", () => {
    const alias = "operator-effort";
    types.setEffortRoutingOverride({
      [alias]: { defaultEffort: "medium", targets: { medium: TARGET } },
    });
    const rotator = makeRotator({ autoEnableNewModels: false, reviewedModels: [key(TARGET)] });
    assert.equal(modelCatalog.resolveModelRoute(rotator, alias).kind, "unlisted");
    assert.equal(modelCatalog.isRequestOff(rotator, { model: alias, providerId: "google-antigravity" }), false);
    assert.deepEqual(compat.buildOpenAIModelCatalog(rotator).map((entry) => entry.id), [alias]);
  });

  it("keeps an enabled non-Google copy of an off alias under its actual provider", () => {
    const rotator = makeRotator({ disabledModels: [key(ALIAS)] }, [ALIAS]);
    assert.deepEqual(modelCatalog.resolveModelRoute(rotator, ALIAS), {
      kind: "provider", providerId: "ollama", modelId: ALIAS,
    });
    const catalog = compat.buildOpenAIModelCatalog(rotator);
    assert.deepEqual(catalog.filter((entry) => entry.id === ALIAS).map((entry) => entry.owned_by), ["ollama"]);
    assert.ok(catalog.some((entry) => entry.id === TARGET && entry.owned_by === "tuxevil-rotator"));
  });

  for (const path of ["/v1/models", "/api/models?token=fixture-admin-token"]) {
    it(`omits the disabled alias from ${path.split("?")[0]} when generation rejects it`, async () => {
      const base = await start(makeRotator({ disabledModels: [key(ALIAS)] }));
      const request = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ALIAS, messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(request.status, 404);
      assert.equal(((await request.json()) as { error: { code: string } }).error.code, "model_not_found");

      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      const payload = await response.json() as { data: Array<{ id: string }> };
      assert.ok(!payload.data.some((entry) => entry.id === ALIAS), `${path} advertised the rejected alias`);
      assert.ok(payload.data.some((entry) => entry.id === TARGET));
    });
  }

  it("keeps native Gemini discovery concrete and filters the alias's real catalog switch", async () => {
    const base = await start(makeRotator({ disabledModels: [key(ALIAS)] }));
    const response = await fetch(`${base}/v1beta/models`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { models: Array<{ name: string }> };
    assert.ok(!payload.models.some((entry) => entry.name === `models/${ALIAS}`));
    assert.ok(payload.models.some((entry) => entry.name === `models/${TARGET}`));
  });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
