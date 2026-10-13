// Effort routes edited from the Models page: planned config changes, status
// and suggestions, the /api/catalog/effort-routes endpoints, and edits that
// apply without a restart.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";
import type { ModelCatalogResponse } from "../src/dashboard-types.js";
import type { RequestBody } from "../src/proxy.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime, Config, EffortRoutingRule } from "../src/types.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "rotator-effort-editor-"));
const envOverrides = {
  TUXEVIL_ROTATOR_DIR: fixtureDir,
  TUXEVIL_ROTATOR_TELEMETRY: "off",
  TUXEVIL_ROTATOR_ADMIN_TOKEN: "",
  PI_ROTATOR_ADMIN_TOKEN: "",
  DATABASE_URL: "",
};
const previousEnv = new Map(Object.keys(envOverrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, envOverrides);

const [effort, modelCatalog, types, compat, dashboard, revision, overrides, adminAuth, proxy, versionChecker, notificationPoller, rotatorModule, dbStore, registry] =
  await Promise.all([
    import("../src/effort-routing.js"),
    import("../src/model-catalog.js"),
    import("../src/types.js"),
    import("../src/compat.js"),
    import("../src/dashboard.js"),
    import("../src/model-catalog-revision.js"),
    import("../src/config-overrides.js"),
    import("../src/admin-auth.js"),
    import("../src/proxy.js"),
    import("../src/version-check.js"),
    import("../src/notification-poller.js"),
    import("../src/rotator.js"),
    import("../src/db-store.js"),
    import("../src/providers/registry.js"),
  ]);

const key = (id: string) => `google-antigravity/${id}`;

const FLASH_38: EffortRoutingRule = {
  defaultEffort: "medium",
  targets: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" },
};

/** A rotator stub whose switches and effort routes change its config like the real one. */
function makeSource(settings: Partial<Config> = {}, ollama: string[] = ["glm-5.1"]) {
  let config = { accounts: [], ...settings } as Config;
  const source = {
    getConfig: () => config,
    getOllamaModels: () => ollama,
    getCodexModels: () => ["gpt-6-sol"],
    hasActiveProvider: () => true,
    getStatus: () => ({ accounts: [], security: { adminTokenConfigured: true } }),
    saveState() {},
    recordProxyEvent() {},
    getModelCatalog: () => modelCatalog.listCatalogModels(source),
    refreshModelCatalogs: async () => {},
    setModelsEnabled: async (keys: string[], on: boolean) => {
      config = { ...config, ...modelCatalog.setModelsTurnedOff(config, keys, !on) };
      return true;
    },
    saveEffortRoute: async (previousAlias: string | null, body: unknown) => {
      const plan = effort.planEffortRouteSave(source, previousAlias, body);
      if (plan.ok) {
        config = { ...config, ...plan.patch };
        overrides.applyConfigOverrides(config);
      }
      return plan;
    },
    deleteEffortRoute: async (alias: string) => {
      const plan = effort.planEffortRouteDelete(config, alias);
      if (plan.ok) {
        config = { ...config, ...plan.patch };
        overrides.applyConfigOverrides(config);
      }
      return plan;
    },
  };
  return source;
}

afterEach(() => {
  types.setEffortRoutingOverride(null);
  types.setModelAliasesOverride(null);
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("effort route plans", () => {
  it("creates a route with catalog casing, lower-case levels and standard level order", () => {
    const plan = effort.planEffortRouteSave(makeSource(), null, {
      alias: " gemini-3.6-flash ",
      defaultEffort: "Medium",
      targets: { HIGH: "GEMINI-3.6-FLASH-HIGH", low: "gemini-3.6-flash-low", medium: "gemini-3.6-flash-medium" },
    });
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.equal(plan.alias, "gemini-3.6-flash");
    assert.deepEqual(plan.patch.effortRouting, {
      "gemini-3.6-flash": {
        defaultEffort: "medium",
        targets: { low: "gemini-3.6-flash-low", medium: "gemini-3.6-flash-medium", high: "gemini-3.6-flash-high" },
      },
    });
    assert.deepEqual(Object.keys(plan.patch.effortRouting!["gemini-3.6-flash"].targets), ["low", "medium", "high"]);
    assert.equal(plan.patch.disabledModels, undefined);
  });

  it("reports each problem against its field", () => {
    const source = makeSource({ effortRouting: { "gemini-3.8-flash": FLASH_38 } });
    const duplicate = effort.planEffortRouteSave(source, null, {
      alias: "GEMINI-3.8-FLASH",
      defaultEffort: "xhigh",
      targets: { low: "gpt-6-sol", high: "", "extra level": "gemini-3.8-flash-high" },
    });
    assert.equal(duplicate.ok, false);
    assert.ok(!duplicate.ok && duplicate.status === 400);
    assert.deepEqual(Object.keys(duplicate.ok ? {} : duplicate.fieldErrors ?? {}).sort(), [
      "alias",
      "defaultEffort",
      "targets.extra level",
      "targets.high",
      "targets.low",
    ]);
    if (!duplicate.ok) {
      assert.match(duplicate.fieldErrors!.alias, /Another effort model already uses/);
      assert.match(duplicate.fieldErrors!["targets.low"], /gpt-6-sol isn't a Google Antigravity model/);
      assert.match(duplicate.fieldErrors!["targets.extra level"], /can't contain spaces/);
    }

    const taken = effort.planEffortRouteSave(source, null, { alias: "glm-5.1", defaultEffort: "low", targets: { low: "gemini-3-flash" } });
    assert.ok(!taken.ok && /glm-5\.1 is already a model from /.test(taken.fieldErrors!.alias));

    const spaced = effort.planEffortRouteSave(source, null, { alias: "two words", defaultEffort: "low", targets: { low: "gemini-3-flash" } });
    assert.ok(!spaced.ok && /can't contain spaces/.test(spaced.fieldErrors!.alias));

    const empty = effort.planEffortRouteSave(source, null, { alias: "fresh", defaultEffort: "medium", targets: {} });
    assert.ok(!empty.ok && /at least one effort level/.test(empty.fieldErrors!.targets));

    const notObject = effort.planEffortRouteSave(source, null, null);
    assert.ok(!notObject.ok && notObject.status === 400);
  });

  it("refuses an ID that is already a model alias", () => {
    types.setModelAliasesOverride({ "my-alias": "gemini-3-flash" });
    const plan = effort.planEffortRouteSave(makeSource({ modelAliases: { "my-alias": "gemini-3-flash" } }), null, {
      alias: "my-alias",
      defaultEffort: "low",
      targets: { low: "gemini-3-flash" },
    });
    assert.ok(!plan.ok && /already a model alias for gemini-3-flash/.test(plan.fieldErrors!.alias));
  });

  it("refuses an ID another provider claims statically, beside the field", () => {
    const plan = effort.planEffortRouteSave(makeSource(), null, {
      alias: "made-up-free",
      defaultEffort: "low",
      targets: { low: "gemini-3-flash" },
    });
    assert.ok(!plan.ok && plan.status === 400);
    assert.match(plan.ok ? "" : plan.fieldErrors!.alias, /made-up-free is a model ID of another provider/);
  });

  it("refuses a route the startup validator would reject", () => {
    // An older config may name a route after a model; a new route may not target it.
    const source = makeSource({
      effortRouting: { "gemini-3.8-flash-low": { defaultEffort: "medium", targets: { medium: "gemini-3.8-flash-medium" } } },
    });
    const plan = effort.planEffortRouteSave(source, null, {
      alias: "fresh",
      defaultEffort: "low",
      targets: { low: "gemini-3.8-flash-low" },
    });
    assert.ok(!plan.ok && plan.status === 400);
    assert.match(plan.ok ? "" : plan.error, /chains into effort-routing alias/);
  });

  it("renames a route in place and moves its switch", () => {
    const source = makeSource({
      effortRouting: { "Flash-A": FLASH_38, "flash-b": { defaultEffort: "low", targets: { low: "gemini-3-flash" } } },
      disabledModels: [key("FLASH-A"), "ollama/glm-5.1"],
      reviewedModels: [key("flash-a")],
    });
    const plan = effort.planEffortRouteSave(source, "flash-a", {
      alias: "flash-c",
      defaultEffort: "high",
      targets: { high: "gemini-3.8-flash-high" },
    });
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.deepEqual(Object.keys(plan.patch.effortRouting!), ["flash-c", "flash-b"]);
    assert.deepEqual(plan.patch.disabledModels, ["ollama/glm-5.1", key("flash-c")]);
    assert.deepEqual(plan.patch.reviewedModels, [key("flash-c")]);
  });

  it("keeps the current name when the body omits it, even for an ID older configs allowed", () => {
    const source = makeSource({ effortRouting: { "gemini-3-flash": { defaultEffort: "medium", targets: { medium: "gemini-3.8-flash-medium" } } } });
    const kept = effort.planEffortRouteSave(source, "gemini-3-flash", {
      defaultEffort: "medium",
      targets: { medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" },
    });
    assert.ok(kept.ok, JSON.stringify(kept));
    assert.equal(kept.alias, "gemini-3-flash");

    const renamed = effort.planEffortRouteSave(source, "gemini-3-flash", {
      alias: "gemini-3.1-pro-high",
      defaultEffort: "medium",
      targets: { medium: "gemini-3.8-flash-medium" },
    });
    assert.ok(!renamed.ok && /already a model from/.test(renamed.fieldErrors!.alias));
  });

  it("answers 404 for a route that does not exist", () => {
    const source = makeSource({ effortRouting: { "gemini-3.8-flash": FLASH_38 } });
    const save = effort.planEffortRouteSave(source, "nope", { defaultEffort: "low", targets: { low: "gemini-3-flash" } });
    assert.ok(!save.ok && save.status === 404);
    const remove = effort.planEffortRouteDelete(source.getConfig(), "nope");
    assert.ok(!remove.ok && remove.status === 404);
  });

  it("deletes a route with its switch, and drops effortRouting once empty", () => {
    const config = {
      accounts: [],
      effortRouting: { a: FLASH_38, b: { defaultEffort: "low", targets: { low: "gemini-3-flash" } } },
      disabledModels: [key("A"), "ollama/glm-5.1"],
    } as unknown as Config;
    const first = effort.planEffortRouteDelete(config, "A");
    assert.ok(first.ok);
    assert.deepEqual(Object.keys(first.patch.effortRouting!), ["b"]);
    assert.deepEqual(first.patch.disabledModels, ["ollama/glm-5.1"]);
    const last = effort.planEffortRouteDelete({ ...config, ...first.patch }, "b");
    assert.ok(last.ok && last.patch.effortRouting === undefined);
  });
});

describe("effort route status and suggestions", () => {
  it("says what clients get from each route", () => {
    const source = makeSource(
      {
        effortRouting: {
          "gemini-3.8-flash": FLASH_38,
          "gemini-3.1-pro": { defaultEffort: "high", targets: { low: "gemini-3.1-pro-low", high: "gemini-3.1-pro-high" } },
          "gemini-3.6-flash": { defaultEffort: "medium", targets: { medium: "gemini-3.6-flash-medium" } },
          "switched-off": { defaultEffort: "low", targets: { low: "gemini-3-flash" } },
          "my-model": { defaultEffort: "low", targets: { low: "gemini-3.5-flash-lite" } },
        },
        disabledModels: [key("gemini-3.1-pro-low"), key("gemini-3.6-flash-medium"), key("switched-off")],
      },
      ["my-model"],
    );
    overrides.applyConfigOverrides(source.getConfig());
    const body = dashboard.buildModelCatalogResponse(source as unknown as AccountRotator);
    const byAlias = Object.fromEntries(body.effortRoutes.map((route) => [route.alias, route]));
    assert.equal(byAlias["gemini-3.8-flash"].status, "live");
    assert.equal(byAlias["gemini-3.8-flash"].listed, true);
    assert.equal(byAlias["gemini-3.1-pro"].status, "partial");
    assert.deepEqual(byAlias["gemini-3.1-pro"].targets.map((target) => [target.effort, target.served]), [["low", false], ["high", true]]);
    assert.equal(byAlias["gemini-3.6-flash"].status, "hidden");
    assert.equal(byAlias["switched-off"].status, "off");
    assert.equal(byAlias["switched-off"].enabled, false);
    assert.equal(byAlias["my-model"].status, "hidden");
    assert.equal(byAlias["my-model"].listed, false);
    assert.equal(byAlias["my-model"].shadowedBy, "ollama");

    const tagged = body.models.filter((model) => model.effortRoute).map((model) => [model.id, model.effortRoute!.alias, model.effortRoute!.effort]);
    assert.ok(tagged.some(([id, alias, level]) => id === "gemini-3.8-flash-high" && alias === "gemini-3.8-flash" && level === "high"));
    assert.ok(body.models.filter((model) => model.providerId !== "google-antigravity").every((model) => !model.effortRoute));

    const off = makeSource({ effortRouting: { "gemini-3.8-flash": FLASH_38 }, disabledProviders: ["google-antigravity"] });
    overrides.applyConfigOverrides(off.getConfig());
    assert.equal(dashboard.buildModelCatalogResponse(off as unknown as AccountRotator).effortRoutes[0].status, "provider-off");
  });

  it("suggests effort families nobody routes yet", () => {
    const aliases = (source: ReturnType<typeof makeSource>) => effort.suggestEffortRoutes(source).map((entry) => entry.alias);
    const all = effort.suggestEffortRoutes(makeSource());
    const flash = all.find((entry) => entry.alias === "gemini-3.8-flash");
    assert.deepEqual(flash?.targets, [
      { effort: "low", model: "gemini-3.8-flash-low" },
      { effort: "medium", model: "gemini-3.8-flash-medium" },
      { effort: "high", model: "gemini-3.8-flash-high" },
    ]);
    assert.ok(aliases(makeSource()).includes("gemini-3.1-pro"));
    assert.ok(!aliases(makeSource()).some((alias) => alias.startsWith("gpt-oss")), "a single variant is not a family");

    assert.ok(!aliases(makeSource({ effortRouting: { "gemini-3.8-flash": FLASH_38 } })).includes("gemini-3.8-flash"));
    const usedElsewhere = makeSource({ effortRouting: { other: { defaultEffort: "high", targets: { high: "gemini-3.6-flash-high" } } } });
    assert.ok(!aliases(usedElsewhere).includes("gemini-3.6-flash"));
    types.setModelAliasesOverride({ "gemini-3.1-pro": "gemini-pro-agent" });
    assert.ok(!aliases(makeSource()).includes("gemini-3.1-pro"));
  });

  it("changes the catalog revision when effort routing changes", () => {
    const before = revision.getModelCatalogRevision(makeSource());
    const after = revision.getModelCatalogRevision(makeSource({ effortRouting: { "gemini-3.8-flash": FLASH_38 } }));
    assert.notEqual(before, after);
  });
});

describe("/api/catalog/effort-routes", () => {
  let server: Server | undefined;

  afterEach(async () => {
    adminAuth.setPersistedAdminToken(null);
    versionChecker.stopVersionChecker();
    notificationPoller.stopNotificationPoller();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      server = undefined;
    }
  });

  async function start(source: ReturnType<typeof makeSource>) {
    adminAuth.setPersistedAdminToken("effort-admin-token");
    server = proxy.startProxy(source as unknown as AccountRotator, 0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, body?: unknown, token = "effort-admin-token") =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { call };
  }

  it("creates, renames and deletes a route, and /v1/models follows each change", async () => {
    const { call } = await start(makeSource());
    const listed = async () =>
      ((await (await call("GET", "/v1/models")).json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id);

    const created = await call("POST", "/api/catalog/effort-routes", {
      alias: "gemini-3.8-flash",
      defaultEffort: "medium",
      targets: FLASH_38.targets,
    });
    assert.equal(created.status, 200);
    const afterCreate = (await created.json()) as ModelCatalogResponse;
    assert.deepEqual(afterCreate.effortRoutes.map((route) => [route.alias, route.status]), [["gemini-3.8-flash", "live"]]);
    const ids = await listed();
    assert.ok(ids.includes("gemini-3.8-flash"));
    assert.ok(!ids.includes("gemini-3.8-flash-high"), "targets leave /v1/models once the route is live");

    const off = await call("POST", "/api/catalog/models/off", { models: [key("gemini-3.8-flash")] });
    assert.equal(off.status, 200);
    assert.deepEqual(((await off.json()) as ModelCatalogResponse).effortRoutes.map((route) => [route.enabled, route.status]), [[false, "off"]]);
    assert.ok(!(await listed()).includes("gemini-3.8-flash"), "an off route leaves /v1/models");

    const renamed = await call("PUT", "/api/catalog/effort-routes/gemini-3.8-flash", {
      alias: "flash",
      defaultEffort: "high",
      targets: { high: "gemini-3.8-flash-high" },
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(
      ((await renamed.json()) as ModelCatalogResponse).effortRoutes.map((route) => [route.alias, route.enabled, route.status]),
      [["flash", false, "off"]],
      "a rename keeps the route's switch",
    );
    assert.ok(!(await listed()).includes("flash"));
    assert.ok((await listed()).includes("gemini-3.8-flash-high"), "an off route does not hide its targets");

    const on = await call("POST", "/api/catalog/models/on", { models: [key("flash")] });
    assert.deepEqual(((await on.json()) as ModelCatalogResponse).effortRoutes.map((route) => [route.alias, route.status]), [["flash", "live"]]);
    assert.ok((await listed()).includes("flash"));

    const removed = await call("DELETE", "/api/catalog/effort-routes/flash");
    assert.equal(removed.status, 200);
    assert.deepEqual(((await removed.json()) as ModelCatalogResponse).effortRoutes, []);
    assert.ok((await listed()).includes("gemini-3.8-flash-high"));
  });

  it("answers refused changes with field errors, 404 and 405", async () => {
    const { call } = await start(makeSource({ effortRouting: { "gemini-3.8-flash": FLASH_38 } }));
    const refused = await call("POST", "/api/catalog/effort-routes", { alias: "gemini-3.8-flash", defaultEffort: "low", targets: { low: "nope" } });
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as { ok: false; error: string; fieldErrors: Record<string, string> };
    assert.equal(body.ok, false);
    assert.deepEqual(Object.keys(body.fieldErrors).sort(), ["alias", "targets.low"]);
    const unchanged = (await (await call("GET", "/api/catalog")).json()) as ModelCatalogResponse;
    assert.deepEqual(
      unchanged.effortRoutes.map((route) => [route.alias, route.defaultEffort, route.targets.map((target) => target.model)]),
      [["gemini-3.8-flash", "medium", Object.values(FLASH_38.targets)]],
      "a refused change leaves the routes as they were",
    );

    assert.equal((await call("PUT", "/api/catalog/effort-routes/missing", { defaultEffort: "low", targets: { low: "gemini-3-flash" } })).status, 404);
    assert.equal((await call("DELETE", "/api/catalog/effort-routes/missing")).status, 404);
    const wrong = await call("PATCH", "/api/catalog/effort-routes/gemini-3.8-flash");
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "PUT, DELETE");
  });

  it("requires admin auth", async () => {
    const { call } = await start(makeSource());
    const response = await call("POST", "/api/catalog/effort-routes", { alias: "x", defaultEffort: "low", targets: { low: "gemini-3-flash" } }, "");
    assert.equal(response.status, 401);
  });
});

describe("effort routing applies without a restart", () => {
  before(() => dbStore.initDb());
  after(() => dbStore.closeDb());

  const baseConfig = (): Config => ({
    accounts: [{ email: "effort-editor@example.test", credentials: [{ provider: "google-antigravity", refreshToken: "fake", projectId: "p" }] }],
    proxyPort: 0,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
  } as Config);

  it("applies effort routing from a replaced config", async () => {
    const rotator = new rotatorModule.AccountRotator(baseConfig());
    rotator.stopQuotaPolling();
    assert.equal(types.getEffortRoutingRule("gemini-3.8-flash"), undefined);
    await rotator.replaceConfig({ ...baseConfig(), effortRouting: { "gemini-3.8-flash": FLASH_38 } });
    assert.equal(types.getEffortRoutingRule("gemini-3.8-flash")?.targets.high, "gemini-3.8-flash-high");
    const request = compat.openAIToAntigravityBody({ model: "gemini-3.8-flash", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] });
    assert.equal(request.catalogModel, "gemini-3.8-flash-high");
    await rotator.replaceConfig(baseConfig());
    assert.equal(types.getEffortRoutingRule("gemini-3.8-flash"), undefined);
  });

  it("applies effortRouting from PUT /api/config to /v1/models and the next request", async () => {
    const rotator = new rotatorModule.AccountRotator(baseConfig());
    rotator.stopQuotaPolling();
    const account = (rotator as unknown as { accounts: AccountRuntime[] }).accounts[0];
    account.accessToken = "test-access-token";
    account.tokenExpires = Date.now() + 3_600_000;
    account.quota = [{
      modelKey: "gemini",
      displayName: "gemini",
      percentRemaining: 100,
      resetTime: new Date(Date.now() + 3_600_000).toISOString(),
      timerType: "5h",
      providerId: "google-antigravity",
    }];
    const google = registry.getProviderAdapter("google-antigravity");
    const forwarded: RequestBody[] = [];
    mock.method(google, "ensureValidToken", async () => {});
    mock.method(google, "forwardRequest", async (_account: AccountRuntime, body: RequestBody) => {
      forwarded.push(body);
      return {
        response: new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
        endpoint: "mock://google",
      };
    });
    adminAuth.setPersistedAdminToken("effort-admin-token");
    const server = proxy.startProxy(rotator, 0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const listed = async () =>
      ((await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id);
    const putConfig = (config: Config) =>
      fetch(`${base}/api/config`, {
        method: "PUT",
        headers: { authorization: "Bearer effort-admin-token", "content-type": "application/json" },
        body: JSON.stringify({ ...config, proxyPort: 51200 }),
      });
    try {
      assert.ok(!(await listed()).includes("gemini-3.8-flash"));
      assert.equal((await putConfig({ ...baseConfig(), effortRouting: { "gemini-3.8-flash": FLASH_38 } })).status, 200);
      const ids = await listed();
      assert.ok(ids.includes("gemini-3.8-flash"), "the alias is listed without a restart");
      assert.ok(!ids.includes("gemini-3.8-flash-high"), "its targets are hidden without a restart");

      const chat = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-skip-safety-jitter": "true" },
        body: JSON.stringify({ model: "gemini-3.8-flash", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(chat.status, 200, await chat.text());
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].model, "gemini-3.8-flash-high");
      assert.equal(forwarded[0].displayModel, "gemini-3.8-flash");

      assert.equal((await putConfig(baseConfig())).status, 200);
      assert.ok(!(await listed()).includes("gemini-3.8-flash"), "removing the rules applies at once too");
      assert.equal(types.getEffortRoutingRule("gemini-3.8-flash"), undefined);
    } finally {
      mock.restoreAll();
      adminAuth.setPersistedAdminToken(null);
      versionChecker.stopVersionChecker();
      notificationPoller.stopNotificationPoller();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rotator.flushPendingStateSave();
    }
  });

  it("saves and deletes routes from the Models page", async () => {
    const rotator = new rotatorModule.AccountRotator(baseConfig());
    rotator.stopQuotaPolling();
    const stored = () => (JSON.parse(readFileSync(join(fixtureDir, "accounts.json"), "utf8")) as Config).effortRouting;
    const saved = await rotator.saveEffortRoute(null, { alias: "gemini-3.8-flash", defaultEffort: "medium", targets: FLASH_38.targets });
    assert.ok(saved.ok, JSON.stringify(saved));
    assert.deepEqual(rotator.getConfig().effortRouting, { "gemini-3.8-flash": FLASH_38 });
    assert.deepEqual(stored(), { "gemini-3.8-flash": FLASH_38 });
    assert.equal(types.getEffortRoutingRule("gemini-3.8-flash")?.defaultEffort, "medium");

    const refused = await rotator.saveEffortRoute(null, { alias: "gemini-3.8-flash", defaultEffort: "low", targets: {} });
    assert.equal(refused.ok, false);
    assert.deepEqual(rotator.getConfig().effortRouting, { "gemini-3.8-flash": FLASH_38 }, "a refused change saves nothing");
    assert.deepEqual(stored(), { "gemini-3.8-flash": FLASH_38 });

    const deleted = await rotator.deleteEffortRoute("gemini-3.8-flash");
    assert.ok(deleted.ok);
    assert.equal(rotator.getConfig().effortRouting, undefined);
    assert.equal(types.getEffortRoutingRule("gemini-3.8-flash"), undefined);
  });
});
