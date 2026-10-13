// Effort routing as the dashboard's Models page sees it: which effort-routed
// model IDs exist and whether clients can use them, which model families
// could become one, and edits checked so the stored config always loads.
//
// Each planner returns a config patch instead of saving it, so the rotator
// and test stubs apply edits the same way as the other Models page switches.

import type {
  CatalogEffortRoute,
  CatalogEffortSuggestion,
  CatalogEffortTarget,
  EffortRouteStatus,
} from "./dashboard-types.js";
import { EFFORT_LEVELS, orderEffortLevels } from "./effort-levels.js";
import {
  isProviderTurnedOff,
  isRequestOff,
  listCatalogModels,
  modelKey,
  resolveModelRoute,
  type ModelCatalogSource,
} from "./model-catalog.js";
import { getProviderAdapter, isKnownProvider } from "./providers/registry.js";
import type { Config, EffortRoutingRule } from "./types.js";
import { applyModelAlias } from "./types.js";
import { validateConfig } from "./validators.js";

const ANTIGRAVITY = "google-antigravity";
const EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORT_LEVELS.join("|")})$`, "i");

const fold = (value: string) => value.trim().toLowerCase();

function providerName(providerId: string): string {
  return isKnownProvider(providerId) ? getProviderAdapter(providerId).displayName : providerId;
}

function antigravityModels(source: ModelCatalogSource) {
  return listCatalogModels(source).filter((model) => model.providerId === ANTIGRAVITY);
}

/** Targets with lower-cased levels, standard levels first. */
function orderedTargets(rule: EffortRoutingRule): Array<{ effort: string; model: string }> {
  const byLevel = new Map<string, string>();
  for (const [level, model] of Object.entries(rule.targets ?? {})) {
    if (typeof model === "string") byLevel.set(fold(level), model.trim());
  }
  return orderEffortLevels(byLevel.keys()).map((effort) => ({ effort, model: byLevel.get(effort)! }));
}

/** The key that turns an effort-routed ID off, as the Models page switches store it. */
export function effortRouteKey(alias: string): string {
  return modelKey(ANTIGRAVITY, alias);
}

/**
 * Configured effort routes with what clients get from each. `isListed` says
 * whether /v1/models shows the ID; the caller passes it so the answer comes
 * from the same code that builds that list.
 */
export function describeEffortRoutes(
  source: ModelCatalogSource,
  isListed: (alias: string) => boolean,
): CatalogEffortRoute[] {
  const config = source.getConfig?.();
  const rules = config?.effortRouting ?? {};
  const known = new Set(antigravityModels(source).map((model) => fold(model.id)));
  const disabled = new Set((config?.disabledModels ?? []).map(fold));
  const providerOff = isProviderTurnedOff(config, ANTIGRAVITY);

  return Object.entries(rules).map(([rawAlias, rule]) => {
    const alias = rawAlias.trim();
    const targets: CatalogEffortTarget[] = orderedTargets(rule).map(({ effort, model }) => ({
      effort,
      model,
      known: known.has(fold(model)),
      served:
        known.has(fold(model)) &&
        !isRequestOff(source, { catalogModel: model, model: applyModelAlias(model), providerId: ANTIGRAVITY }),
    }));
    const route = resolveModelRoute(source, alias);
    const shadowedBy = route.kind === "provider" && route.providerId !== ANTIGRAVITY ? route.providerId : null;
    const enabled = !disabled.has(fold(effortRouteKey(alias)));
    // When another provider owns the ID, /v1/models lists that provider's model instead.
    const listed = shadowedBy === null && isListed(alias);
    let status: EffortRouteStatus = "live";
    if (providerOff) status = "provider-off";
    else if (!enabled) status = "off";
    else if (!listed) status = "hidden";
    else if (targets.some((target) => !target.served)) status = "partial";
    return {
      alias,
      defaultEffort: fold(rule.defaultEffort || "medium"),
      targets,
      enabled,
      listed,
      shadowedBy,
      status,
    };
  });
}

/** Lower-cased target id to the effort route and level that use it. */
export function effortRouteTargets(config: Partial<Config> | undefined): Map<string, { alias: string; effort: string }> {
  const out = new Map<string, { alias: string; effort: string }>();
  for (const [alias, rule] of Object.entries(config?.effortRouting ?? {})) {
    for (const { effort, model } of orderedTargets(rule)) {
      const key = fold(model);
      if (!out.has(key)) out.set(key, { alias: alias.trim(), effort });
    }
  }
  return out;
}

/**
 * Why `alias` cannot name an effort route, or null when it is free. A route
 * keeping its current name skips the model checks, so a route older configs
 * allowed to share a model's ID can still be edited.
 */
function aliasConflict(source: ModelCatalogSource, alias: string, previousAlias: string | null): string | null {
  const config = source.getConfig?.();
  const wanted = fold(alias);
  const others = Object.keys(config?.effortRouting ?? {}).filter(
    (key) => previousAlias === null || fold(key) !== fold(previousAlias),
  );
  if (others.some((key) => fold(key) === wanted)) return `Another effort model already uses ${alias}.`;
  if (previousAlias !== null && fold(previousAlias) === wanted) return null;
  const listed = listCatalogModels(source).find((model) => fold(model.id) === wanted);
  if (listed) return `${listed.id} is already a model from ${providerName(listed.providerId)}. Pick an ID that isn't in use.`;
  if (fold(applyModelAlias(alias)) !== wanted) {
    return `${alias} is already a model alias for ${applyModelAlias(alias)}. Pick an ID that isn't in use.`;
  }
  return null;
}

