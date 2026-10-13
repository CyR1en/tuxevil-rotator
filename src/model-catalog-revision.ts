import { createHash } from "node:crypto";
import { getProviderOrder, isProviderTurnedOff, listCatalogModels, type ModelCatalogSource } from "./model-catalog.js";

/** A stable revision of the public catalog, independent of traffic and timers. */
export function getModelCatalogRevision(source: ModelCatalogSource): string {
  const config = source.getConfig?.();
  const state = {
    providers: getProviderOrder(source).map((id) => ({
      id,
      enabled: !isProviderTurnedOff(config, id),
      active: source.hasActiveProvider?.(id) ?? true,
    })),
    models: listCatalogModels(source),
    autoEnableNewModels: config?.autoEnableNewModels ?? true,
    effortRouting: config?.effortRouting ?? null,
    // The switch of an id no provider lists, such as an effort-routed id, is not in `models`.
    disabledModels: (config?.disabledModels ?? []).map((key) => key.trim().toLowerCase()).sort(),
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}
