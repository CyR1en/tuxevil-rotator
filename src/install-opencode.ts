import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE_PATH = resolve(__dirname, "../plugins/opencode-discovery.js");

export interface InstallOptions {
  host?: string;
  user?: string;
  port?: number;
  sshKey?: string;
  rotatorUrl?: string;
  providerId?: string;
  providerName?: string;
  apiKey?: string;
  targetDir?: string;
  dryRun?: boolean;
}

/**
 * Builds the remote installation script that will execute on the target machine.
 */
export function buildRemoteInstallerScript(
  pluginContent: string,
  options: {
    rotatorUrl: string;
    providerId: string;
    providerName: string;
    apiKey?: string;
    targetDir?: string;
  }
): string {
  const pluginContentBase64 = Buffer.from(pluginContent, "utf8").toString("base64");
  const targetDir = options.targetDir || "~/.config/opencode";
  const providerId = options.providerId || "antigravity";
  const providerName = options.providerName || "Antigravity (rotator)";
  const rotatorUrl = options.rotatorUrl;
  const apiKey = options.apiKey;

  return `
set -e
TARGET_DIR="${targetDir}"
eval TARGET_DIR="$TARGET_DIR"

mkdir -p "$TARGET_DIR/plugins"
PLUGIN_FILE="$TARGET_DIR/plugins/opencode-discovery.js"
CONFIG_FILE="$TARGET_DIR/opencode.json"

echo "==> Writing plugin to $PLUGIN_FILE..."
echo "${pluginContentBase64}" | base64 -d > "$PLUGIN_FILE"

# Prepare node script to cleanly mutate or create opencode.json
node -e '
const fs = require("fs");
const path = require("path");

const configFile = process.argv[1];
const pluginPath = process.argv[2];
const providerID = process.argv[3];
const providerName = process.argv[4];
const baseURL = process.argv[5];
const apiKey = process.argv[6];

let config = {};
if (fs.existsSync(configFile)) {
  try {
    const raw = fs.readFileSync(configFile, "utf8");
    config = JSON.parse(raw);
  } catch (err) {
    console.error("Warning: parsing existing " + configFile + " failed, backing up to .bak");
    fs.copyFileSync(configFile, configFile + ".bak." + Date.now());
  }
}

if (!config.$schema) {
  config.$schema = "https://opencode.ai/config.json";
}

if (!Array.isArray(config.plugin)) {
  config.plugin = [];
}

// Remove any prior entry of opencode-discovery
config.plugin = config.plugin.filter(p => {
  if (typeof p === "string") return !p.includes("opencode-discovery.js");
  if (Array.isArray(p)) return !p[0].includes("opencode-discovery.js");
  return true;
});

// Add plugin tuple with options
config.plugin.push([
  pluginPath,
  {
    baseURL: baseURL,
    providerID: providerID,
    providerName: providerName
  }
]);

if (!config.provider) {
  config.provider = {};
}

if (!config.provider[providerID]) {
  config.provider[providerID] = {
    npm: "@ai-sdk/openai-compatible",
    name: providerName,
    options: {
      baseURL: baseURL
    }
  };
} else {
  config.provider[providerID].npm = "@ai-sdk/openai-compatible";
  config.provider[providerID].name = providerName;
  config.provider[providerID].options = config.provider[providerID].options || {};
  config.provider[providerID].options.baseURL = baseURL;
}

if (apiKey && apiKey !== "no-key") {
  config.provider[providerID].options.apiKey = apiKey;
}

if (!config.model) {
  config.model = providerID + "/gemini-3.8-flash-high";
}

fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\\n", "utf8");
console.log("==> Successfully updated " + configFile);
' "$CONFIG_FILE" "$PLUGIN_FILE" "${providerId}" "${providerName}" "${rotatorUrl}" "${apiKey || ""}"

echo "==> Installation complete! OpenCode is now configured to discover models from ${rotatorUrl}"
`;
}

/**
 * Installs the discovery plugin either locally or remotely via SSH.
 */
export async function installOpenCodePlugin(options: InstallOptions): Promise<void> {
  if (!existsSync(PLUGIN_SOURCE_PATH)) {
    throw new Error(`Plugin file not found at ${PLUGIN_SOURCE_PATH}`);
  }

  const pluginContent = readFileSync(PLUGIN_SOURCE_PATH, "utf8");
  const rotatorUrl = (options.rotatorUrl || process.env.TUXEVIL_ROTATOR_BASE_URL || "http://127.0.0.1:51200/v1").replace(/\/+$/, "");
  const providerId = options.providerId || "antigravity";
  const providerName = options.providerName || "Antigravity (rotator)";

  const script = buildRemoteInstallerScript(pluginContent, {
    rotatorUrl,
    providerId,
    providerName,
    apiKey: options.apiKey,
    targetDir: options.targetDir,
  });

  if (options.dryRun) {
    console.log("=== Dry Run Mode: Script that would be executed ===");
    console.log(script);
    return;
  }

  // Local installation
  if (!options.host || options.host === "localhost" || options.host === "127.0.0.1") {
    console.log(`==> Installing OpenCode plugin locally for rotator: ${rotatorUrl}...`);
    execSync("bash -s", {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
    return;
  }

  // Remote installation via SSH
  const sshTarget = options.user ? `${options.user}@${options.host}` : options.host;
  const sshArgs: string[] = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
  ];

  if (options.port) {
    sshArgs.push("-p", String(options.port));
  }
  if (options.sshKey) {
    sshArgs.push("-i", options.sshKey);
  }

  const sshCmd = `ssh ${sshArgs.join(" ")} ${sshTarget} "bash -s"`;

  console.log(`==> Installing OpenCode plugin remotely on ${sshTarget} (Rotator: ${rotatorUrl})...`);
  try {
    execSync(sshCmd, {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`SSH installation failed on ${sshTarget}: ${errorMsg}`, { cause: err });
  }
}
