import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDiscoveryPluginConfig,
  buildRemoteInstallerScript,
} from "../src/install-opencode.js";

describe("OpenCode Remote Installer", () => {
  const pluginFiles = {
    "index.mjs": "console.log('plugin test');",
    "package.json": JSON.stringify({ name: "tuxevil-opencode-discovery", type: "module" }),
  };

  it("builds a self-contained shell script that deploys the plugin directory", () => {
    const script = buildRemoteInstallerScript(pluginFiles, {
      rotatorUrl: "http://10.128.128.164:51200/v1",
      providerId: "tuxevil-rotator",
      providerName: "Tuxevil Rotator",
      apiKey: "rk-test-key",
      targetDir: "~/.config/opencode",
    });

    assert.ok(script.includes("TARGET_DIR=\"~/.config/opencode\""));
    assert.ok(script.includes("plugins/opencode-discovery"));
    assert.ok(script.includes("$PLUGIN_DIR/index.mjs"));
    assert.ok(script.includes("$PLUGIN_DIR/package.json"));
    assert.ok(script.includes("base64 -d"));
    assert.ok(script.includes("http://10.128.128.164:51200/v1"));
    assert.ok(script.includes("tuxevil-rotator"));
    assert.ok(script.includes("rk-test-key"));
    // V2 config form markers, legacy V1 form must be gone
    assert.ok(script.includes("config.plugins.push"));
    assert.ok(script.includes("package: pluginDir"));
    assert.ok(!script.includes("opencode-discovery.js"));
  });

  it("handles default values when optional parameters are omitted", () => {
    const script = buildRemoteInstallerScript(pluginFiles, {
      rotatorUrl: "http://localhost:51200/v1",
      providerId: "antigravity",
      providerName: "Antigravity (rotator)",
    });

    assert.ok(script.includes("antigravity"));
    assert.ok(script.includes("http://localhost:51200/v1"));
    assert.ok(script.includes("Antigravity (rotator)"));
  });

  it("applyDiscoveryPluginConfig writes the V2 plugins object form on a fresh config", () => {
    const config = applyDiscoveryPluginConfig(
      {},
      {
        pluginDir: "~/.config/opencode/plugins/opencode-discovery",
        providerID: "tuxevil-rotator",
        providerName: "Tuxevil Rotator",
        baseURL: "http://10.128.128.164:51200/v1",
        apiKey: "rk-test-key",
      },
    ) as Record<string, unknown>;

    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.ok(Array.isArray(config.plugins));
    const entries = config.plugins as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].package, "~/.config/opencode/plugins/opencode-discovery");
    assert.deepEqual(entries[0].options, {
      baseURL: "http://10.128.128.164:51200/v1",
      providerID: "tuxevil-rotator",
      providerName: "Tuxevil Rotator",
    });

    const provider = config.provider as Record<string, Record<string, unknown>>;
    assert.equal((provider["tuxevil-rotator"].npm as string), "@ai-sdk/openai-compatible");
    assert.equal(provider["tuxevil-rotator"].name, "Tuxevil Rotator");
    assert.equal((provider["tuxevil-rotator"].options as Record<string, unknown>).baseURL as unknown, "http://10.128.128.164:51200/v1");
    assert.ok("apiKey" in (provider["tuxevil-rotator"].options as object));
    assert.equal(config.model, "tuxevil-rotator/gemini-3.8-flash-high");
    assert.ok(!("plugin" in config));
  });

  it("scrubs discovery entries from both plugins and legacy plugin keys", () => {
    const config = applyDiscoveryPluginConfig(
      {
        plugin: [
          "other-plugin",
          ["/old/path/opencode-discovery.js", { baseURL: "http://old:51200/v1" }],
          "/third-plugin",
        ],
        plugins: [
          "existing-v2-plugin",
          { package: "/old/dir/opencode-discovery", options: {} },
        ],
        provider: {
          "tuxevil-rotator": {
            npm: "@ai-sdk/openai-compatible",
            name: "Old Name",
            options: { baseURL: "http://old:51200/v1", apiKey: "rk-old", headers: { "X-Keep": "1" } },
            models: { "kept-model": { name: "Kept" } },
          },
        },
        model: "existing/model",
      },
      {
        pluginDir: "/new/dir/opencode-discovery",
        providerID: "tuxevil-rotator",
        providerName: "Tuxevil Rotator",
        baseURL: "http://10.128.128.164:51200/v1",
        apiKey: "no-key",
      },
    ) as Record<string, unknown>;

    // plugins: legacy object entries scrubbed, ours appended to the remaining ones
    const plugins = config.plugins as Array<Record<string, unknown>>;
    assert.equal(plugins.length, 2);
    assert.equal(plugins[0], "existing-v2-plugin");
    assert.equal(plugins[1].package, "/new/dir/opencode-discovery");

    // legacy `plugin` kept only if non-discovery entries remain
    assert.deepEqual(config.plugin, ["other-plugin", "/third-plugin"]);

    // provider values refreshed, unrelated options and models preserved
    const provider = (config.provider as Record<string, Record<string, unknown>>)["tuxevil-rotator"];
    assert.equal(provider.name, "Tuxevil Rotator");
    const options = provider.options as Record<string, unknown>;
    assert.equal(options.baseURL, "http://10.128.128.164:51200/v1");
    assert.deepEqual(options.headers, { "X-Keep": "1" });
    assert.equal(options.apiKey, "rk-old");
    assert.ok("apiKey" in options, "existing apiKey must survive a no-key run");
    assert.ok(provider.models);

    // model set by the user is not stomped
    assert.equal(config.model, "existing/model");
  });

  it("executes the generated script end-to-end against a temp target dir", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "opencode-install-"));
    try {
      const script = buildRemoteInstallerScript(pluginFiles, {
        rotatorUrl: "http://127.0.0.1:51299/v1",
        providerId: "e2e-rotator",
        providerName: "E2E Rotator",
        apiKey: "rk-e2e",
        targetDir,
      });

      execSync("bash -s", { input: script, stdio: ["pipe", "pipe", "pipe"] });

      assert.ok(existsSync(join(targetDir, "plugins/opencode-discovery/index.mjs")));
      assert.ok(existsSync(join(targetDir, "plugins/opencode-discovery/package.json")));

      const written = JSON.parse(readFileSync(join(targetDir, "opencode.json"), "utf8"));
      const plugins = written.plugins as Array<Record<string, unknown>>;
      assert.equal(plugins.length, 1);
      assert.equal(plugins[0].package, join(targetDir, "plugins/opencode-discovery"));
      assert.equal((plugins[0].options as Record<string, unknown>).providerID, "e2e-rotator");
      assert.equal(((written.provider as Record<string, unknown>)["e2e-rotator"] as Record<string, unknown>).name, "E2E Rotator");
      assert.equal(written.model, "e2e-rotator/gemini-3.8-flash-high");
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("rejects incomplete pluginFiles input", () => {
    assert.throws(() => buildRemoteInstallerScript({ "index.mjs": "x" }, {
      rotatorUrl: "http://localhost:51200/v1",
      providerId: "antigravity",
      providerName: "Antigravity (rotator)",
    }), /index.mjs, package\.json/);
  });
});
