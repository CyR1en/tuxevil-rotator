// Effort routing on the Models page: the editor's draft and its checks, how a
// route reads in the panel, and where each kind of request ends up. Pure, so
// tests can drive it without a browser.

import type {
  CatalogEffortRoute,
  CatalogEffortSuggestion,
  CatalogModelEntry,
  ModelCatalogResponse,
} from "../../dashboard-types.js";
import {
  CLAUDE_THINKING_BUDGET_EFFORTS,
  CLAUDE_THINKING_DISABLED_EFFORT,
  EFFORT_LEVELS,
  orderEffortLevels,
} from "../../effort-levels.js";
import type { Tone } from "./status.js";

export { EFFORT_LEVELS };

const ANTIGRAVITY = "google-antigravity";
const fold = (value: string) => value.trim().toLowerCase();

/** "a", "a and b", "a, b and c". */
export function joinWords(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ── Panel ───────────────────────────────────────────────────────────────

export function routeTargetsByLevel(route: Pick<CatalogEffortRoute, "targets">): Record<string, string> {
  return Object.fromEntries(route.targets.map((target) => [target.effort, target.model]));
}

/** Pill, tone and one-line explanation for a route's state. */
export function effortRouteStatus(
  route: CatalogEffortRoute,
  providerNames: Record<string, string> = {},
): { label: string; tone: Tone; detail: string } {
  switch (route.status) {
    case "provider-off":
      return { label: "Off", tone: "muted", detail: "Google Antigravity is off" };
    case "off":
      return { label: "Off", tone: "muted", detail: "Requests get a 404" };
    case "hidden": {
      if (route.shadowedBy) {
        return { label: "Hidden", tone: "bad", detail: `${providerNames[route.shadowedBy] ?? route.shadowedBy} serves this ID instead` };
      }
      const fallback = route.targets.find((target) => target.effort === route.defaultEffort);
      return {
        label: "Hidden",
        tone: "bad",
        detail: fallback && !fallback.known ? "Default model isn't listed" : "Default model is off",
      };
    }
    case "partial": {
      const off = route.targets.filter((target) => !target.served).map((target) => target.effort);
      return {
        label: off.length === 1 ? `${off[0]} is off` : `${off.length} levels off`,
        tone: "warn",
        detail: `${joinWords(off)} requests get a 404`,
      };
    }
    default:
      return { label: "Live", tone: "ok", detail: "Listed in /v1/models" };
  }
}

/** Requests in the last hour, counted under the variants that served them. */
export function effortRouteRequests(route: Pick<CatalogEffortRoute, "targets">, requestsByModel: Record<string, number>): number {
  const counts = new Map<string, number>();
  for (const [model, count] of Object.entries(requestsByModel)) counts.set(fold(model), (counts.get(fold(model)) ?? 0) + count);
  const models = new Set(route.targets.map((target) => fold(target.model)));
  return [...models].reduce((sum, model) => sum + (counts.get(model) ?? 0), 0);
}

// ── Editor draft ────────────────────────────────────────────────────────

export interface EffortDraftRow {
  /** Stable key: "level:<name>" for standard levels, "custom:<n>" for added ones. */
  id: string;
  level: string;
  /** Model id, or "" while the level is not used. */
  model: string;
  custom: boolean;
}

export interface EffortDraft {
  /** The saved alias being edited, or null while creating one. */
  original: string | null;
  alias: string;
  /** Every standard level, then custom levels in the order added. */
  rows: EffortDraftRow[];
  /** Row whose level requests without a usable effort get. */
  defaultRowId: string | null;
  nextCustomId: number;
}

const isMapped = (row: EffortDraftRow) => Boolean(row.model) && Boolean(row.level.trim());

/**
 * Prefer medium, then the mapped level closest to `nearIndex` (medium's place
 * by default), taking the higher one on a tie.
 */
export function pickDefaultRow(rows: EffortDraftRow[], nearIndex = EFFORT_LEVELS.indexOf("medium")): EffortDraftRow | null {
  const mapped = rows.filter(isMapped);
  if (mapped.length === 0) return null;
  const medium = mapped.find((row) => fold(row.level) === "medium");
  if (medium) return medium;
  return mapped.reduce((best, row) => {
    const distance = Math.abs(rows.indexOf(row) - nearIndex);
    const bestDistance = Math.abs(rows.indexOf(best) - nearIndex);
    return distance < bestDistance || (distance === bestDistance && rows.indexOf(row) > rows.indexOf(best)) ? row : best;
  });
}

/** A draft for a saved route, a suggested family, or (with no source) a blank route. */
export function createEffortDraft(
  source: { alias: string; defaultEffort?: string; targets: Array<{ effort: string; model: string }> } | null,
  original: string | null = null,
): EffortDraft {
  const rows: EffortDraftRow[] = EFFORT_LEVELS.map((level) => ({ id: `level:${level}`, level, model: "", custom: false }));
  let nextCustomId = 1;
  for (const target of source?.targets ?? []) {
    const level = fold(target.effort);
    let row = rows.find((entry) => !entry.custom && entry.level === level);
    if (!row) {
      row = { id: `custom:${nextCustomId++}`, level, model: "", custom: true };
      rows.push(row);
    }
    row.model = target.model;
  }
  const preferred = rows.find((row) => isMapped(row) && row.level === fold(source?.defaultEffort ?? ""));
  return {
    original,
    alias: source?.alias ?? "",
    rows,
    defaultRowId: (preferred ?? pickDefaultRow(rows))?.id ?? null,
    nextCustomId,
  };
}

export function draftTargets(draft: EffortDraft): Record<string, string> {
  const mapped = draft.rows.filter(isMapped);
  const byLevel = new Map(mapped.map((row) => [fold(row.level), row.model]));
  return Object.fromEntries(orderEffortLevels(byLevel.keys()).map((level) => [level, byLevel.get(level)!]));
}

export function draftDefaultRow(draft: EffortDraft): EffortDraftRow | null {
  const row = draft.rows.find((entry) => entry.id === draft.defaultRowId);
  return row && isMapped(row) ? row : null;
}

/** Request body for POST/PUT /api/catalog/effort-routes. */
export function draftBody(draft: EffortDraft): { alias: string; defaultEffort: string; targets: Record<string, string> } {
  return {
    alias: draft.alias.trim(),
    defaultEffort: fold(draftDefaultRow(draft)?.level ?? ""),
    targets: draftTargets(draft),
  };
}

/** Unfinished custom levels count too, so Save stays available to explain them. */
export function isDraftDirty(draft: EffortDraft, saved: EffortDraft | null): boolean {
  if (!saved) return true;
  const snapshot = (entry: EffortDraft) =>
    JSON.stringify([draftBody(entry), entry.rows.filter((row) => row.custom).map((row) => [row.level, row.model])]);
  return snapshot(draft) !== snapshot(saved);
}

export interface DraftChange {
  draft: EffortDraft;
  /** Level the default moved to, to announce it. */
  movedDefaultTo: string | null;
}

/** Keeps the default on a mapped level after rows change. */
function settleDefault(draft: EffortDraft, nearIndex?: number): DraftChange {
  if (draftDefaultRow(draft)) return { draft, movedDefaultTo: null };
  const hadDefault = draft.defaultRowId !== null;
  const next = pickDefaultRow(draft.rows, nearIndex);
  return {
    draft: { ...draft, defaultRowId: next?.id ?? null },
    movedDefaultTo: hadDefault && next ? fold(next.level) : null,
  };
}

function updateRow(draft: EffortDraft, rowId: string, patch: Partial<EffortDraftRow>): EffortDraft {
  return { ...draft, rows: draft.rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)) };
}

