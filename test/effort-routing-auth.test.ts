import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it, mock } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresSettingsRepository } from "../src/settings-repository.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

const testDir = mkdtempSync(join(tmpdir(), "restored-auth-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://effort-routing.test/rotator";

const virtualKeyRows = new Map<string, QueryResultRow>();

function queryResult<R extends QueryResultRow>(rows: R[], command = "SELECT"): QueryResult<R> {
	return { rows, command, rowCount: rows.length, oid: 0, fields: [] };
}

mock.method(PostgresSettingsRepository.prototype, "init", async () => {});
mock.method(
	PostgresSettingsRepository.prototype,
	"query",
	async <R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
		if (text.includes("COUNT(*)")) {
			return queryResult([{ count: String(virtualKeyRows.size) }] as unknown as R[]);
		}
		if (text.includes("SELECT * FROM rotator_virtual_keys")) {
			const row = virtualKeyRows.get(String(params?.[0]));
			return queryResult((row ? [row] : []) as R[]);
		}
		return queryResult<R>([], text.trimStart().startsWith("UPDATE") ? "UPDATE" : "SELECT");
	},
);

const [dbStore, proxyModule, typesModule, spendLogger, virtualKeys, versionChecker, notificationPoller] =
	await Promise.all([
		import("../src/db-store.js"),
		import("../src/proxy.js"),
		import("../src/types.js"),
		import("../src/spend-logger.js"),
		import("../src/virtual-keys.js"),
		import("../src/version-check.js"),
		import("../src/notification-poller.js"),
	]);

await dbStore.initDb();

const endpoints = typesModule.ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpoints];

function addVirtualKey(rawKey: string, models: string[]): void {
	const tokenHash = virtualKeys.hashKey(rawKey);
	virtualKeyRows.set(tokenHash, {
		token_hash: tokenHash,
		key_name: `${rawKey.slice(0, 6)}...`,
		key_alias: rawKey,
		user_id: null,
		models,
		metadata: {},
		blocked: false,
		last_active: null,
		created_at: "2026-09-04T00:00:00.000Z",
		created_by: "test",
	});
}

async function listenServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Server did not bind to a TCP port");
	}
	return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function createAccount(): AccountRuntime {
	return {
		config: {
			email: "effort-auth@example.com",
			projectId: "effort-auth-project",
			refreshToken: "refresh-token",
			label: "effort-auth-account",
		},
		accessToken: "access-token",
		tokenExpires: Date.now() + 60_000,
		requestsSinceRotation: 0,
		totalRequests: 0,
		cooldownsByModel: {},
		quotaExhaustedAt: 0,
		quota: [],
		lastQuotaPoll: 0,
		lastUsed: 0,
		lastError: null,
		consecutiveErrors: 0,
		disabled: false,
		flagged: false,
		inFlightRequests: 0,
		inFlightByModel: {},
		allowFreshWindowStartsOverride: false,
		dailyRequestCount: 0,
		dailyRequestDay: "2026-09-04",
		healthScore: 1,
		tokenBucket: { tokens: 50, lastRefillAt: Date.now() },
	};
}

function createRotator(): AccountRotator {
	const account = createAccount();
	return {
		getActiveAccount: async () => account,
		getRetryAfterMs: () => 0,
		rotateToNext: async () => null,
		finishRequest: () => {},
		getSafetyJitterMs: () => 0,
		recordUpstreamAttempt: () => {},
		markExhausted: () => {},
		recordProvider429: () => {},
		getFlagContext: () => ({
			timerType: "fresh",
			accountQuotaPercent: 0,
			wasProAccount: false,
			accountRequestsLastHour: 0,
			poolSize: 1,
			poolHealthyCount: 1,
			uptimeSeconds: 0,
		}),
		markFlagged: () => {},
		markError: () => {},
		recordRequest: () => false,
		recordProxyEvent: () => {},
		getGlobalDelayMs: () => 0,
		recordLatency: () => {},
		recordRequestLog: () => {},
		recordTokenUsage: () => {},
		resolveQuotaModelKeyForDisplay: (model: string) => model,
		resolveObservedModelKey: (model: string) => model,
		saveState: () => {},
		getStatus: () => ({ accounts: [] }),
		getOllamaModels: () => [],
		getCodexModels: () => [],
	} as unknown as AccountRotator;
}

after(async () => {
	typesModule.setEffortRoutingOverride(null);
	spendLogger.resetSpendLoggerForTests();
	virtualKeys.clearVirtualKeyCache();
	versionChecker.stopVersionChecker();
	notificationPoller.stopNotificationPoller();
	endpoints.splice(0, endpoints.length, ...originalEndpoints);
	await dbStore.closeDb();
	rmSync(testDir, { recursive: true, force: true });
	if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = originalDatabaseUrl;
	mock.restoreAll();
});