/**
 * Antigravity model families with at least two effort-suffixed variants
 * (`gemini-3.8-flash-low`, `-medium`, `-high`) that no effort route uses yet
 * and whose base ID is free to become one.
 */
export function suggestEffortRoutes(source: ModelCatalogSource): CatalogEffortSuggestion[] {
  const config = source.getConfig?.();
  const used = effortRouteTargets(config);
  const families = new Map<string, { alias: string; targets: Map<string, string> }>();
  for (const model of antigravityModels(source)) {
    const hit = EFFORT_SUFFIX.exec(model.id.trim());
    if (!hit) continue;
    const base = hit[1];
    const family = families.get(fold(base)) ?? { alias: base, targets: new Map<string, string>() };
    const level = hit[2].toLowerCase();
    if (!family.targets.has(level)) family.targets.set(level, model.id);
    families.set(fold(base), family);
  }
  return [...families.values()]
    .filter(
      (family) =>
        family.targets.size >= 2 &&
        ![...family.targets.values()].some((id) => used.has(fold(id))) &&
        aliasConflict(source, family.alias, null) === null,
    )
    .map((family) => ({
      alias: family.alias,
      targets: orderEffortLevels(family.targets.keys()).map((effort) => ({ effort, model: family.targets.get(effort)! })),
    }));
}

export type EffortRoutePlan =
  | { ok: true; alias: string; patch: Partial<Config> }
  | { ok: false; status: 400 | 404; error: string; fieldErrors?: Record<string, string> };

function findAlias(config: Partial<Config> | undefined, alias: string): string | null {
  return Object.keys(config?.effortRouting ?? {}).find((key) => fold(key) === fold(alias)) ?? null;
}

/** Replaces one "<provider>/<model>" entry (any case) in a switch list, or drops it when `next` is null. */
function renameKey(list: string[] | undefined, previous: string, next: string | null): string[] | undefined {
  if (!list) return list;
  const wanted = fold(previous);
  if (!list.some((key) => fold(key) === wanted)) return list;
  const out = list.filter((key) => fold(key) !== wanted);
  return next === null ? out : [...out, next];
}

function invalid(error: string, fieldErrors?: Record<string, string>): EffortRoutePlan {
  return { ok: false, status: 400, error, ...(fieldErrors ? { fieldErrors } : {}) };
}

/**
 * Plans creating (`previousAlias` null) or replacing an effort route from a
 * request body `{ alias, defaultEffort, targets: { <level>: <model> } }`. On
 * replace, `alias` may be omitted to keep the name, or changed to rename the
 * route; its switch moves with it.
 */
