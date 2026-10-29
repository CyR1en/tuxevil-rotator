import type { RawRotatorModel } from "./index.mjs";
export function reasoningCapabilities(raw: RawRotatorModel): { supported: boolean; efforts: string[]; defaultEffort?: string };
export function openCodeReasoning(raw: RawRotatorModel): Record<string, unknown>;
export function openCodeVariants(raw: RawRotatorModel): Array<{ id: string; settings: { reasoningEffort: string } }>;
export function mergeOpenCodeModels(existing?: Record<string, unknown>, models?: RawRotatorModel[]): Record<string, unknown>;
export function mapAgentModel(raw: RawRotatorModel): Record<string, unknown>;
export function fetchModels(baseURL: string, apiKey?: string, timeoutMs?: number): Promise<RawRotatorModel[]>;
