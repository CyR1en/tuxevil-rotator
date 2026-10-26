import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startProxy } from "../src/proxy.js";
import { OLLAMA_CHAT_ENDPOINTS } from "../src/types.js";
import type { AccountRuntime, AccountConfig } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

const tmpDir = mkdtempSync(join(tmpdir(), "ollama-native-"));

process.env.TUXEVIL_ROTATOR_DIR = tmpDir;
process.env.OLLAMA_CHAT_ENDPOINTS = undefined;

const originalFetch = globalThis.fetch;
let capturedUrl = "";
let capturedBody = "";

function stubUpstream(): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url !== OLLAMA_CHAT_ENDPOINTS[0]) {
			return originalFetch(input, init);
		}
		capturedUrl = url;
		capturedBody = String(init?.body ?? "");
		return new Response(
			'{"model":"kimi-k3","message":{"role":"assistant","content":"ok"},"done":true,"done_reason":"stop"}\n',
			{ status: 200, headers: { "content-type": "application/x-ndjson" } },
		);
	}) as typeof fetch;
}

function createAccount(overrides: Partial<AccountConfig> = {}): AccountRuntime {
	return {
		config: {
			email: "ollama@example.com",
			label: "ollama-account",
			provider: "ollama",
			apiKey: "ollama-key-test",
			...overrides,
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
		dailyRequestDay: "2026-05-16",
		healthScore: 1,
		tokenBucket: {
			tokens: 50,
			lastRefillAt: Date.now(),
		},
	};
}

function createRotatorStub(): AccountRotator {
	const account = createAccount();
	return {
		getActiveAccount: async () => account,
		getOllamaModels: () => ["kimi-k3"],
		resolveQuotaModelKeyForDisplay: () => "kimi-k3",
		getRetryAfterMs: () => 0,
		rotateToNext: async () => null,
		getSafetyJitterMs: () => 0,
		recordUpstreamAttempt: () => {},
		markExhausted: () => {},
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
		finishRequest: () => {},
		saveState: () => {},
		getStatus: () => ({ accounts: [] }),
	} as unknown as AccountRotator;
}

describe("native /api/chat route (ollama payload + content normalization)", () => {
	let server: Server | null = null;

	before(async () => {
		stubUpstream();
		server = startProxy(createRotatorStub(), 0, "127.0.0.1");
		await once(server, "listening");
	});

	after(async () => {
		globalThis.fetch = originalFetch;
		if (server) await new Promise((r) => server?.close(r));
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("parses the native payload and flattens content arrays before forwarding", async () => {
		const port = (server!.address() as AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "kimi-k3",
				stream: true,
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello" }] },
					{
						role: "user",
						content: [
							{ type: "text", text: "see this" },
							{
								type: "image_url",
								image_url: { url: "data:image/png;base64,AAAA" },
							},
						],
					},
				],
			}),
		});

		assert.equal(res.status, 200);
		await res.arrayBuffer();

		assert.equal(capturedUrl, OLLAMA_CHAT_ENDPOINTS[0]);
		const forwarded = JSON.parse(capturedBody) as {
			model: string;
			messages: Array<Record<string, unknown>>;
		};
		assert.equal(forwarded.model, "kimi-k3");
		assert.equal(forwarded.messages[0].content, "hello");
		assert.equal(forwarded.messages[1].content, "see this");
		assert.deepEqual(forwarded.messages[1].images, ["AAAA"]);
	});
});