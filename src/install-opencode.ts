import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE_DIR = resolve(__dirname, "../plugins/opencode-discovery");

/**
 * Files shipped from the repo plugin directory to the target machine.
 * Keep in sync with plugins/opencode-discovery/.
 */
const PLUGIN_RUNTIME_SOURCE_FILES = ["index.mjs", "package.json"];

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

export interface DiscoveryConfigInput {
  pluginDir: string;
  providerID: string;
  providerName: string;
  baseURL: string;
  apiKey?: string;
}

/**
 * Pure config mutation shared in spirit with the self-contained node script
 * embedded in buildRemoteInstallerScript (which runs on hosts without this TS
 * module, so it carries its own copy — keep both in sync).
 *
 * Config form written for OpenCode 2.x:
 *   "plugins": [{ "package": pluginDir, "options": {...} }]
 *
 * Legacy cleanup: discovery entries are scrubbed from both the V2 "plugins"
 * list and the legacy "plugin" key; other legacy entries are left untouched
 * (OpenCode migrates them on its own).
 */
export function applyDiscoveryPluginConfig(
  config: Record<string, unknown>,
  { pluginDir, providerID, providerName, baseURL, apiKey }: DiscoveryConfigInput
): Record<string, unknown> {
  const isDiscoveryEntry = (entry: unknown): boolean => {
    if (typeof entry === "string") return entry.includes("opencode-discovery");
    if (Array.isArray(entry)) {
      return typeof entry[0] === "string" && entry[0].includes("opencode-discovery");
    }
    if (entry && typeof entry === "object") {
      const pkg = (entry as { package?: unknown }).package;
      return typeof pkg === "string" && pkg.includes("opencode-discovery");
    }
    return false;
  };

  config.plugins = Array.isArray(config.plugins)
    ? (config.plugins as unknown[]).filter((entry) => !isDiscoveryEntry(entry))
    : [];

  if (Array.isArray(config.plugin)) {
    const kept = (config.plugin as unknown[]).filter((entry) => !isDiscoveryEntry(entry));
    if (kept.length > 0) {
      config.plugin = kept;
    } else {
      delete config.plugin;
    }
  }

  (config.plugins as unknown[]).push({
    package: pluginDir,
    options: { baseURL, providerID, providerName },
  });

  if (!config.$schema) {
    config.$schema = "https://opencode.ai/config.json";
  }

  if (!config.provider) {
    config.provider = {};
  }
  const provider = config.provider as Record<string, Record<string, unknown>>;
  const existing = provider[providerID] ?? {};

  provider[providerID] = {
    ...(existing as object),
    npm: "@ai-sdk/openai-compatible",
    name: providerName,
    options: {
      ...((existing.options as object) ?? {}),
      baseURL,
      ...(apiKey && apiKey !== "no-key" ? { apiKey } : {}),
    },
  };

  if (!config.model) {
    config.model = `${providerID}/gemini-3.8-flash-high`;
  }

  return config;
}

/**
 * Builds the remote installation script that will execute on the target machine.
 */
export function buildRemoteInstallerScript(
  pluginFiles: Record<string, string>,
  options: {
    rotatorUrl: string;
    providerId: string;
    providerName: string;
    apiKey?: string;
    targetDir?: string;
  }
): string {
  if (!(PLUGIN_RUNTIME_SOURCE_FILES.every((name) => name in pluginFiles))) {
    throw new Error(`pluginFiles must include all of: ${PLUGIN_RUNTIME_SOURCE_FILES.join(", ")}`);
  }

  const targetDir = options.targetDir || "~/.config/opencode";
  const providerId = options.providerId || "antigravity";
  const providerName = options.providerName || "Antigravity (rotator)";
  const rotatorUrl = options.rotatorUrl;
  const apiKey = options.apiKey;

  const fileWriteLines = PLUGIN_RUNTIME_SOURCE_FILES.map((name) => {
    const base64 = Buffer.from(pluginFiles[name], "utf8").toString("base64");
    return `echo "${base64}" | base64 -d > "$PLUGIN_DIR/${name}"`;
  }).join("\n");

  return `
set -e
TARGET_DIR="${targetDir}"
eval TARGET_DIR="$TARGET_DIR"

mkdir -p "$TARGET_DIR/plugins/opencode-discovery"
PLUGIN_DIR="$TARGET_DIR/plugins/opencode-discovery"
CONFIG_FILE="$TARGET_DIR/opencode.json"

echo "==> Writing plugin to $PLUGIN_DIR/index.mjs..."
${fileWriteLines}

# Prepare node script to cleanly mutate or create opencode.json (OpenCode 2.x form)
node -e '
const fs = require("fs");
const path = require("path");

const configFile = process.argv[1];
const pluginDir = process.argv[2];
const providerID = process.argv[3];
const providerName = process.argv[4];
const baseURL = process.argv[5];
const apiKey = process.argv[6];

let config = {};
if (fs.existsSync(configFile)) {
  try {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (err) {
    console.error("Warning: parsing existing " + configFile + " failed, backing up to .bak");
    fs.copyFileSync(configFile, configFile + ".bak." + Date.now());
  }
}

if (!config.$schema) {
  config.$schema = "https://opencode.ai/config.json";
}

const isDiscoveryEntry = (entry) => {
  if (typeof entry === "string") return entry.includes("opencode-discovery");
  if (Array.isArray(entry)) {
    return typeof entry[0] === "string" && entry[0].includes("opencode-discovery");
  }
  if (entry && typeof entry === "object") {
    return typeof entry.package === "string" && entry.package.includes("opencode-discovery");
  }
  return false;
};

// V2 plugin list: scrub prior discovery entries, then register the directory
config.plugins = Array.isArray(config.plugins) ? config.plugins.filter(p => !isDiscoveryEntry(p)) : [];
config.plugins.push({
  package: pluginDir,
  options: { baseURL, providerID, providerName }
});

// Legacy V1 key: scrub discovery entries, keep everything else untouched
if (Array.isArray(config.plugin)) {
  const kept = config.plugin.filter(p => !isDiscoveryEntry(p));
  if (kept.length > 0) {
    config.plugin = kept;
  } else {
    delete config.plugin;
  }
}

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
' "$CONFIG_FILE" "$PLUGIN_DIR" "${providerId}" "${providerName}" "${rotatorUrl}" "${apiKey || ""}"

echo "==> Installation complete! OpenCode is now configured to discover models from ${rotatorUrl}"
`;
}

/**
 * Installs the discovery plugin either locally or remotely via SSH.
 */
export async function installOpenCodePlugin(options: InstallOptions): Promise<void> {
  const pluginFiles: Record<string, string> = {};
  for (const name of PLUGIN_RUNTIME_SOURCE_FILES) {
    const filePath = resolve(PLUGIN_SOURCE_DIR, name);
    if (!existsSync(filePath)) {
      throw new Error(`Plugin directory ${PLUGIN_SOURCE_DIR} does not contain ${name}`);
    }
    pluginFiles[name] = readFileSync(filePath, "utf8");
  }

  const rotatorUrl = (options.rotatorUrl || process.env.TUXEVIL_ROTATOR_BASE_URL || "http://127.0.0.1:51200/v1").replace(/\/+$/, "");
  const providerId = options.providerId || "antigravity";
  const providerName = options.providerName || "Antigravity (rotator)";

  const script = buildRemoteInstallerScript(pluginFiles, {
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