export function planEffortRouteSave(
  source: ModelCatalogSource,
  previousAlias: string | null,
  body: unknown,
): EffortRoutePlan {
  const config = source.getConfig?.() ?? ({ accounts: [] } as unknown as Config);
  const existing = previousAlias === null ? null : findAlias(config, previousAlias);
  if (previousAlias !== null && existing === null) {
    return { ok: false, status: 404, error: `No effort model is called ${previousAlias}` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid('Send { "alias": "<model id>", "defaultEffort": "<level>", "targets": { "<level>": "<model id>" } }');
  }
  const input = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const rawAlias = input.alias === undefined && existing !== null ? existing : input.alias;
  const alias = typeof rawAlias === "string" ? rawAlias.trim() : "";
  if (!alias) fieldErrors.alias = "Enter the model ID clients will call.";
  else if (/\s/.test(alias)) fieldErrors.alias = "Model IDs can't contain spaces.";
  else {
    const conflict = aliasConflict(source, alias, existing);
    if (conflict) fieldErrors.alias = conflict;
  }

  const catalog = new Map(antigravityModels(source).map((model) => [fold(model.id), model.id]));
  const targets: Record<string, string> = {};
  if (!input.targets || typeof input.targets !== "object" || Array.isArray(input.targets)) {
    fieldErrors.targets = "Choose a model for at least one effort level.";
  } else {
    for (const [rawLevel, rawModel] of Object.entries(input.targets as Record<string, unknown>)) {
      const level = fold(rawLevel);
      const field = `targets.${level || rawLevel}`;
      if (!level) {
        fieldErrors[field] = "Name this level.";
        continue;
      }
      if (/\s/.test(level)) {
        fieldErrors[field] = "Level names can't contain spaces.";
        continue;
      }
      if (Object.hasOwn(targets, level)) {
        fieldErrors[field] = `There's already a ${level} level.`;
        continue;
      }
      const model = typeof rawModel === "string" ? catalog.get(fold(rawModel)) : undefined;
      if (!model) {
        fieldErrors[field] = typeof rawModel === "string" && rawModel.trim()
          ? `${rawModel.trim()} isn't a Google Antigravity model.`
          : "Choose a model for this level.";
        continue;
      }
      targets[level] = model;
    }
    if (Object.keys(targets).length === 0 && !Object.keys(fieldErrors).some((key) => key.startsWith("targets"))) {
      fieldErrors.targets = "Choose a model for at least one effort level.";
    }
  }

  // A default whose own target is refused is already reported on that target.
  const defaultEffort = typeof input.defaultEffort === "string" ? fold(input.defaultEffort) : "";
  const levels = new Set(
    input.targets && typeof input.targets === "object" ? Object.keys(input.targets).map(fold) : [],
  );
  if (!defaultEffort) fieldErrors.defaultEffort = "Pick the level requests without an effort use.";
  else if (!levels.has(defaultEffort)) fieldErrors.defaultEffort = `The default level ${defaultEffort} has no model.`;

  const problems = Object.values(fieldErrors);
  if (problems.length > 0) return invalid(problems.join(" "), fieldErrors);

  const rule: EffortRoutingRule = {
    defaultEffort,
    targets: Object.fromEntries(orderEffortLevels(Object.keys(targets)).map((level) => [level, targets[level]])),
  };
  // Replace in place so the routes keep their order in the config file.
  const entries = Object.entries(config.effortRouting ?? {});
  const at = existing === null ? -1 : entries.findIndex(([key]) => key === existing);
  if (at >= 0) entries[at] = [alias, rule];
  else entries.push([alias, rule]);
  const effortRouting = Object.fromEntries(entries);

  const patch: Partial<Config> = { effortRouting };
  if (existing !== null && existing !== alias) {
    patch.disabledModels = renameKey(config.disabledModels, effortRouteKey(existing), effortRouteKey(alias));
    patch.reviewedModels = renameKey(config.reviewedModels, effortRouteKey(existing), effortRouteKey(alias));
  }

  // The stored config must keep loading: run the same checks startup does.
  const check = validateConfig({ accounts: [], modelAliases: config.modelAliases, effortRouting });
  if (!check.ok) return invalid(check.errors.join("; "));
  return { ok: true, alias, patch };
}

/** Plans removing an effort route and its switch. */
export function planEffortRouteDelete(config: Partial<Config> | undefined, alias: string): EffortRoutePlan {
  const existing = findAlias(config, alias);
  if (existing === null) return { ok: false, status: 404, error: `No effort model is called ${alias}` };
  const rest = Object.entries(config?.effortRouting ?? {}).filter(([key]) => key !== existing);
  return {
    ok: true,
    alias: existing,
    patch: {
      effortRouting: rest.length > 0 ? Object.fromEntries(rest) : undefined,
      disabledModels: renameKey(config?.disabledModels, effortRouteKey(existing), null),
      reviewedModels: renameKey(config?.reviewedModels, effortRouteKey(existing), null),
    },
  };
}
