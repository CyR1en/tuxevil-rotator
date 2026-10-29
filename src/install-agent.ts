import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCODE_PLUGIN_SOURCE_DIR = resolve(
  __dirname,
  "../plugins/opencode-discovery",
);
const OPENCODE_PLUGIN_RUNTIME_FILES = [
  "index.mjs",
  "package.json",
  "capabilities.mjs",
];

export type SupportedAgent =
  "opencode" | "hermes" | "pi" | "codex" | "openclaw";

export interface AgentInstallOptions {
  targets?: Array<SupportedAgent | "auto" | "all">;
  host?: string;
  user?: string;
  port?: number;
  sshKey?: string;
  rotatorUrl?: string;
  providerId?: string;
  providerName?: string;
  apiKey?: string;
  dryRun?: boolean;
}

/**
 * Builds the composite shell script that detects and configures all requested agents.
 */
export function buildCompositeInstallerScript(
  opencodePluginFiles: Record<string, string>,
  options: {
    targets: Array<SupportedAgent | "auto" | "all">;
    rotatorUrl: string;
    providerId: string;
    providerName: string;
    apiKey?: string;
  },
): string {
  if (
    !OPENCODE_PLUGIN_RUNTIME_FILES.every((name) => name in opencodePluginFiles)
  ) {
    throw new Error(
      `opencodePluginFiles must include all of: ${OPENCODE_PLUGIN_RUNTIME_FILES.join(", ")}`,
    );
  }

  const pluginFileWriteLines = OPENCODE_PLUGIN_RUNTIME_FILES.map((name) => {
    const base64 = Buffer.from(opencodePluginFiles[name], "utf8").toString(
      "base64",
    );
    return `echo "${base64}" | base64 -d > "$OPENCODE_DIR/plugins/opencode-discovery/${name}"`;
  }).join("\n");
  const rotatorUrl = options.rotatorUrl.replace(/\/+$/, "");
  const providerId = options.providerId || "tuxevil-rotator";
  const providerName = options.providerName || "Tuxevil Rotator";
  const apiKey = options.apiKey || "no-key";
  const targets =
    options.targets && options.targets.length > 0 ? options.targets : ["auto"];
  const allowedTargets = new Set([
    "opencode",
    "hermes",
    "pi",
    "codex",
    "openclaw",
    "auto",
    "all",
  ]);
  if (targets.some((target) => !allowedTargets.has(target)))
    throw new Error(
      "Unknown agent target. Use opencode, hermes, openclaw, pi, codex, auto or all.",
    );
  const shouldAuto = targets.includes("auto") || targets.includes("all");

  return `#!/usr/bin/env bash
set -e

ROTATOR_URL="${rotatorUrl}"
PROVIDER_ID="${providerId}"
PROVIDER_NAME="${providerName}"
API_KEY="${apiKey}"

echo "=========================================================="
echo "==> Tuxevil Rotator Agent Installer"
echo "==> Rotator URL:   $ROTATOR_URL"
echo "==> Provider ID:   $PROVIDER_ID"
echo "=========================================================="

# One catalog snapshot and shared capability mapper for every selected agent.
AGENT_WORK_DIR=$(mktemp -d)
trap 'rm -rf "$AGENT_WORK_DIR"' EXIT
printf %s "${Buffer.from(opencodePluginFiles["capabilities.mjs"], "utf8").toString("base64")}" | base64 -d > "$AGENT_WORK_DIR/capabilities.mjs"
node --input-type=module -e '
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const { fetchModels } = await import(pathToFileURL(process.argv[1]).href);
let models = [];
try { models = await fetchModels(process.argv[2], process.argv[3]); }
catch { console.warn("==> Catalog unavailable; keeping existing model settings."); }
fs.writeFileSync(process.argv[4], JSON.stringify(models));
' "$AGENT_WORK_DIR/capabilities.mjs" "$ROTATOR_URL" "$API_KEY" "$AGENT_WORK_DIR/models.json"

# Helper to check if agent should be installed
should_install() {
  local agent="$1"
  local check_dir="$2"
  if [ "${targets.includes("all") ? "1" : "0"}" = "1" ]; then
    return 0
  fi
  if [ "${shouldAuto ? "1" : "0"}" = "1" ]; then
    if [ -d "$check_dir" ]; then
      return 0
    else
      return 1
    fi
  fi
  case ",${targets.join(",")}," in
    *,$agent,*) return 0 ;;
    *) return 1 ;;
  esac
}

# -------------------------------------------------------------
# 1. OpenCode Configuration
# -------------------------------------------------------------
OPENCODE_DIR="$HOME/.config/opencode"
if should_install "opencode" "$OPENCODE_DIR"; then
  echo ""
  echo "==> [OpenCode] Configuring in $OPENCODE_DIR..."
  mkdir -p "$OPENCODE_DIR/plugins/opencode-discovery"
${pluginFileWriteLines}

  node -e '
  (async () => {
  const fs = require("fs");
  const path = require("path");

  const configFile = path.join(process.env.HOME, ".config/opencode/opencode.json");
  const pluginDir = path.join(process.env.HOME, ".config/opencode/plugins/opencode-discovery");
  const providerID = process.argv[1];
  const providerName = process.argv[2];
  const baseURL = process.argv[3];
  const apiKey = process.argv[4];

  let config = {};
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (e) {
      console.warn("Warning: Backing up invalid opencode.json");
      fs.copyFileSync(configFile, configFile + ".bak." + Date.now());
      config = {};
    }
  }

  config.$schema = config.$schema || "https://opencode.ai/config.json";

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

  config.provider = config.provider || {};
  config.provider[providerID] = config.provider[providerID] || {
    npm: "@ai-sdk/openai-compatible",
    name: providerName,
    options: { baseURL }
  };
  config.provider[providerID].npm = "@ai-sdk/openai-compatible";
  config.provider[providerID].name = providerName;
  config.provider[providerID].options = config.provider[providerID].options || {};
  config.provider[providerID].options.baseURL = baseURL;

  if (apiKey && apiKey !== "no-key") {
    config.provider[providerID].options.apiKey = apiKey;
  }

  const { mergeOpenCodeModels } = await import(require("url").pathToFileURL(process.argv[6]).href);
  const live = JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
  if (live.length) config.provider[providerID].models = mergeOpenCodeModels(config.provider[providerID].models, live);
  if (fs.existsSync(configFile)) fs.copyFileSync(configFile, configFile + ".bak." + Date.now());
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\\n", "utf8");
  console.log("==> [OpenCode] Configured successfully.");
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
  ' "$PROVIDER_ID" "$PROVIDER_NAME" "$ROTATOR_URL" "$API_KEY" "$AGENT_WORK_DIR/models.json" "$AGENT_WORK_DIR/capabilities.mjs"
else
  echo "==> [OpenCode] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 2. Hermes Configuration
# -------------------------------------------------------------
HERMES_DIR="\${HERMES_HOME:-$HOME/.hermes}"
if should_install "hermes" "$HERMES_DIR"; then
  echo ""
  echo "==> [Hermes] Configuring in $HERMES_DIR..."
  mkdir -p "$HERMES_DIR"

  python3 -c '
import os, sys, json, time, shutil
config_file = os.path.join(sys.argv[5], "config.yaml")
provider_id, rotator_url, api_key, models_file = sys.argv[1:5]
try:
    import yaml
except ImportError:
    yaml = None
content = open(config_file, encoding="utf-8").read() if os.path.exists(config_file) else ""
try:
    data = (yaml.safe_load(content) if yaml else json.loads(content)) if content.strip() else {}
except Exception as error:
    raise SystemExit("Cannot safely parse existing Hermes YAML; install PyYAML. Configuration was preserved.") from error
if not isinstance(data, dict):
    raise SystemExit("Hermes configuration must be a mapping; configuration was preserved.")
custom = data.setdefault("custom_providers", [])
if not isinstance(custom, list):
    raise SystemExit("Hermes custom_providers must be a list; configuration was preserved.")
modern = data.get("providers", {})
modern_entry = modern.get(provider_id) if isinstance(modern, dict) else None
entry = modern_entry if isinstance(modern_entry, dict) else next((p for p in custom if isinstance(p, dict) and p.get("name") == provider_id), None)
# Reuse an already connected legacy provider only when the endpoint matches.
if entry is None:
    entry = next((p for p in custom if isinstance(p, dict) and p.get("name") in ("antigravity", "tuxevil-rotator") and str(p.get("base_url", "")).rstrip("/") == rotator_url), None)
if entry is None:
    entry = {"name": provider_id}
    custom.append(entry)
if entry is modern_entry:
    entry["api"] = rotator_url
else:
    entry["base_url"] = rotator_url
entry.setdefault("api_mode", "chat_completions")
entry.pop("discover_models", None)
if api_key != "no-key" or not (entry.get("api_key") or entry.get("key_env")):
    entry["api_key"] = api_key
with open(models_file, encoding="utf-8") as f:
    live = json.load(f)
models = entry.get("models", {})
if isinstance(models, list):
    models = {name: {} for name in models if isinstance(name, str)}
if not isinstance(models, dict):
    raise SystemExit("Hermes provider models must be a mapping or list; configuration was preserved.")
for model in live:
    meta = model.get("meta", {})
    prior = models.get(model["id"], {})
    models[model["id"]] = {"context_length": meta.get("context_length", model.get("context_window", 128000)), **prior}
    # A named-provider override enables native /reasoning controls without pinning
    # an effort or changing defaults for any other provider.
    if meta.get("provider") == "openai-codex" or meta.get("family") == "openai-codex":
        overrides = data.setdefault("model_overrides", {}).setdefault("custom:" + entry.get("name", provider_id), {})
        overrides.setdefault(model["id"], {}).setdefault("supports_reasoning", meta.get("reasoning", False))
if models:
    entry["models"] = models
if content:
    shutil.copy2(config_file, config_file + ".bak." + str(time.time_ns()))
with open(config_file, "w", encoding="utf-8") as f:
    if yaml:
        yaml.safe_dump(data, f, sort_keys=False)
    else:
        json.dump(data, f, indent=2)
print("==> [Hermes] Connected; choose a Codex model and use /reasoning low|medium|high|xhigh|max as supported.")
' "$PROVIDER_ID" "$ROTATOR_URL" "$API_KEY" "$AGENT_WORK_DIR/models.json" "$HERMES_DIR"
else
  echo "==> [Hermes] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 3. Pi Agent Configuration
# -------------------------------------------------------------
PI_DIR="$HOME/.pi/agent"
if should_install "pi" "$PI_DIR"; then
  echo ""
  echo "==> [Pi Agent] Configuring in $PI_DIR..."
  mkdir -p "$PI_DIR"

  node -e '
  const fs = require("fs");
  const path = require("path");

  const modelsFile = path.join(process.env.HOME, ".pi/agent/models.json");
  const providerID = process.argv[1];
  const baseURL = process.argv[2];
  const apiKey = process.argv[3];

  async function main() {
    let modelsData = { providers: {} };
    if (fs.existsSync(modelsFile)) {
      try {
        modelsData = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
      } catch (e) {
        console.warn("Warning: Backing up corrupted models.json");
        fs.copyFileSync(modelsFile, modelsFile + ".bak." + Date.now());
        modelsData = { providers: {} };
      }
    }
    modelsData.providers = modelsData.providers || {};

    const rawModels = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
    const { mapAgentModel } = await import(require("url").pathToFileURL(process.argv[5]).href);
    let mappedModels = [];

    if (rawModels.length > 0) {
      mappedModels = rawModels.map(raw => {
        const model = mapAgentModel(raw);
        if (model.compat) model.compat = { supportsReasoningEffort: true };
        return model;
      });
      console.log("==> [Pi Agent] Discovered " + mappedModels.length + " live models from rotator.");
    } else {
      // Fallback baseline if rotator is not immediately reachable
      mappedModels = [
        { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, reasoning: true },
        { id: "gemini-3-flash", name: "Gemini 3 Flash", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, reasoning: true },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text", "image"], contextWindow: 1000000, maxTokens: 64000 }
      ];
      console.log("==> [Pi Agent] Rotator unreachable during install; populated standard baseline models.");
    }

    const existing = modelsData.providers[providerID] || {};
    if (!rawModels.length && existing.models?.length) mappedModels = existing.models;
    else {
      const merged = new Map((existing.models || []).map(model => [model.id, model]));
      for (const model of mappedModels) {
        const old = merged.get(model.id) || {};
        merged.set(model.id, { ...model, ...old, ...(model.compat || old.compat ? { compat: { ...model.compat, ...old.compat } } : {}) });
      }
      mappedModels = [...merged.values()];
    }
    modelsData.providers[providerID] = {
      ...existing,
      baseUrl: baseURL,
      api: "openai-completions",
      apiKey: apiKey !== "no-key" ? apiKey : existing.apiKey || apiKey,
      models: mappedModels
    };

    fs.writeFileSync(modelsFile, JSON.stringify(modelsData, null, 2) + "\\n", "utf8");
    console.log("==> [Pi Agent] Configured successfully in " + modelsFile);
  }

  main().catch(error => { console.error(error.message); process.exitCode = 1; });
  ' "$PROVIDER_ID" "$ROTATOR_URL" "$API_KEY" "$AGENT_WORK_DIR/models.json" "$AGENT_WORK_DIR/capabilities.mjs"
else
  echo "==> [Pi Agent] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 4. Codex CLI Configuration
# -------------------------------------------------------------
CODEX_DIR="$HOME/.codex"
if should_install "codex" "$CODEX_DIR"; then
  echo ""
  echo "==> [Codex CLI] Configuring in $CODEX_DIR..."
  mkdir -p "$CODEX_DIR"

  python3 -c '
import os, sys, re

config_file = os.path.expanduser("~/.codex/config.toml")
provider_id = sys.argv[1]
provider_name = sys.argv[2]
rotator_url = sys.argv[3]

content = ""
if os.path.exists(config_file):
    with open(config_file, "r", encoding="utf-8") as f:
        content = f.read()

section_header = f"[model_providers.{provider_id}]"
block = f"""
[model_providers.{provider_id}]
name = "{provider_name}"
base_url = "{rotator_url}"
wire_api = "responses"
"""

if section_header in content:
    pattern = rf"\\[model_providers\\.{re.escape(provider_id)}\\][^\\[]*"
    content = re.sub(pattern, block.strip() + "\\n\\n", content, flags=re.DOTALL)
    print(f"==> [Codex CLI] Updated existing {section_header} in config.toml.")
else:
    content = content.rstrip() + "\\n" + block
    print(f"==> [Codex CLI] Added {section_header} to config.toml.")

with open(config_file, "w", encoding="utf-8") as f:
    f.write(content)
' "$PROVIDER_ID" "$PROVIDER_NAME" "$ROTATOR_URL"
else
  echo "==> [Codex CLI] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 5. OpenClaw Configuration
# -------------------------------------------------------------
OPENCLAW_DIR="\${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
if should_install "openclaw" "$OPENCLAW_DIR"; then
  node -e '
  const fs = require("fs"), path = require("path");
  (async () => {
    const configFile = process.env.OPENCLAW_CONFIG_PATH || path.join(process.argv[1], "openclaw.json");
    const [providerID, baseURL, apiKey, modelsFile, helper] = process.argv.slice(2);
    const { mapAgentModel } = await import(require("url").pathToFileURL(helper).href);
    const live = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    const content = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
    let config;
    try { config = content ? JSON.parse(content) : {}; }
    catch { throw new Error("Cannot safely parse OpenClaw JSON; existing configuration was preserved."); }
    config.models ||= {};
    config.models.mode ||= "merge";
    config.models.providers ||= {};
    const prior = config.models.providers[providerID] || {};
    const models = new Map((prior.models || []).map(model => [model.id, model]));
    for (const raw of live) {
      const generated = mapAgentModel(raw), old = models.get(raw.id) || {};
      models.set(raw.id, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...generated, ...old,
        ...(generated.compat || old.compat ? { compat: { ...generated.compat, ...old.compat } } : {}) });
    }
    config.models.providers[providerID] = { ...prior, baseUrl: baseURL,
      api: prior.api && prior.api !== "openai" ? prior.api : "openai-completions",
      apiKey: apiKey !== "no-key" ? apiKey : prior.apiKey || "no-key", models: [...models.values()] };
    const allowlist = config.agents?.defaults?.models;
    if (allowlist) for (const model of models.values()) allowlist[providerID + "/" + model.id] ||= {};
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    if (content) fs.copyFileSync(configFile, configFile + ".bak." + Date.now());
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\\n");
    console.log("==> [OpenClaw] Connected; choose a Codex model and use /think high (or another advertised effort).");
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
  ' "$OPENCLAW_DIR" "$PROVIDER_ID" "$ROTATOR_URL" "$API_KEY" "$AGENT_WORK_DIR/models.json" "$AGENT_WORK_DIR/capabilities.mjs"
else
  echo "==> [OpenClaw] Skipped (not selected or directory not found)."
fi

echo ""
echo "==> All target agents processed successfully!"
`;
}

