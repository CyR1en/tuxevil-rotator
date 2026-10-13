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
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}
