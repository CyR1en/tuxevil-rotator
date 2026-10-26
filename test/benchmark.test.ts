import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AccountRuntime } from "../src/types.js";
import {
  benchmarkAccount,
  serveBenchmarkApi,
  summarizeBenchmarkResults,
} from "../src/proxy.js";

import { getBenchmarkSpec } from "../src/providers/google-antigravity/forward.js";

function makeAccount(overrides: Partial<AccountRuntime> = {}): AccountRuntime {
  return {
    config: {
      email: "bench@example.com",
      refreshToken: "refresh-token",
      projectId: "project-id",
      label: "benchmark",
    },
    accessToken: null,
    tokenExpires: 0,
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
    dailyRequestDay: "2026-07-29",
    healthScore: 1,
    tokenBucket: { tokens: 50, lastRefillAt: Date.now() },
    ...overrides,
  };
}

function makeRotator(account: AccountRuntime) {
  return {
    getConfig: () => ({ maxConcurrentRequestsPerAccount: 1 }),
    ensureValidToken: async (target: AccountRuntime) => {
      target.accessToken = "access-token";
      target.tokenExpires = Date.now() + 60_000;
    },
    startRequest: (target: AccountRuntime) => {
      target.inFlightRequests++;
    },
    finishRequest: (target: AccountRuntime) => {
      target.inFlightRequests = Math.max(0, target.inFlightRequests - 1);
    },
    getBenchmarkAccounts: () => [account],
  };
}

function makeResponse() {
  const chunks: string[] = [];
  const listeners = new Map<string, () => void>();
  const state = {
    chunks,
    statusCode: 0,
    headers: {} as Record<string, string>,
    writableEnded: false,
    destroyed: false,
  };
  const response = {
    get writableEnded() {
      return state.writableEnded;
    },
    get destroyed() {
      return state.destroyed;
    },
    writeHead(code: number, headers: Record<string, string>) {
      state.statusCode = code;
      state.headers = headers;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      state.writableEnded = true;
    },
    once(event: string, listener: () => void) {
      listeners.set(event, listener);
    },
    off(event: string) {
      listeners.delete(event);
    },
  };
  return { response: response as never, state };
}

describe("account benchmark", () => {
  it("benchmarks an active account and reports SSE progress and completion", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        'data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
        { status: 200 },
      )) as typeof fetch;

    try {
      const account = makeAccount();
      const rotator = makeRotator(account);
      const { response, state } = makeResponse();
      await serveBenchmarkApi(response, rotator as never);

      const events = state.chunks
        .join("")
        .split(/\r?\n\r?\n/)
        .flatMap((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => JSON.parse(line.slice(5).trim())),
        );
      const complete = events.find((event) => event.type === "complete");
      assert.equal(state.statusCode, 200);
      assert.equal(complete.summary.succeeded, 1);
      assert.equal(complete.summary.successRate, 100);
      assert.equal(complete.results[0].status, "success");
      assert.equal(complete.results[0].outputTokens, 2);
      assert.equal(complete.results[0].account, "be***rk");
      assert.equal(account.inFlightRequests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips an account already at its concurrency limit", async () => {
    const account = makeAccount({ inFlightRequests: 1 });
    const result = await benchmarkAccount(
      makeRotator(account) as never,
      account,
    );
    assert.equal(result.status, "skipped");
    assert.match(result.error || "", /maximum number/);
  });

  it("summarizes success, failure, and skipped results", () => {
    const summary = summarizeBenchmarkResults([
      {
        account: "a",
        status: "success",
        latencyMs: 100,
        ttfbMs: 40,
        outputTokens: 10,
        tokensPerSecond: 100,
      },
      {
        account: "b",
        status: "failed",
        latencyMs: 30,
        ttfbMs: null,
        outputTokens: null,
        tokensPerSecond: null,
      },
      {
        account: "c",
        status: "skipped",
        latencyMs: null,
        ttfbMs: null,
        outputTokens: null,
        tokensPerSecond: null,
      },
    ]);
    assert.deepEqual(summary, {
      total: 3,
      succeeded: 1,
      failed: 1,
      skipped: 1,
      successRate: 33.33333333333333,
      averageLatencyMs: 100,
      averageTtfbMs: 40,
      averageTokensPerSecond: 100,
    });
  });
});


describe("Antigravity benchmark response parsing", () => {
  for (const newline of ["\n", "\r\n"]) {
    it(`reads wrapped visible text and cumulative usage (${JSON.stringify(newline)})`, () => {
      const spec = getBenchmarkSpec(makeAccount());
      const payloads = [
        { candidates: [{ content: { parts: [{ thought: true, text: "internal reasoning" }] } }], usageMetadata: { promptTokenCount: 6 } },
        { candidates: [{ content: { parts: [{ text: "O" }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 1 } },
        { candidates: [{ content: { parts: [{ text: "K" }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } },
        { candidates: [{ content: { parts: [{ text: "", thoughtSignature: "fixture" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } },
      ];
      const raw = payloads.map((response) => `data: ${JSON.stringify({ response })}${newline}${newline}`).join("");
      assert.equal(spec.parseText(raw), "OK");
      assert.deepEqual(spec.parseUsage(raw), { outputTokens: 2 });
    });
  }

  it("preserves unwrapped responses and ignores non-content events", () => {
    const spec = getBenchmarkSpec(makeAccount());
    const raw = 'event: ping\n\ndata: invalid\n\ndata: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}],"usageMetadata":{"candidatesTokenCount":1}}\n\ndata: [DONE]\n\n';
    assert.equal(spec.parseText(raw), "OK");
    assert.deepEqual(spec.parseUsage(raw), { outputTokens: 1 });
  });
});
