// The Models page's effort routing editor and panel (src/web/lib/effort.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CatalogEffortRoute, CatalogModelEntry, ModelCatalogResponse } from "../src/dashboard-types.js";
import {
  addCustomRow,
  claudeThinkingRules,
  createEffortDraft,
  draftBody,
  draftErrorsFromServer,
  effortModelOptions,
  effortRouteRequests,
  effortRouteStatus,
  exampleRequest,
  familyForAlias,
  fillFamily,
  hasDraftErrors,
  isDraftDirty,
  previewEffortDraft,
  removeRow,
  setDefaultRow,
  setDraftAlias,
  setRowLevel,
  setRowModel,
  validateEffortDraft,
} from "../src/web/lib/effort.js";
import { buildModelRows, filterModelRows } from "../src/web/lib/models.js";

const entry = (providerId: string, id: string, extra: Partial<CatalogModelEntry> = {}): CatalogModelEntry => ({
  providerId,
  id,
  contextWindow: 1_048_576,
  quotaPool: "gemini",
  source: "catalog",
  offReason: null,
  modelSwitch: "on",
  routed: true,
  ...extra,
});

const MODELS = [
  entry("google-antigravity", "gemini-3.8-flash-low"),
  entry("google-antigravity", "gemini-3.8-flash-medium"),
  entry("google-antigravity", "gemini-3.8-flash-high"),
  entry("google-antigravity", "gemini-3.1-pro-low", { offReason: "model", modelSwitch: "off" }),
  entry("google-antigravity", "gemini-3.1-pro-high"),
  entry("google-antigravity", "gemini-3-flash"),
  entry("ollama", "glm-5.1", { quotaPool: "monthly" }),
];

function route(extra: Partial<CatalogEffortRoute> = {}): CatalogEffortRoute {
  return {
    alias: "gemini-3.8-flash",
    defaultEffort: "medium",
    targets: [
      { effort: "low", model: "gemini-3.8-flash-low", known: true, served: true },
      { effort: "medium", model: "gemini-3.8-flash-medium", known: true, served: true },
      { effort: "high", model: "gemini-3.8-flash-high", known: true, served: true },
    ],
    enabled: true,
    listed: true,
    shadowedBy: null,
    status: "live",
    ...extra,
  };
}

const catalog = (routes: CatalogEffortRoute[] = []): ModelCatalogResponse => ({
  ok: true,
  providers: [
    { id: "ollama", name: "Ollama Cloud", credentialKind: "api-key", enabled: true },
    { id: "google-antigravity", name: "Google Antigravity", credentialKind: "oauth", enabled: true },
  ],
  models: MODELS,
  autoEnableNewModels: true,
  effortRoutes: routes,
  effortSuggestions: [
    {
      alias: "gemini-3.1-pro",
      targets: [
        { effort: "low", model: "gemini-3.1-pro-low" },
        { effort: "high", model: "gemini-3.1-pro-high" },
      ],
    },
  ],
});

const NAMES = { ollama: "Ollama Cloud", "google-antigravity": "Google Antigravity" };
const row = (draft: ReturnType<typeof createEffortDraft>, level: string) => draft.rows.find((entry) => entry.level === level)!;