export function setDraftAlias(draft: EffortDraft, alias: string): EffortDraft {
  return { ...draft, alias };
}

export function setRowModel(draft: EffortDraft, rowId: string, model: string): DraftChange {
  const index = draft.rows.findIndex((row) => row.id === rowId);
  return settleDefault(updateRow(draft, rowId, { model }), index);
}

export function setRowLevel(draft: EffortDraft, rowId: string, level: string): DraftChange {
  const index = draft.rows.findIndex((row) => row.id === rowId);
  return settleDefault(updateRow(draft, rowId, { level }), index);
}

export function setDefaultRow(draft: EffortDraft, rowId: string): EffortDraft {
  return { ...draft, defaultRowId: rowId };
}

export function addCustomRow(draft: EffortDraft): { draft: EffortDraft; rowId: string } {
  const rowId = `custom:${draft.nextCustomId}`;
  return {
    rowId,
    draft: {
      ...draft,
      nextCustomId: draft.nextCustomId + 1,
      rows: [...draft.rows, { id: rowId, level: "", model: "", custom: true }],
    },
  };
}

export function removeRow(draft: EffortDraft, rowId: string): DraftChange {
  const index = draft.rows.findIndex((row) => row.id === rowId);
  return settleDefault({ ...draft, rows: draft.rows.filter((row) => row.id !== rowId) }, index);
}