/**
 * Installs configuration for one or more agents locally or over SSH.
 */
export async function installAgents(
  options: AgentInstallOptions,
): Promise<void> {
  if (!existsSync(resolve(OPENCODE_PLUGIN_SOURCE_DIR, "index.mjs"))) {
    throw new Error(
      `OpenCode plugin directory missing index.mjs at ${OPENCODE_PLUGIN_SOURCE_DIR}`,
    );
  }

  const opencodePluginFiles: Record<string, string> = {};
  for (const name of OPENCODE_PLUGIN_RUNTIME_FILES) {
    const filePath = resolve(OPENCODE_PLUGIN_SOURCE_DIR, name);
    opencodePluginFiles[name] = readFileSync(filePath, "utf8");
  }
  const rotatorUrl = (
    options.rotatorUrl ||
    process.env.TUXEVIL_ROTATOR_BASE_URL ||
    process.env.ROTATOR_URL ||
    "http://127.0.0.1:51200/v1"
  ).replace(/\/+$/, "");

  const providerId = options.providerId || "tuxevil-rotator";
  const providerName = options.providerName || "Tuxevil Rotator";
  const targets: Array<SupportedAgent | "auto" | "all"> =
    options.targets && options.targets.length > 0 ? options.targets : ["auto"];

  const script = buildCompositeInstallerScript(opencodePluginFiles, {
    targets,
    rotatorUrl,
    providerId,
    providerName,
    apiKey: options.apiKey,
  });

  if (options.dryRun) {
    console.log(
      "=== Dry Run Mode: Composite Script that would be executed ===",
    );
    console.log(script);
    return;
  }

  // Local installation
  if (
    !options.host ||
    options.host === "localhost" ||
    options.host === "127.0.0.1"
  ) {
    console.log(
      `==> Installing agent configuration locally for rotator: ${rotatorUrl}...`,
    );
    execSync("bash -s", {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
    return;
  }

  // Remote installation via SSH
  const sshTarget = options.user
    ? `${options.user}@${options.host}`
    : options.host;
  const sshArgs: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];

  if (options.port) {
    sshArgs.push("-p", String(options.port));
  }
  if (options.sshKey) {
    sshArgs.push("-i", options.sshKey);
  }

  const sshCmd = `ssh ${sshArgs.join(" ")} ${sshTarget} "bash -s"`;

  console.log(
    `==> Installing agent configuration remotely on ${sshTarget} (Rotator: ${rotatorUrl})...`,
  );
  try {
    execSync(sshCmd, {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`SSH installation failed on ${sshTarget}: ${errorMsg}`, {
      cause: err,
    });
  }
}
