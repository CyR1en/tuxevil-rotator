import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteInstallerScript } from "../src/install-opencode.js";

describe("OpenCode Remote Installer", () => {
  it("builds a self-contained shell script with base64 embedded plugin", () => {
    const pluginCode = "console.log('plugin test');";
    const script = buildRemoteInstallerScript(pluginCode, {
      rotatorUrl: "http://10.128.128.164:51200/v1",
      providerId: "tuxevil-rotator",
      providerName: "Tuxevil Rotator",
      apiKey: "rk-test-key",
      targetDir: "~/.config/opencode",
    });

    assert.ok(script.includes("TARGET_DIR=\"~/.config/opencode\""));
    assert.ok(script.includes("base64 -d"));
    assert.ok(script.includes("http://10.128.128.164:51200/v1"));
    assert.ok(script.includes("tuxevil-rotator"));
    assert.ok(script.includes("rk-test-key"));
    assert.ok(script.includes("opencode-discovery.js"));
  });

  it("handles default values when optional parameters are omitted", () => {
    const pluginCode = "export default function() {}";
    const script = buildRemoteInstallerScript(pluginCode, {
      rotatorUrl: "http://localhost:51200/v1",
      providerId: "antigravity",
      providerName: "Antigravity (rotator)",
    });

    assert.ok(script.includes("antigravity"));
    assert.ok(script.includes("http://localhost:51200/v1"));
    assert.ok(script.includes("Antigravity (rotator)"));
  });
});