/** The suggested family whose base ID the alias names, while some of its variants are unused. */
export function familyForAlias(draft: EffortDraft, suggestions: CatalogEffortSuggestion[]): CatalogEffortSuggestion | null {
  const alias = fold(draft.alias);
  if (!alias) return null;
  const family = suggestions.find((entry) => fold(entry.alias) === alias);
  if (!family) return null;
  const current = draftTargets(draft);
  return family.targets.every((target) => current[target.effort] === target.model) ? null : family;
}

/** Puts each of the family's variants on its level. */
export function fillFamily(draft: EffortDraft, family: CatalogEffortSuggestion): EffortDraft {
  let next = draft;
  for (const target of family.targets) {
    const row = next.rows.find((entry) => !entry.custom && entry.level === target.effort)
      ?? next.rows.find((entry) => fold(entry.level) === target.effort);
    if (row) next = updateRow(next, row.id, { model: target.model });
    else {
      const added = addCustomRow(next);
      next = updateRow(added.draft, added.rowId, { level: target.effort, model: target.model });
    }
  }
  return settleDefault(next).draft;
}

/** Antigravity models a level can use: the alias's own variants first. */
export function effortModelOptions(
  catalog: Pick<ModelCatalogResponse, "models">,
  alias: string,
): { variants: CatalogModelEntry[]; others: CatalogModelEntry[] } {
  const base = fold(alias);
  const models = catalog.models.filter((entry) => entry.providerId === ANTIGRAVITY);
  const variants = base ? models.filter((entry) => fold(entry.id).startsWith(`${base}-`)) : [];
  return { variants, others: models.filter((entry) => !variants.includes(entry)) };
}

// ── Checks ──────────────────────────────────────────────────────────────

export interface DraftIssue {
  message: string;
  /** Shown while typing; otherwise only after leaving the field or trying to save. */
  live: boolean;
}

export interface DraftErrors {
  alias: DraftIssue | null;
  rows: Record<string, DraftIssue>;
  form: string | null;
}

export function validateEffortDraft(
  draft: EffortDraft,
  catalog: Pick<ModelCatalogResponse, "models" | "effortRoutes">,
  providerNames: Record<string, string> = {},
): DraftErrors {
  const errors: DraftErrors = { alias: null, rows: {}, form: null };
  const alias = draft.alias.trim();
  const keepsName = draft.original !== null && fold(draft.original) === fold(alias);
  if (!alias) errors.alias = { message: "Enter the model ID clients will call.", live: false };
  else if (/\s/.test(alias)) errors.alias = { message: "Model IDs can't contain spaces.", live: true };
  else if (catalog.effortRoutes.some((route) => fold(route.alias) === fold(alias) && route.alias !== draft.original)) {
    errors.alias = { message: `Another effort model already uses ${alias}.`, live: true };
  } else if (!keepsName) {
    const taken = catalog.models.find((entry) => fold(entry.id) === fold(alias));
    if (taken) {
      errors.alias = {
        message: `${taken.id} is already a model from ${providerNames[taken.providerId] ?? taken.providerId}. Pick an ID that isn't in use.`,
        live: true,
      };
    }
  }

  const seen = new Set<string>();
  for (const row of draft.rows) {
    const level = fold(row.level);
    if (row.custom) {
      if (!level) {
        errors.rows[row.id] = { message: "Name this level, or remove it.", live: false };
        continue;
      }
      if (/\s/.test(level)) {
        errors.rows[row.id] = { message: "Level names can't contain spaces.", live: true };
        continue;
      }
      if (seen.has(level)) {
        errors.rows[row.id] = { message: `There's already a ${level} level.`, live: true };
        continue;
      }
      if (!row.model) errors.rows[row.id] = { message: "Choose a model for this level, or remove it.", live: false };
    }
    seen.add(level);
  }
  if (!draft.rows.some(isMapped)) errors.form = "Choose a model for at least one effort level.";
  return errors;
}

