/**
 * OpenCode Model Discovery Plugin for tuxevil-rotator
 *
 * Automatically fetches the active model list from a tuxevil-rotator instance
 * (or any compatible endpoint) and injects the models with their limits and capabilities
 * into the OpenCode configuration at startup.
 */

/**
 * Resolves the configuration options for the discovery plugin.
 * Precedence:
 * 1. Explicit plugin options passed in opencode.json
 * 2. Environment variables (TUXEVIL_ROTATOR_BASE_URL, ROTATOR_URL)
 * 3. Existing provider with baseURL matching rotator port or localhost in config
 * 4. Default: http://127.0.0.1:51200/v1
 */
export function resolvePluginOptions(config = {}, options = {}) {
  const envBaseURL = process.env.TUXEVIL_ROTATOR_BASE_URL || process.env.ROTATOR_URL;

  let discoveredBaseURL = options.baseURL || envBaseURL;
  let providerID = options.providerID;
  let providerName = options.providerName;

  if (!discoveredBaseURL && config.provider) {
    for (const [id, prov] of Object.entries(config.provider)) {
      const url = prov?.options?.baseURL;
      if (typeof url === "string" && (url.includes("51200") || url.includes("rotator") || url.includes("antigravity"))) {
        discoveredBaseURL = url;
        if (!providerID) providerID = id;
        if (!providerName && prov.name) providerName = prov.name;
        break;
      }
    }
  }

  if (!discoveredBaseURL) {
    discoveredBaseURL = "http://127.0.0.1:51200/v1";
  }

  // Normalize baseURL (remove trailing slashes)
  discoveredBaseURL = discoveredBaseURL.replace(/\/+$/, "");

  if (!providerID) {
    providerID = options.providerID || "antigravity";
  }

  if (!providerName) {
    providerName = options.providerName || "Antigravity (rotator)";
  }

  const timeoutMs = Number(options.timeoutMs) || 3500;

  return {
    baseURL: discoveredBaseURL,
    providerID,
    providerName,
    timeoutMs,
  };
}

/**
 * Maps raw model object from rotator /v1/models to OpenCode model definition.
 */
export function mapModelToOpenCode(rawModel) {
  const id = rawModel.id;
  const meta = rawModel.meta || {};

  const contextLimit = Number(meta.context_length) || Number(rawModel.context_window) || Number(rawModel.max_model_len) || 128000;
  const outputLimit = Number(meta.max_output_tokens) || 8192;

  const isMultimodal = Boolean(meta.multimodal);
  const toolCalling = meta.tool_calling !== false;

  const modelDef = {
    name: id,
    limit: {
      context: contextLimit,
      output: outputLimit,
    },
    capabilities: {
      tools: toolCalling,
      input: isMultimodal ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };

  return { id, modelDef };
}

/**
 * Fetches available models from the target rotator endpoint.
 */
export async function fetchRotatorModels(baseURL, timeoutMs = 3500) {
  const modelsUrl = `${baseURL}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(modelsUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Endpoint returned status ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    if (!json || !Array.isArray(json.data)) {
      throw new Error("Invalid response format: 'data' array not found");
    }

    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenCode Plugin Entrypoint
 */
export default async function RotatorDiscoveryPlugin(_input, options = {}) {
  return {
    config: async (config) => {
      try {
        const resolved = resolvePluginOptions(config, options);
        const rawModels = await fetchRotatorModels(resolved.baseURL, resolved.timeoutMs);

        if (!config.provider) {
          config.provider = {};
        }

        const existingProvider = config.provider[resolved.providerID] || {};
        const models = { ...(existingProvider.models || {}) };

        for (const raw of rawModels) {
          if (!raw || !raw.id) continue;
          const { id, modelDef } = mapModelToOpenCode(raw);
          // Preserve any user-customized options or limits while merging capabilities
          models[id] = {
            ...modelDef,
            ...(models[id] || {}),
            capabilities: {
              ...modelDef.capabilities,
              ...(models[id]?.capabilities || {}),
            },
            limit: {
              ...modelDef.limit,
              ...(models[id]?.limit || {}),
            },
          };
        }

        config.provider[resolved.providerID] = {
          npm: "@ai-sdk/openai-compatible",
          name: resolved.providerName,
          ...existingProvider,
          options: {
            baseURL: resolved.baseURL,
            ...(existingProvider.options || {}),
          },
          models,
        };
      } catch (err) {
        // Safe degrade: do not fail OpenCode startup if rotator is unreachable
        if (process.env.DEBUG || process.env.NODE_ENV === "development") {
          console.warn("[rotator-discovery-plugin] Could not auto-discover models:", err?.message || err);
        }
      }
    },
  };
}
