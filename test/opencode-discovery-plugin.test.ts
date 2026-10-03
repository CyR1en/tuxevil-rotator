import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import RotatorDiscoveryPlugin, {
  resolvePluginOptions,
  mapModelToOpenCode,
} from "../plugins/opencode-discovery.js";

describe("OpenCode Rotator Discovery Plugin", () => {
  it("resolves options from explicit plugin options", () => {
    const opts = resolvePluginOptions(
      {},
      {
        baseURL: "http://192.168.1.50:51200/v1/",
        providerID: "custom-rotator",
        providerName: "My Rotator",
        timeoutMs: 5000,
      }
    );

    assert.equal(opts.baseURL, "http://192.168.1.50:51200/v1");
    assert.equal(opts.providerID, "custom-rotator");
    assert.equal(opts.providerName, "My Rotator");
    assert.equal(opts.timeoutMs, 5000);
  });

  it("resolves baseURL from environment variable when not in options", () => {
    const prev = process.env.TUXEVIL_ROTATOR_BASE_URL;
    try {
      process.env.TUXEVIL_ROTATOR_BASE_URL = "http://remote-rotator:51200/v1";
      const opts = resolvePluginOptions({}, {});
      assert.equal(opts.baseURL, "http://remote-rotator:51200/v1");
    } finally {
      if (prev !== undefined) {
        process.env.TUXEVIL_ROTATOR_BASE_URL = prev;
      } else {
        delete process.env.TUXEVIL_ROTATOR_BASE_URL;
      }
    }
  });

  it("resolves baseURL from existing config.provider when present", () => {
    const config = {
      provider: {
        "remote-rot": {
          options: {
            baseURL: "http://10.0.0.99:51200/v1",
          },
          name: "Remote Tuxevil",
        },
      },
    };

    const opts = resolvePluginOptions(config, {});
    assert.equal(opts.baseURL, "http://10.0.0.99:51200/v1");
    assert.equal(opts.providerID, "remote-rot");
    assert.equal(opts.providerName, "Remote Tuxevil");
  });

  it("falls back to default 127.0.0.1:51200/v1 when nothing is specified", () => {
    const opts = resolvePluginOptions({}, {});
    assert.equal(opts.baseURL, "http://127.0.0.1:51200/v1");
    assert.equal(opts.providerID, "antigravity");
    assert.equal(opts.providerName, "Antigravity (rotator)");
  });

  it("maps raw rotator models to OpenCode model schema", () => {
    const raw = {
      id: "gemini-3.8-flash-high",
      context_window: 1048576,
      meta: {
        context_length: 1048576,
        max_output_tokens: 65536,
        multimodal: true,
        tool_calling: true,
      },
    };

    const { id, modelDef } = mapModelToOpenCode(raw);
    assert.equal(id, "gemini-3.8-flash-high");
    assert.equal(modelDef.name, "gemini-3.8-flash-high");
    assert.deepEqual(modelDef.limit, { context: 1048576, output: 65536 });
    assert.deepEqual(modelDef.capabilities, {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    });
  });

  it("discovers models from mock server and mutates config cleanly", async () => {
    const mockModels = [
      {
        id: "mock-model-1",
        meta: {
          context_length: 200000,
          max_output_tokens: 4096,
          multimodal: false,
          tool_calling: true,
        },
      },
      {
        id: "mock-model-2",
        meta: {
          context_length: 500000,
          max_output_tokens: 16384,
          multimodal: true,
          tool_calling: true,
        },
      },
    ];

    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: mockModels }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;
    const baseURL = `http://127.0.0.1:${port}/v1`;

    try {
      const plugin = await RotatorDiscoveryPlugin(
        {},
        {
          baseURL,
          providerID: "test-rotator",
          providerName: "Test Rotator",
        }
      );

      const opencodeConfig: Record<string, any> = {};
      await plugin.config(opencodeConfig);

      assert.ok(opencodeConfig.provider);
      assert.ok(opencodeConfig.provider["test-rotator"]);
      const prov = opencodeConfig.provider["test-rotator"];
      assert.equal(prov.name, "Test Rotator");
      assert.equal(prov.npm, "@ai-sdk/openai-compatible");
      assert.equal(prov.options.baseURL, baseURL);
      assert.ok(prov.models["mock-model-1"]);
      assert.ok(prov.models["mock-model-2"]);
      assert.equal(prov.models["mock-model-1"].limit.context, 200000);
      assert.deepEqual(prov.models["mock-model-2"].capabilities.input, ["text", "image"]);
    } finally {
      server.close();
    }
  });

  it("gracefully handles connection errors without throwing during startup", async () => {
    const plugin = await RotatorDiscoveryPlugin(
      {},
      {
        baseURL: "http://127.0.0.1:59999/v1", // Dead port
        timeoutMs: 300,
      }
    );

    const opencodeConfig = {
      provider: {
        antigravity: {
          name: "Antigravity",
          models: {
            "existing-fallback": { name: "Fallback" },
          },
        },
      },
    };

    // Should not throw
    await plugin.config(opencodeConfig);

    // Existing models remain intact
    assert.ok(opencodeConfig.provider.antigravity.models["existing-fallback"]);
  });
});