describe("effort routing virtual-key endpoint boundary", () => {
	it("authorizes a bare-scoped key across efforts, rejects a concrete-scoped alias, and logs concrete spend", async () => {
		setAntigravityModelsForTest([
			"gemini-3.8-flash-low",
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-high",
		]);
		const bareKey = "rk-bare-effort-routing-key";
		const concreteKey = "rk-concrete-effort-routing-key";
		addVirtualKey(bareKey, ["gemini-3.8-flash"]);
		addVirtualKey(concreteKey, ["gemini-3.8-flash-high"]);
		virtualKeys.clearVirtualKeyCache();
		spendLogger.resetSpendLoggerForTests();
		typesModule.setEffortRoutingOverride({
			"gemini-3.8-flash": {
				defaultEffort: "medium",
				targets: {
					low: "gemini-3.8-flash-low",
					medium: "gemini-3.8-flash-medium",
					high: "gemini-3.8-flash-high",
				},
			},
		});

		const upstreamModels: string[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				upstreamModels.push(String(JSON.parse(body).model));
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(
					'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}\n',
				);
			});
		});
		endpoints.splice(0, endpoints.length, upstream.url);

		const server = proxyModule.startProxy(createRotator(), 0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as AddressInfo).port;
		const request = async (rawKey: string, effort: string): Promise<Response> =>
			fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${rawKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "gemini-3.8-flash",
					reasoning_effort: effort,
					messages: [{ role: "user", content: "ping" }],
				}),
			});

		try {
			for (const effort of ["low", "high"]) {
				const response = await request(bareKey, effort);
				assert.equal(response.status, 200, `${effort} effort was rejected`);
				await response.arrayBuffer();
			}

			const denied = await request(concreteKey, "high");
			assert.equal(denied.status, 403);
			assert.match(await denied.text(), /not allowed for this Virtual Key/);

			assert.deepEqual(upstreamModels, [
				"gemini-3.8-flash-low",
				"gemini-3.8-flash-high",
			]);
			assert.deepEqual(
				spendLogger.getSpendQueueItemsForTests().map((entry) => entry.model),
				["gemini-3.8-flash-low", "gemini-3.8-flash-high"],
			);
		} finally {
			server.closeAllConnections?.();
			await closeServer(server);
			await closeServer(upstream.server);
		}
	});
});

it("routes restored disjoint snapshots through HTTP JSON/SSE and alias scopes", async () => {
  const { AccountRotator: RealRotator } = await import("../src/rotator.js");
  const { dynamicCatalog } = await import("../src/providers/google-antigravity/dynamic-catalog.js");
  const { getAccountIdentity } = await import("../src/account-identity.js");
  const { getProviderAdapter } = await import("../src/providers/registry.js");
  const config = {
    proxyPort: 0, requestsPerRotation: 100, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300000,
    accounts: ["a", "b"].map((id) => ({ email: `${id}@restore.test`, credentials: [
      { provider: "google-antigravity", refreshToken: `fake-${id}`, projectId: `project-${id}` },
    ] })),
  };
  dynamicCatalog.reset();
  const writer = new RealRotator(config);
  writer.stopQuotaPolling();
  const accounts = (writer as unknown as { accounts: AccountRuntime[] }).accounts;
  const identities = accounts.map((account) => ({ id: getAccountIdentity(account) }));
  dynamicCatalog.updateFromEndpointResponse({ models: { "arbitrary-restored-high": {} } }, identities[0].id);
  dynamicCatalog.updateFromEndpointResponse({ models: { "other-restored-high": {} } }, identities[1].id);
  await writer.saveState();
  dynamicCatalog.reset();
  const rotator = new RealRotator(config);
  rotator.stopQuotaPolling();
  const restoredAccounts = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
  restoredAccounts.forEach((account, i) => { account.accessToken = `token-${i}`; account.tokenExpires = Date.now() + 3600000; });
  const provider = getProviderAdapter("google-antigravity");
  const tokenMock = mock.method(provider, "ensureValidToken", async () => {});
  const captures: Array<{ model: unknown; project: unknown; token: string | null }> = [];
  const forwardMock = mock.method(provider, "forwardRequest", async (account: AccountRuntime, body: Record<string, unknown>) => {
    captures.push({ model: body.model, project: account.config.credentials?.[0].projectId, token: account.accessToken });
    return { endpoint: "mock://restored", response: new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"restored"}]},"finishReason":"STOP"}]}}\n\n', { headers: { "content-type": "text/event-stream" } }) };
  });
  typesModule.setEffortRoutingOverride({ "restore-alias": { defaultEffort: "high", targets: { high: "arbitrary-restored-high" } } });
  addVirtualKey("rk-restored-allowed", ["restore-alias", "arbitrary-restored-high"]);
  addVirtualKey("rk-restored-denied", ["other-restored-high"]);
  virtualKeys.clearVirtualKeyCache();
  const server = proxyModule.startProxy(rotator, 0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  let requestSequence = 0;
  const request = (model: string, stream: boolean, key = "rk-restored-allowed") => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: `ping ${++requestSequence}` }] }),
  });
  try {
    for (const model of ["arbitrary-restored-high", "restore-alias"]) {
      for (const stream of [false, true]) {
        const response = await request(model, stream);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /restored/);
      }
    }
    assert.deepEqual(captures, Array.from({ length: 4 }, () => ({ model: "arbitrary-restored-high", project: "project-a", token: "token-0" })));
    const denied = await request("restore-alias", false, "rk-restored-denied");
    assert.equal(denied.status, 403);
    await denied.text();
    dynamicCatalog.updateFromEndpointResponse({ models: {} }, identities[0].id);
    const withdrawn = await request("arbitrary-restored-high", false);
    assert.notEqual(withdrawn.status, 200);
    await withdrawn.text();
    assert.equal(captures.length, 4);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
    tokenMock.mock.restore();
    forwardMock.mock.restore();
    typesModule.setEffortRoutingOverride(null);
    dynamicCatalog.reset();
  }
});
