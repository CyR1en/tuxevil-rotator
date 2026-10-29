// Model capability translation shared by discovery and standalone installers.
// Scalar API efforts only: harness modes such as "ultra" are not wire values.
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
export function reasoningCapabilities(raw) {
  const meta = raw.meta || raw.info || {}
  const supported = Boolean(meta.reasoning ?? meta.thinking)
  const efforts = supported && Array.isArray(meta.reasoning_efforts)
    ? [...new Set(meta.reasoning_efforts.filter(value => EFFORTS.has(value)))] : []
  return { supported, efforts, defaultEffort: efforts.includes(meta.default_reasoning_effort) ? meta.default_reasoning_effort : undefined }
}
export function openCodeReasoning(raw) {
  const { supported, efforts } = reasoningCapabilities(raw)
  if (!supported) return {}
  return { reasoning: { supported: true, ...(efforts.length ? { effort: efforts.filter(e => e !== "none"), ...(efforts.includes("none") ? { toggle: true } : {}) } : {}) } }
}
export function openCodeVariants(raw) {
  return reasoningCapabilities(raw).efforts.map(effort => ({ id: effort, settings: { reasoningEffort: effort } }))
}
/** Legacy OpenCode config is migrated by V2; keep user options/variants authoritative. */
export function mergeOpenCodeModels(existing = {}, rawModels = []) {
  const merged = { ...existing }
  for (const raw of rawModels) {
    const meta = raw.meta || {}
    const prior = merged[raw.id] || {}
    const reasoning = reasoningCapabilities(raw)
    const variants = Object.fromEntries(reasoning.efforts.map(effort => [effort, { reasoningEffort: effort }]))
    merged[raw.id] = { name: raw.id, ...prior,
      limit: { context: meta.context_length || raw.context_window || 128000, output: meta.max_output_tokens || 8192, ...prior.limit },
      ...(reasoning.supported && prior.reasoning === undefined ? { reasoning: true } : {}),
      ...(reasoning.efforts.length ? { variants: { ...variants, ...prior.variants } } : {}),
    }
  }
  return merged
}
export function mapAgentModel(raw) {
  const meta = raw.meta || {}
  const reasoning = reasoningCapabilities(raw)
  return { id: raw.id, name: raw.name || raw.id, reasoning: reasoning.supported,
    input: meta.multimodal ? ["text", "image"] : ["text"],
    contextWindow: meta.context_length || raw.context_window || 128000,
    maxTokens: meta.max_output_tokens || 8192,
    ...(reasoning.efforts.length ? { compat: { supportsReasoningEffort: true, supportedReasoningEfforts: reasoning.efforts } } : {}),
  }
}
export async function fetchModels(baseURL, apiKey, timeoutMs = 3500) {
  const response = await fetch(baseURL.replace(/\/+$/, "") + "/models", {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", ...(apiKey && apiKey !== "no-key" ? { Authorization: `Bearer ${apiKey}` } : {}) },
  })
  if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body.data)) throw new Error("Invalid model catalog")
  return body.data.filter(model => typeof model?.id === "string" && model.id.length > 0)
}
