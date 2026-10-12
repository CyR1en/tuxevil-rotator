import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { build, buildSync } from "esbuild";
import type { AccountsPatch, DashboardOverview, DashboardSnapshot } from "../src/dashboard-types.js";
import type { AccountConfig, PersistedState } from "../src/types.js";

const settingsDir = await mkdtemp(join(tmpdir(), "models-account-identity-"));
const isolatedEnv = {
  TUXEVIL_ROTATOR_DIR: settingsDir,
  TUXEVIL_ROTATOR_TELEMETRY: "off",
  PI_ROTATOR_TELEMETRY: "off",
  TUXEVIL_ROTATOR_DATABASE_URL: "",
  PI_ROTATOR_DATABASE_URL: "",
  DATABASE_URL: "",
};
const previousEnv = new Map(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);

const { initDb, closeDb, setCachedState } = await import("../src/db-store.js");
const { AccountRotator } = await import("../src/rotator.js");
const { getAccountIdentity } = await import("../src/account-identity.js");
const { serveCatalogApi } = await import("../src/dashboard.js");
const { DashboardLiveHub } = await import("../src/dashboard-live.js");
const { api, ApiError } = await import("../src/web/state/api.js");
const { summarizeProviders } = await import("../src/web/lib/models.js");
const nativeFetch = globalThis.fetch;

const EMAIL = "same@example.com";
const GOOGLE = "google-antigravity";
const OLLAMA = "ollama";
const ACCOUNTS: AccountConfig[] = ["project-a", "project-b"].map((projectId) => ({
  email: EMAIL,
  credentials: [
    { provider: GOOGLE, projectId, refreshToken: `fake-google-${projectId}` },
    { provider: OLLAMA, apiKey: `fake-ollama-${projectId}` },
  ],
}));

function makeRotator(accounts = ACCOUNTS): InstanceType<typeof AccountRotator> {
  const rotator = new AccountRotator({
    proxyPort: 51200,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    accounts: structuredClone(accounts),
  });
  rotator.stopQuotaPolling();
  return rotator;
}

interface BrowserState {
  overview: { value: DashboardOverview };
  applySnapshot(snapshot: DashboardSnapshot): void;
  startLive(): void;
  stopLive(): void;
}

function browserContext(): Record<string, unknown> {
  return {
    URL,
    URLSearchParams,
    window: { location: { pathname: "/dashboard/models/google-antigravity", search: "" }, addEventListener() {} },
    document: { documentElement: { removeAttribute() {}, setAttribute() {} } },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
  };
}

function browserStore(snapshot: DashboardSnapshot) {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const context: Record<string, unknown> = {
    ...browserContext(),
    EventSource: class {
      addEventListener(name: string, listener: (event: { data: string }) => void) {
        listeners.set(name, listener);
      }
      close() {}
    },
  };
  const bundle = buildSync({
    entryPoints: [new URL("../src/web/state/store.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "DashboardState",
  });
  runInNewContext(bundle.outputFiles[0].text, context);
  const store = context.DashboardState as BrowserState;
  store.applySnapshot(snapshot);
  store.startLive();
  return {
    store,
    apply: (patch: AccountsPatch) => listeners.get("accounts")!({ data: JSON.stringify(patch) }),
  };
}

interface ViewNode {
  type: unknown;
  key?: unknown;
  props: { children?: unknown; onChange?: (on: boolean) => Promise<void> };
}

function findView(node: unknown, predicate: (node: ViewNode) => boolean): ViewNode | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findView(child, predicate);
      if (found) return found;
    }
  } else if (node && typeof node === "object" && "props" in node) {
    const view = node as ViewNode;
    return predicate(view) ? view : findView(view.props.children, predicate);
  }
}

