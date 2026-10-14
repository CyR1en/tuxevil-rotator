// Model tables the compat layer reads from process-wide state: model specs,
// model-id aliases and effort routing. They come from the config, so apply
// them at startup and again whenever the config changes; otherwise an edit
// saved from the dashboard would only take effect after a restart.

import { setModelSpecsOverride } from "./compat/model-specs.js";
import type { Config } from "./types.js";
import { setEffortRoutingOverride, setModelAliasesOverride } from "./types.js";

export function applyConfigOverrides(
  config: Pick<Config, "modelSpecs" | "modelAliases" | "effortRouting">,
): void {
  setModelSpecsOverride(config.modelSpecs ?? null);
  setModelAliasesOverride(config.modelAliases ?? null);
  setEffortRoutingOverride(config.effortRouting ?? null);
}
