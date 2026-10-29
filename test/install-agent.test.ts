import { readFileSync as readCapabilitySource } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCompositeInstallerScript } from "../src/install-agent.js";

describe("Agent Installer", () => {
  const mockPluginFiles = {
    "capabilities.mjs": readCapabilitySource(
      new URL(
        "../plugins/opencode-discovery/capabilities.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
    "index.mjs": "console.log('mock-plugin');",
    "package.json": JSON.stringify({
      name: "tuxevil-opencode-discovery",
      type: "module",
    }),
  };

  it("builds composite script covering auto-detection by default", () => {
    const script = buildCompositeInstallerScript(mockPluginFiles, {
      targets: ["auto"],
      rotatorUrl: "http://10.128.128.164:51200/v1",
      providerId: "tuxevil-rotator",
      providerName: "Tuxevil Rotator",
      apiKey: "rk-test-key",
    });

    assert.ok(script.includes('ROTATOR_URL="http://10.128.128.164:51200/v1"'));
    assert.ok(script.includes('PROVIDER_ID="tuxevil-rotator"'));
    assert.ok(script.includes('API_KEY="rk-test-key"'));

    // Check agent sections
    assert.ok(script.includes("# 1. OpenCode Configuration"));
    assert.ok(script.includes("# 2. Hermes Configuration"));
    assert.ok(script.includes("# 3. Pi Agent Configuration"));
    assert.ok(script.includes("# 4. Codex CLI Configuration"));

    // Check specific agent signatures
    assert.ok(script.includes("supports_reasoning"));
    assert.ok(script.includes("# 5. OpenClaw Configuration"));
    assert.ok(script.includes("models.json"));
    assert.ok(script.includes("config.toml"));
    assert.ok(script.includes("opencode-discovery/index.mjs"));
    assert.ok(script.includes("config.plugins.push"));
    assert.ok(!script.includes("opencode-discovery.js"));
  });

  it("respects targeted agent selections", () => {
    const script = buildCompositeInstallerScript(mockPluginFiles, {
      targets: ["hermes", "pi"],
      rotatorUrl: "http://localhost:51200/v1",
      providerId: "antigravity",
      providerName: "Antigravity",
    });

    assert.ok(script.includes('ROTATOR_URL="http://localhost:51200/v1"'));
    assert.ok(script.includes('should_install "hermes"'));
    assert.ok(script.includes('should_install "pi"'));
  });

  it("handles fallback defaults when apiKey is not provided", () => {
    const script = buildCompositeInstallerScript(mockPluginFiles, {
      targets: ["all"],
      rotatorUrl: "http://localhost:51200/v1",
      providerId: "tuxevil-rotator",
      providerName: "Tuxevil Rotator",
    });

    assert.ok(script.includes('API_KEY="no-key"'));
  });
});