async function providerDrawerSwitches(snapshot: DashboardSnapshot, base: string) {
  const state = await (await nativeFetch(`${base}/api/catalog`)).json();
  const context = {
    ...browserContext(),
    fetch: (path: string, init?: RequestInit) => nativeFetch(new URL(path, base), init),
  };
  const bundle = await build({
    entryPoints: [new URL("../src/web/pages/Models.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "DashboardModels",
    plugins: [{
      name: "expose-provider-drawer",
      setup(build) {
        build.onLoad({ filter: /[/\\]Models\.tsx$/ }, ({ path }) => ({
          contents: `${readFileSync(path, "utf8")}\nexport { ProviderDetail };\nexport { applySnapshot } from '../state/store.js';`,
          loader: "tsx",
        }));
      },
    }],
  });
  runInNewContext(bundle.outputFiles[0].text, context);
  const browser = (context as Record<string, unknown>).DashboardModels as {
    applySnapshot(snapshot: DashboardSnapshot): void;
    ProviderDetail(props: unknown): unknown;
  };
  browser.applySnapshot(snapshot);
  const summary = summarizeProviders(state, snapshot.overview, Date.now()).find((entry) => entry.provider.id === GOOGLE);
  const view = browser.ProviderDetail({ summary, state, onClose() {} });
  return (id: string, on: boolean) => {
    const row = findView(view, (node) => node.type === "tr" && node.key === id);
    assert.ok(row, "each provider account row has its exact identity as its key");
    const control = findView(row, (node) => typeof node.props.onChange === "function");
    assert.ok(control?.props.onChange, "the account row has a provider switch");
    return control.props.onChange(on);
  };
}

describe("Models account provider identity", () => {
  let server: Server | undefined;
  let hub: InstanceType<typeof DashboardLiveHub> | undefined;
  let base = "";

  async function start(rotator: InstanceType<typeof AccountRotator>): Promise<void> {
    hub = new DashboardLiveHub({
      getStatus: () => rotator.getStatus(),
      capabilities: () => ({ database: false }),
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url!, "http://localhost").pathname;
      if (pathname === "/api/dashboard/snapshot") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(hub!.snapshot()));
      } else {
        void serveCatalogApi(req, res, rotator, req.method!, pathname);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  before(initDb);
  beforeEach(() => setCachedState({ modelAccounts: {}, accounts: {} }));
  afterEach(async () => {
    hub?.close();
    hub = undefined;
    if (server) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => closing.close((err) => err ? reject(err) : resolve()));
    }
  });
  after(async () => {
    await closeDb();
    await rm(settingsDir, { recursive: true, force: true });
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("rejects an ambiguous legacy email without turning off the first project", async () => {
    const rotator = makeRotator();
    await start(rotator);
    const response = await nativeFetch(`${base}/api/catalog/accounts/${encodeURIComponent(EMAIL)}/${GOOGLE}/off`, { method: "POST" });
    assert.equal(response.status, 404, "duplicate emails must not select the first account");
    assert.deepEqual(rotator.getStatus().accounts.map((account) => account.disabledProviders), [undefined, undefined]);
  });

  it("uses the dashboard identity through the client and HTTP route, then restores each project after reordering", async (t) => {
    const rotator = makeRotator();
    await start(rotator);
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
      nativeFetch(typeof input === "string" ? new URL(input, base) : input, init));
    const snapshot = await api.snapshot();
    const [a, b] = snapshot.overview.accounts;
    assert.equal(a.id, getAccountIdentity(ACCOUNTS[0]));
    assert.equal(b.id, getAccountIdentity(ACCOUNTS[1]));
    assert.notEqual(a.id, b.id);

    const switchProvider = await providerDrawerSwitches(snapshot, base);
    await switchProvider(b.id!, false);
    await api.setAccountProviderEnabled(a.id!, OLLAMA, false);
    assert.deepEqual(rotator.getStatus().accounts.map((account) => account.disabledProviders), [[OLLAMA], [GOOGLE]]);
    const persisted = JSON.parse(await readFile(join(settingsDir, "state.json"), "utf8")) as PersistedState;
    assert.deepEqual(persisted.disabledProvidersByAccount, { [a.id!]: [OLLAMA], [b.id!]: [GOOGLE] });

    await closeDb();
    await initDb();
    const restarted = makeRotator([...ACCOUNTS].reverse());
    assert.deepEqual(restarted.getStatus().accounts.map((account) => [account.id, account.disabledProviders]), [
      [b.id, [GOOGLE]], [a.id, [OLLAMA]],
    ]);
    assert.equal(await restarted.setAccountProviderEnabled(b.id!, GOOGLE, true), true);
    await closeDb();
    await initDb();
    assert.deepEqual(makeRotator().getStatus().accounts.map((account) => account.disabledProviders), [[OLLAMA], undefined]);
  });

  it("keeps both same-email rows when a real live patch reaches the browser store", async () => {
    const rotator = makeRotator();
    await start(rotator);
    const snapshot = hub!.snapshot();
    const browser = browserStore(snapshot);
    const [a, b] = snapshot.overview.accounts;
    assert.equal(await rotator.setAccountProviderEnabled(getAccountIdentity(ACCOUNTS[1]), GOOGLE, false), true);
    const message = hub!.collect().find((entry) => entry.type === "accounts");
    assert.ok(message?.type === "accounts");
    assert.deepEqual(message.data.upsert.map((account) => account.id), [b.id]);
    browser.apply(message.data);
    assert.deepEqual(Array.from(browser.store.overview.value.accounts, (account) => [account.id, account.disabledProviders && Array.from(account.disabledProviders)]), [
      [a.id, undefined], [b.id, [GOOGLE]],
    ]);

    const nextStatus = rotator.getStatus();
    const reordered = new DashboardLiveHub({ getStatus: () => nextStatus, capabilities: () => ({ database: false }) });
    reordered.collect();
    nextStatus.accounts = [nextStatus.accounts[1]];
    const removal = reordered.collect().find((entry) => entry.type === "accounts");
    assert.ok(removal?.type === "accounts");
    assert.deepEqual(removal.data.remove, [a.id]);
    assert.deepEqual(removal.data.order, [b.id]);
    browser.apply(removal.data);
    assert.deepEqual(Array.from(browser.store.overview.value.accounts, (account) => account.id), [b.id]);
    browser.store.stopLive();
    reordered.close();
  });

  it("preserves unique-email callers and their legacy persisted switches, but rejects ambiguous legacy switches", async () => {
    const saved = { totalRequests: 0, quotaExhaustedAt: 0, disabled: false, flagged: false, disabledProviders: [GOOGLE] };
    await setCachedState({ modelAccounts: {}, accounts: { [EMAIL]: saved } });
    assert.deepEqual(makeRotator().getStatus().accounts.map((account) => account.disabledProviders), [undefined, undefined]);
    const unique = makeRotator([ACCOUNTS[0]]);
    assert.deepEqual(unique.getStatus().accounts[0].disabledProviders, [GOOGLE]);
    assert.equal(await unique.setAccountProviderEnabled(EMAIL, GOOGLE, true), true);
    assert.equal(await unique.setAccountProviderEnabled(EMAIL, GOOGLE, false), true);
    assert.deepEqual(makeRotator([ACCOUNTS[0]]).getStatus().accounts[0].disabledProviders, [GOOGLE]);
    assert.equal(await unique.setAccountProviderEnabled(EMAIL, "openai-codex", false), false);
  });

  it("does not transfer a switch when a fallback credential or the composite account identity changes", async () => {
    const account: AccountConfig = { email: EMAIL, credentials: [{ provider: OLLAMA, apiKey: "fake-original-key" }] };
    const id = getAccountIdentity(account);
    assert.equal(await makeRotator([account]).setAccountProviderEnabled(id, OLLAMA, false), true);
    const replacement: AccountConfig = { email: EMAIL, credentials: [{ provider: OLLAMA, apiKey: "fake-replacement-key" }] };
    const addedProvider: AccountConfig = { ...structuredClone(account), credentials: [
      ...account.credentials!, { provider: GOOGLE, projectId: "project-new", refreshToken: "fake-new-google" },
    ] };
    for (const changed of [replacement, addedProvider]) {
      assert.notEqual(getAccountIdentity(changed), id);
      const restarted = makeRotator([changed]);
      assert.equal(restarted.getStatus().accounts[0].disabledProviders, undefined);
      assert.equal(await restarted.setAccountProviderEnabled(id, OLLAMA, false), false);
    }
  });

  it("retains a project switch after refreshing its token and distinguishes provider account IDs", async () => {
    const first = ACCOUNTS[0];
    assert.equal(await makeRotator([first]).setAccountProviderEnabled(getAccountIdentity(first), GOOGLE, false), true);
    const refreshed = structuredClone(first);
    refreshed.credentials![0].refreshToken = "fake-refreshed-google";
    assert.equal(getAccountIdentity(refreshed), getAccountIdentity(first));
    assert.deepEqual(makeRotator([refreshed]).getStatus().accounts[0].disabledProviders, [GOOGLE]);

    const codexAccounts: AccountConfig[] = ["workspace-a", "workspace-b"].map((providerAccountId) => ({
      email: EMAIL,
      credentials: [{ provider: "openai-codex", providerAccountId, refreshToken: "fake-codex-token" }],
    }));
    const rotator = makeRotator(codexAccounts);
    assert.equal(await rotator.setAccountProviderEnabled(getAccountIdentity(codexAccounts[1]), "openai-codex", false), true);
    assert.deepEqual(makeRotator([...codexAccounts].reverse()).getStatus().accounts.map((account) => account.disabledProviders), [["openai-codex"], undefined]);
  });

  it("keeps a switch on its uniquely matched project when a live config edit adds a provider", async () => {
    const rotator = makeRotator();
    const oldId = getAccountIdentity(ACCOUNTS[1]);
    assert.equal(await rotator.setAccountProviderEnabled(oldId, GOOGLE, false), true);
    const config = rotator.getConfig();
    config.accounts[1].credentials!.push({ provider: "opencode-zen", apiKey: "fake-added-zen" });
    config.accounts.reverse();
    await rotator.replaceConfig(config);
    const [changed, unchanged] = rotator.getStatus().accounts;
    assert.notEqual(changed.id, oldId);
    assert.equal(unchanged.id, getAccountIdentity(ACCOUNTS[0]));
    assert.deepEqual(changed.disabledProviders, [GOOGLE]);
    assert.equal(unchanged.disabledProviders, undefined);
    assert.equal(await rotator.setAccountProviderEnabled(oldId, GOOGLE, false), false);
    assert.deepEqual(makeRotator(config.accounts).getStatus().accounts.map((account) => account.disabledProviders), [[GOOGLE], undefined]);
  });

  it("returns an API error for a stale identity without changing another same-email account", async (t) => {
    const rotator = makeRotator();
    await start(rotator);
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
      nativeFetch(typeof input === "string" ? new URL(input, base) : input, init));
    const missing: AccountConfig = { ...structuredClone(ACCOUNTS[1]), credentials: [
      { provider: GOOGLE, projectId: "removed-project", refreshToken: "fake-removed-token" },
    ] };
    await assert.rejects(api.setAccountProviderEnabled(getAccountIdentity(missing), GOOGLE, false), (error) =>
      error instanceof ApiError && error.status === 404);
    assert.deepEqual(rotator.getStatus().accounts.map((account) => account.disabledProviders), [undefined, undefined]);
  });
});
