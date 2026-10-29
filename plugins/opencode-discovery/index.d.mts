/**
 * Loose ambient types for plugins/opencode-discovery/index.mjs, so the repo's
 * TS tests can import the untyped module without pull-in of @opencode/plugin.
 */

export interface ProviderEntry {
  id?: string;
  providerID?: string;
  name?: string | null;
  baseURL?: string | null;
  info?: {
    id?: string;
    name?: string;
    settings?: { baseURL?: string };
  };
  provider?: {
    id?: string;
    name?: string;
    settings?: { baseURL?: string };
  };
  settings?: { baseURL?: string };
  options?: { baseURL?: string };
}

export interface ResolvedOptions {
  baseURL: string;
  providerID: string;
  providerName: string;
  timeoutMs: number;
  refreshMs: number;
}

export interface RawRotatorModel {
  id: string;
  meta?: Record<string, unknown>;
  info?: Record<string, unknown>;
  context_window?: number;
  max_model_len?: number;
}

export interface ModelDef {
  name: string;
  limit: { context: number; output: number };
  capabilities: { tools: boolean; input: string[]; output: string[]; reasoning?: unknown };
  variants?: Array<{ id: string; settings: { reasoningEffort: string } }>;
}

export function normalizeProviderEntries(input: unknown): ProviderEntry[];
export function resolvePluginOptions(
  options?: Record<string, unknown>,
  providerEntries?: unknown,
): ResolvedOptions;
export function fetchRotatorModels(baseURL: string, timeoutMs?: number): Promise<RawRotatorModel[]>;
export function mapModelToOpenCode(rawModel: RawRotatorModel): { id: string; modelDef: ModelDef };

const plugin: {
  id: string;
  setup(ctx: unknown): Promise<(() => void) | undefined>;
};
export default plugin;