/** Turns a refused save's field errors into draft errors, so they show beside their fields. */
export function draftErrorsFromServer(draft: EffortDraft, fieldErrors: Record<string, string>): DraftErrors {
  const errors: DraftErrors = { alias: null, rows: {}, form: null };
  const form: string[] = [];
  for (const [field, message] of Object.entries(fieldErrors)) {
    if (field === "alias") {
      errors.alias = { message, live: true };
      continue;
    }
    const level = field.startsWith("targets.") ? field.slice("targets.".length) : null;
    const row = level === null ? undefined : draft.rows.find((entry) => fold(entry.level) === level);
    if (row) errors.rows[row.id] = { message, live: true };
    else form.push(message);
  }
  errors.form = form.length > 0 ? form.join(" ") : null;
  return errors;
}

export function hasDraftErrors(errors: DraftErrors): boolean {
  return Boolean(errors.alias || errors.form || Object.keys(errors.rows).length > 0);
}

// ── Preview ─────────────────────────────────────────────────────────────

export interface ResolvedLevel {
  level: string;
  model: string;
  /** False when requests for it would get a 404. */
  served: boolean;
}

export interface EffortPreview {
  levels: ResolvedLevel[];
  /** Where requests without a mapped effort go, or null with no default yet. */
  fallback: ResolvedLevel | null;
  /** A standard level with no model, to show what "unmapped" means. */
  unmappedExample: string | null;
}

export function previewEffortDraft(draft: EffortDraft, catalog: Pick<ModelCatalogResponse, "models">): EffortPreview {
  const served = (model: string) =>
    catalog.models.some((entry) => entry.providerId === ANTIGRAVITY && fold(entry.id) === fold(model) && entry.offReason === null);
  const levels = Object.entries(draftTargets(draft)).map(([level, model]) => ({ level, model, served: served(model) }));
  const fallbackRow = draftDefaultRow(draft);
  return {
    levels,
    fallback: fallbackRow ? { level: fold(fallbackRow.level), model: fallbackRow.model, served: served(fallbackRow.model) } : null,
    unmappedExample: EFFORT_LEVELS.find((level) => !levels.some((entry) => entry.level === level)) ?? null,
  };
}

export type RequestFormat = "chat" | "responses" | "messages";

/** An example request that asks for `level`. */
export function exampleRequest(format: RequestFormat, alias: string, level: string): string {
  const model = alias.trim() || "your-model-id";
  if (format === "responses") {
    return `POST /v1/responses\n{\n  "model": "${model}",\n  "reasoning": { "effort": "${level}" },\n  "input": "Hi"\n}`;
  }
  if (format === "messages") {
    return `POST /v1/messages\n{\n  "model": "${model}",\n  "max_tokens": 4096,\n  "output_config": { "effort": "${level}" },\n  "messages": [{ "role": "user", "content": "Hi" }]\n}`;
  }
  return `POST /v1/chat/completions\n{\n  "model": "${model}",\n  "reasoning_effort": "${level}",\n  "messages": [{ "role": "user", "content": "Hi" }]\n}`;
}

/** How Anthropic Messages requests without `output_config.effort` pick a level. */
export function claudeThinkingRules(): Array<{ when: string; level: string }> {
  const rules: Array<{ when: string; level: string }> = [];
  let lower = 0;
  for (const bucket of CLAUDE_THINKING_BUDGET_EFFORTS) {
    const when = Number.isFinite(bucket.below)
      ? lower === 0
        ? `budget_tokens under ${bucket.below.toLocaleString("en-US")}`
        : `budget_tokens ${lower.toLocaleString("en-US")} to ${(bucket.below - 1).toLocaleString("en-US")}`
      : `budget_tokens ${lower.toLocaleString("en-US")} or more`;
    rules.push({ when, level: bucket.effort });
    lower = bucket.below;
  }
  rules.push({ when: "thinking turned off", level: CLAUDE_THINKING_DISABLED_EFFORT });
  return rules;
}