describe("effort routing editor", () => {
  it("lays out every standard level, then custom levels, and picks medium as the default", () => {
    const draft = createEffortDraft(route(), "gemini-3.8-flash");
    assert.deepEqual(draft.rows.map((entry) => entry.level), ["minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(draft.defaultRowId, "level:medium");
    const custom = createEffortDraft({ alias: "x", targets: [{ effort: "Extreme", model: "gemini-3-flash" }] });
    assert.deepEqual(custom.rows.at(-1), { id: "custom:1", level: "extreme", model: "gemini-3-flash", custom: true });
    assert.equal(custom.defaultRowId, "custom:1");
  });

  it("defaults to the level closest to medium, taking the higher one on a tie", () => {
    const pro = createEffortDraft(catalog().effortSuggestions[0]);
    assert.equal(pro.defaultRowId, "level:high");
    const lowOnly = createEffortDraft({ alias: "x", targets: [{ effort: "minimal", model: "a" }, { effort: "low", model: "b" }] });
    assert.equal(lowOnly.defaultRowId, "level:low");
  });

  it("moves the default when its level loses its model, and reports where it went", () => {
    const draft = setDefaultRow(createEffortDraft(route(), "gemini-3.8-flash"), "level:high");
    const change = setRowModel(draft, "level:high", "");
    assert.equal(change.draft.defaultRowId, "level:medium");
    assert.equal(change.movedDefaultTo, "medium");
    const untouched = setRowModel(draft, "level:low", "");
    assert.equal(untouched.movedDefaultTo, null);
    const removed = removeRow(createEffortDraft({ alias: "x", targets: [{ effort: "extreme", model: "gemini-3-flash" }, { effort: "high", model: "b" }] }), "custom:1");
    assert.equal(removed.draft.defaultRowId, "level:high");
  });

  it("builds the request body with lower-case levels in standard order", () => {
    let draft = createEffortDraft(null);
    draft = setDraftAlias(draft, "  my-flash ");
    draft = setRowModel(draft, "level:high", "gemini-3.8-flash-high").draft;
    draft = setRowModel(draft, "level:low", "gemini-3.8-flash-low").draft;
    const added = addCustomRow(draft);
    draft = setRowLevel(setRowModel(added.draft, added.rowId, "gemini-3-flash").draft, added.rowId, "Turbo").draft;
    assert.deepEqual(draftBody(draft), {
      alias: "my-flash",
      defaultEffort: "high",
      targets: { low: "gemini-3.8-flash-low", high: "gemini-3.8-flash-high", turbo: "gemini-3-flash" },
    });
  });

  it("counts unfinished custom levels as unsaved changes", () => {
    const saved = createEffortDraft(route(), "gemini-3.8-flash");
    assert.equal(isDraftDirty(saved, saved), false);
    assert.equal(isDraftDirty(addCustomRow(saved).draft, saved), true);
    assert.equal(isDraftDirty(setDefaultRow(saved, "level:low"), saved), true);
    assert.equal(isDraftDirty(saved, null), true);
  });

  it("checks the ID and levels, and shows typing mistakes right away", () => {
    const state = catalog([route()]);
    const blank = validateEffortDraft(createEffortDraft(null), state, NAMES);
    assert.equal(blank.alias?.live, false);
    assert.match(blank.form ?? "", /at least one effort level/);

    const taken = validateEffortDraft(setDraftAlias(createEffortDraft(null), "glm-5.1"), state, NAMES);
    assert.equal(taken.alias?.message, "glm-5.1 is already a model from Ollama Cloud. Pick an ID that isn't in use.");
    assert.equal(taken.alias?.live, true);
    const duplicate = validateEffortDraft(setDraftAlias(createEffortDraft(null), "GEMINI-3.8-FLASH"), state, NAMES);
    assert.match(duplicate.alias?.message ?? "", /Another effort model already uses/);
    const own = validateEffortDraft(createEffortDraft(route(), "gemini-3.8-flash"), state, NAMES);
    assert.equal(hasDraftErrors(own), false);

    const added = addCustomRow(createEffortDraft(route(), "gemini-3.8-flash"));
    const unnamed = validateEffortDraft(added.draft, state, NAMES);
    assert.equal(unnamed.rows[added.rowId].live, false);
    const clash = validateEffortDraft(setRowLevel(added.draft, added.rowId, "HIGH").draft, state, NAMES);
    assert.equal(clash.rows[added.rowId].message, "There's already a high level.");
    assert.equal(clash.rows[added.rowId].live, true);
  });

  it("flags auto, . and .. as soon as they're typed", () => {
    const state = catalog([route()]);
    const typed = (alias: string) => validateEffortDraft(setDraftAlias(createEffortDraft(null), alias), state, NAMES).alias;
    assert.deepEqual(typed("AUTO"), { message: "AUTO is reserved for automatic model selection. Pick another ID.", live: true });
    assert.deepEqual(typed("."), { message: "“.” can't be a model ID. Pick another one.", live: true });
    assert.deepEqual(typed(".."), { message: "“..” can't be a model ID. Pick another one.", live: true });
    assert.equal(typed("auto-flash"), null);
  });

  it("puts a refused save's field errors beside their fields", () => {
    const draft = createEffortDraft(route(), "gemini-3.8-flash");
    const errors = draftErrorsFromServer(draft, {
      alias: "Taken.",
      "targets.high": "gemini-3.8-flash-high isn't a Google Antigravity model.",
      defaultEffort: "The default level x has no model.",
    });
    assert.equal(errors.alias?.message, "Taken.");
    assert.equal(errors.rows["level:high"].message, "gemini-3.8-flash-high isn't a Google Antigravity model.");
    assert.equal(errors.form, "The default level x has no model.");
  });

  it("offers a suggested family's variants for its ID and fills them in", () => {
    const state = catalog();
    const draft = setDraftAlias(createEffortDraft(null), "Gemini-3.1-Pro");
    const family = familyForAlias(draft, state.effortSuggestions);
    assert.equal(family?.alias, "gemini-3.1-pro");
    const filled = fillFamily(draft, family!);
    assert.equal(row(filled, "low").model, "gemini-3.1-pro-low");
    assert.equal(filled.defaultRowId, "level:high");
    assert.equal(familyForAlias(filled, state.effortSuggestions), null);

    const options = effortModelOptions(state, "gemini-3.8-flash");
    assert.deepEqual(options.variants.map((model) => model.id), ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]);
    assert.ok(!options.others.some((model) => model.providerId !== "google-antigravity"));
  });

  it("previews where each request goes, including models that are off", () => {
    const draft = createEffortDraft({ alias: "gemini-3.1-pro", targets: catalog().effortSuggestions[0].targets });
    const preview = previewEffortDraft(draft, catalog());
    assert.deepEqual(preview.levels, [
      { level: "low", model: "gemini-3.1-pro-low", served: false },
      { level: "high", model: "gemini-3.1-pro-high", served: true },
    ]);
    assert.deepEqual(preview.fallback, { level: "high", model: "gemini-3.1-pro-high", served: true });
    assert.equal(preview.unmappedExample, "minimal");
  });

  it("writes example requests and the Claude thinking rules", () => {
    assert.match(exampleRequest("chat", "flash", "high"), /"reasoning_effort": "high"/);
    assert.match(exampleRequest("responses", "flash", "low"), /"reasoning": \{ "effort": "low" \}/);
    assert.match(exampleRequest("messages", "", "max"), /"model": "your-model-id"[\s\S]*"output_config": \{ "effort": "max" \}/);
    assert.deepEqual(claudeThinkingRules(), [
      { when: "budget_tokens under 4,000", level: "low" },
      { when: "budget_tokens 4,000 to 15,999", level: "medium" },
      { when: "budget_tokens 16,000 or more", level: "high" },
      { when: "thinking turned off", level: "low" },
    ]);
  });
});

describe("effort routing panel", () => {
  it("names each route's state in words", () => {
    assert.deepEqual(effortRouteStatus(route()), { label: "Live", tone: "ok", detail: "Listed in /v1/models" });
    const partial = route({
      status: "partial",
      targets: route().targets.map((target) => (target.effort === "high" ? { ...target, served: false } : target)),
    });
    assert.deepEqual(effortRouteStatus(partial), { label: "high is off", tone: "warn", detail: "high requests get a 404" });
    assert.equal(effortRouteStatus(route({ status: "hidden", shadowedBy: "ollama" }), NAMES).detail, "Ollama Cloud serves this ID instead");
    assert.equal(effortRouteStatus(route({ status: "hidden" })).detail, "Default model is off");
    assert.equal(effortRouteStatus(route({ status: "off", enabled: false })).label, "Off");
    assert.equal(effortRouteStatus(route({ status: "provider-off" })).detail, "Google Antigravity is off");
  });

  it("counts last-hour requests under the variants that served them", () => {
    assert.equal(effortRouteRequests(route(), { "gemini-3.8-flash-high": 5, "GEMINI-3.8-FLASH-LOW": 2, "gemini-3-flash": 9 }), 7);
  });

  it("tags the models an effort route uses and filters to them", () => {
    const state = catalog([route()]);
    state.models = state.models.map((model) =>
      model.id.startsWith("gemini-3.8-flash-") ? { ...model, effortRoute: { alias: "gemini-3.8-flash", effort: model.id.split("-").at(-1)! } } : model,
    );
    const rows = buildModelRows(state, {});
    assert.deepEqual(rows.find((entry) => entry.id === "gemini-3.8-flash-high")?.effortRoute, { alias: "gemini-3.8-flash", effort: "high" });
    assert.equal(rows.find((entry) => entry.id === "gemini-3-flash")?.effortRoute, null);
    assert.deepEqual(
      filterModelRows(rows, { filter: "effort", provider: "", query: "" }).map((entry) => entry.id),
      ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"],
    );
  });
});
