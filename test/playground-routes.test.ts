import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from "node:test";
import pg from "pg";

const dir = mkdtempSync(join(tmpdir(), "playground-routes-"));
process.env.TUXEVIL_ROTATOR_DIR = dir;
process.env.PI_ROTATOR_DIR = dir;
process.env.TUXEVIL_ROTATOR_DATABASE_URL =
  "postgres://mock@127.0.0.1/playground";
process.env.TUXEVIL_ROTATOR_ADMIN_TOKEN = "";
process.env.PI_ROTATOR_ADMIN_TOKEN = "";
process.env.TUXEVIL_ROTATOR_TELEMETRY = "off";
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
let startProxy: typeof import("../src/proxy.js").startProxy;
let admin: typeof import("../src/admin-auth.js");
let keys: typeof import("../src/virtual-keys.js");
let db: typeof import("../src/db-store.js");
let stopVersionChecker: () => void;
let stopNotificationPoller: () => void;
let server: Server;
let base: string;
let cookie: string;
let liveRotator: import("../src/rotator.js").AccountRotator | null = null;
let blocked = false;
let scopes = ["gemini-3.8-flash-high"];
const rawKey = "rk-test123456789012345678901234567890";

before(async () => {
  // A simulated PostgreSQL pool enforces real key-auth paths without network I/O.
  mock.method(
    pg.Pool.prototype,
    "query",
    async (sql: string, params?: unknown[]) => {
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
      if (
        sql.includes("SELECT") &&
        sql.includes("rotator_virtual_keys") &&
        params?.[0] === keys.hashKey(rawKey)
      )
        return {
          rows: [
            {
              token_hash: keys.hashKey(rawKey),
              key_name: "test",
              key_alias: "test",
              models: scopes,
              blocked,
              created_at: new Date().toISOString(),
            },
          ],
        };
      return { rows: [] };
    },
  );
  const { setAntigravityModelsForTest } =
    await import("./fixtures/antigravity-catalog.js");
  setAntigravityModelsForTest(["gemini-3.8-flash-high"]);
  db = await import("../src/db-store.js");
  await db.initDb();
  admin = await import("../src/admin-auth.js");
  keys = await import("../src/virtual-keys.js");
  ({ startProxy } = await import("../src/proxy.js"));
  ({ stopVersionChecker } = await import("../src/version-check.js"));
  ({ stopNotificationPoller } = await import("../src/notification-poller.js"));
});
beforeEach(async () => {
  blocked = false;
  scopes = ["gemini-3.8-flash-high"];
  keys.clearVirtualKeyCache();
  admin.setPersistedAdminToken("secret");
  cookie = `${admin.DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(admin.createDashboardSession("secret").value)}`;
  const rotator = {
    saveState() {},
    getStatus() {
      return { accounts: [] };
    },
    recordProxyEvent() {},
    getActiveAccount() {
      return null;
    },
    getConfig() {
      return { disabledProviders: ["google-antigravity"] };
    },
  };
  server = startProxy(rotator as never, 0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stopVersionChecker();
  stopNotificationPoller();
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (liveRotator) {
    liveRotator.stopQuotaPolling();
    await liveRotator.flushPendingStateSave();
    liveRotator = null;
  }
  admin.setPersistedAdminToken(null);
});
after(async () => {
  await db.closeDb();
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
});
function post(
  path: string,
  headers: Record<string, string> = {},
  body: unknown = {
    model: "gemini-3.8-flash-high",
    messages: [{ role: "user", content: "hello" }],
  },
) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const route = "/api/playground/chat/completions";
describe("dashboard playground authorization", () => {
  it("rejects anonymous requests and virtual keys on the admin route", async () => {
    assert.equal((await post(route, { origin: base })).status, 401);
    assert.equal(
      (await post(route, { origin: base, authorization: `Bearer ${rawKey}` }))
        .status,
      401,
    );
  });
  it("requires same-origin even with a valid admin token", async () => {
    assert.equal(
      (await post(route, { cookie, origin: "https://other.example" })).status,
      403,
    );
    assert.equal(
      (await post(route, { "x-rotator-admin-token": "secret" })).status,
      403,
    );
  });
  it("accepts an admin session without a virtual key and keeps model-off checks", async () => {
    const response = await post(route, { cookie, origin: base });
    assert.equal(response.status, 404);
    assert.match(JSON.stringify(await response.json()), /turned off/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const invalid = await post(
      route,
      { cookie, origin: base },
      { model: "", messages: null },
    );
    assert.equal(invalid.status, 400);
  });
  it("keeps public inference key enforcement, blocked keys and scopes intact", async () => {
    const path = "/v1/chat/completions";
    assert.equal((await post(path, { cookie, origin: base })).status, 401);
    const denied = {
      model: "denied-model",
      messages: [{ role: "user", content: "hello" }],
      dashboardAdmin: true,
    };
    assert.equal(
      (
        await post(
          path,
          { cookie, origin: base, authorization: `Bearer ${rawKey}` },
          denied,
        )
      ).status,
      403,
    );
    blocked = true;
    keys.clearVirtualKeyCache();
    assert.equal(
      (await post(path, { authorization: `Bearer ${rawKey}` })).status,
      403,
    );
    blocked = false;
    keys.clearVirtualKeyCache();
    assert.equal(
      (await post(path, { authorization: `Bearer ${rawKey}` })).status,
      404,
    );
  });
  it("protects the request-size configuration endpoint", async () => {
    assert.equal((await fetch(base + "/api/playground/config")).status, 401);
    const response = await fetch(base + "/api/playground/config", {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { maxBodyBytes: 25 * 1024 * 1024 });
  });
});

async function enableLiveRotator() {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { AccountRotator } = await import("../src/rotator.js");
  const { getProviderAdapter } = await import("../src/providers/registry.js");
  const { setAntigravityModelsForTest } =
    await import("./fixtures/antigravity-catalog.js");
  const { getAccountIdentity } = await import("../src/account-identity.js");
  const rotator = new AccountRotator({
    proxyPort: 0,
    requestsPerRotation: 100,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    maxConcurrentRequestsPerAccount: 3,
    idempotencyEnabled: true,
    idempotencyWindowMs: 60_000,
    accounts: [
      {
        email: "playground@example.com",
        credentials: [
          {
            provider: "google-antigravity",
            refreshToken: "test-refresh",
            projectId: "test-project",
          },
        ],
      },
    ],
  });
  liveRotator = rotator;
  rotator.stopQuotaPolling();
  const accounts = (
    rotator as unknown as {
      accounts: import("../src/types.js").AccountRuntime[];
    }
  ).accounts;
  setAntigravityModelsForTest(
    ["gemini-3.8-flash-high"],
    accounts.map(getAccountIdentity),
  );
  for (const account of accounts) {
    account.accessToken = "test-access";
    account.tokenExpires = Date.now() + 3_600_000;
    account.quota = [
      {
        modelKey: "gemini",
        displayName: "Gemini",
        percentRemaining: 100,
        resetTime: new Date(Date.now() + 3_600_000).toISOString(),
        timerType: "5h",
        providerId: "google-antigravity",
      },
    ];
  }
  const adapter = getProviderAdapter("google-antigravity");
  const ensureMock = mock.method(adapter, "ensureValidToken", async () => {});
  server = startProxy(rotator, 0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stopVersionChecker();
  stopNotificationPoller();
  return { adapter, accounts, ensureMock };
}

it("routes admin JSON and SSE requests through real rotation without deduplication", async () => {
  const { adapter, accounts, ensureMock } = await enableLiveRotator();
  let forwarded = 0;
  const forwardMock = mock.method(adapter, "forwardRequest", async () => {
    forwarded++;
    return {
      response: new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
      endpoint: "mock://playground",
    };
  });
  try {
    const headers = { cookie, origin: base, "x-skip-safety-jitter": "true" };
    for (let i = 0; i < 2; i++) {
      const response = await post(route, headers);
      assert.equal(response.status, 200);
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      assert.equal(data.choices[0].message.content, "hello");
    }
    assert.equal(
      forwarded,
      2,
      "separate playground tests must reach upstream even with idempotency enabled",
    );
    const response = await post(route, headers, {
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /hello/);
    assert.match(stream, /\[DONE\]/);
    for (const account of accounts) assert.equal(account.inFlightRequests, 0);
  } finally {
    forwardMock.mock.restore();
    ensureMock.mock.restore();
  }
});

it("releases reserved capacity when the browser cancels an inference", async () => {
  const { adapter, accounts, ensureMock } = await enableLiveRotator();
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let upstreamAborted = false;
  const forwardMock = mock.method(
    adapter,
    "forwardRequest",
    async (
      _account: unknown,
      _body: unknown,
      _headers: unknown,
      signal?: AbortSignal,
    ) => {
      reached();
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          upstreamAborted = true;
          reject(new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  );
  try {
    const controller = new AbortController();
    const response = fetch(base + route, {
      method: "POST",
      signal: controller.signal,
      headers: {
        cookie,
        origin: base,
        "content-type": "application/json",
        "x-skip-safety-jitter": "true",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const rejection = assert.rejects(response, /abort/i);
    await started;
    assert.ok(accounts.some((a) => a.inFlightRequests > 0));
    controller.abort();
    await rejection;
    for (let i = 0; i < 100 && !upstreamAborted; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(upstreamAborted, true);
    for (
      let i = 0;
      i < 100 && accounts.some((a) => a.inFlightRequests > 0);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    for (const account of accounts) assert.equal(account.inFlightRequests, 0);
  } finally {
    forwardMock.mock.restore();
    ensureMock.mock.restore();
  }
});

function postAudio(
  path: string,
  headers: Record<string, string> = {},
  model = "gemini-3.8-flash-high",
) {
  const form = new FormData();
  form.set(
    "file",
    new File(["RIFFtest audio bytes"], "audio.wav", { type: "audio/wav" }),
  );
  form.set("model", model);
  form.set("language", "es");
  return fetch(base + path, { method: "POST", headers, body: form });
}
const audioRoute = "/api/playground/audio/transcriptions";
it("protects dashboard audio inference without weakening public audio key scopes", async () => {
  assert.equal((await postAudio(audioRoute, { origin: base })).status, 401);
  assert.equal(
    (
      await postAudio(audioRoute, {
        origin: base,
        authorization: `Bearer ${rawKey}`,
      })
    ).status,
    401,
  );
  assert.equal(
    (await postAudio(audioRoute, { cookie, origin: "https://other.example" }))
      .status,
    403,
  );
  assert.equal(
    (await postAudio(audioRoute, { "x-rotator-admin-token": "secret" })).status,
    403,
  );
  const allowed = await postAudio(audioRoute, { cookie, origin: base });
  assert.equal(allowed.status, 404);
  assert.match(JSON.stringify(await allowed.json()), /turned off/);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  const invalid = await post(audioRoute, { cookie, origin: base });
  assert.equal(invalid.status, 400);
  const publicRoute = "/v1/audio/transcriptions";
  assert.equal(
    (await postAudio(publicRoute, { cookie, origin: base })).status,
    401,
  );
  assert.equal(
    (
      await postAudio(
        publicRoute,
        { authorization: `Bearer ${rawKey}` },
        "gemini-3.1-pro-high",
      )
    ).status,
    403,
  );
  blocked = true;
  keys.clearVirtualKeyCache();
  assert.equal(
    (await postAudio(publicRoute, { authorization: `Bearer ${rawKey}` }))
      .status,
    403,
  );
});
it("transcribes uploaded audio via rotation with admin authorization and releases capacity", async () => {
  const { adapter, accounts, ensureMock } = await enableLiveRotator();
  let captured: unknown;
  const forwardMock = mock.method(
    adapter,
    "forwardRequest",
    async (_account: unknown, body: import("../src/proxy.js").RequestBody) => {
      captured = body.request;
      return {
        response: new Response(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hola mundo"}]},"finishReason":"STOP"}]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
        endpoint: "mock://audio",
      };
    },
  );
  try {
    const response = await postAudio(audioRoute, {
      cookie,
      origin: base,
      "x-skip-safety-jitter": "true",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Hola mundo" });
    assert.match(JSON.stringify(captured), /inlineData/);
    assert.match(JSON.stringify(captured), /audio\/wav/);
    for (const account of accounts) assert.equal(account.inFlightRequests, 0);
  } finally {
    forwardMock.mock.restore();
    ensureMock.mock.restore();
  }
});
