// Audio transcription honors the Models page switches, including for the
// model it actually runs upstream, and never falls back around them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleOpenAIAudioTranscriptions } from "../src/audio-transcription.js";

process.env.PI_ROTATOR_TELEMETRY = "off";

function wavBuffer(): Buffer {
  const pcm = Buffer.alloc(3_200);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  return wav;
}

function makeRotator(config: Record<string, unknown>, onAccount?: () => void) {
  return {
    getConfig: () => ({ accounts: [], ...config }),
    getActiveAccount: async () => {
      onAccount?.();
      return null;
    },
    getRetryAfterMs: () => 0,
    getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0,
    recordProxyEvent() {},
  };
}

async function transcribe(rotator: unknown): Promise<{ status: number; body: { error?: { code?: string } } }> {
  const server = createServer((req, res) => {
    void handleOpenAIAudioTranscriptions(req, res, rotator as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(wavBuffer())], "sample.wav", { type: "audio/wav" }));
    form.append("model", "whisper-1");
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    return { status: response.status, body: (await response.json()) as { error?: { code?: string } } };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("audio transcription and Models page switches", () => {
  it("refuses whisper-1 when the model it runs upstream is turned off", async () => {
    let routed = false;
    const result = await transcribe(
      makeRotator({ disabledModels: ["google-antigravity/gemini-3.8-flash-low"] }, () => (routed = true)),
    );
    assert.equal(result.status, 404);
    assert.equal(result.body.error?.code, "model_not_found");
    assert.equal(routed, false);
  });

  it("does not fall back to the language server when a switch turns off mid-request", async () => {
    const config: Record<string, unknown> = {};
    // Turn Google off while the request waits for an account.
    const result = await transcribe(makeRotator(config, () => (config.disabledProviders = ["google-antigravity"])));
    assert.equal(result.status, 404);
    assert.equal(result.body.error?.code, "model_not_found");
  });
});
