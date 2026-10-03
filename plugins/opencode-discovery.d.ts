export interface OpenCodePluginOptions {
  baseURL?: string;
  providerID?: string;
  providerName?: string;
  timeoutMs?: number;
}

export interface ResolvedPluginOptions {
  baseURL: string;
  providerID: string;
  providerName: string;
  timeoutMs: number;
}

export interface RawModelMeta {
  context_length?: number;
  max_output_tokens?: number;
  multimodal?: boolean;
  tool_calling?: boolean;
  [key: string]: unknown;
}

export interface RawRotatorModel {
  id: string;
  context_window?: number;
  max_model_len?: number;
  meta?: RawModelMeta;
  [key: string]: unknown;
}

export interface OpenCodeModelDef {
  name: string;
  limit: {
    context: number;
    output: number;
  };
  capabilities: {
    tools: boolean;
    input: string[];
    output: string[];
  };
  [key: string]: unknown;
}

export function resolvePluginOptions(
  config?: Record<string, any>,
  options?: OpenCodePluginOptions
): ResolvedPluginOptions;

export function mapModelToOpenCode(rawModel: RawRotatorModel): {
  id: string;
  modelDef: OpenCodeModelDef;
};

export function fetchRotatorModels(
  baseURL: string,
  timeoutMs?: number
): Promise<RawRotatorModel[]>;

export default function RotatorDiscoveryPlugin(
  input?: unknown,
  options?: OpenCodePluginOptions
): Promise<{
  config: (config: Record<string, any>) => Promise<void>;
}>;
