// Effort routing on the Models page: the panel listing effort-routed model
// IDs, and the drawer that creates or edits one at
// /dashboard/models/effort[/<id>].

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  CatalogEffortRoute,
  CatalogEffortSuggestion,
  CatalogModelEntry,
  EffortRouteErrorResponse,
  ModelCatalogResponse,
} from "../../dashboard-types.js";
import {
  addCustomRow,
  claudeThinkingRules,
  createEffortDraft,
  draftBody,
  draftDefaultRow,
  draftErrorsFromServer,
  effortModelOptions,
  effortRouteRequests,
  effortRouteStatus,
  exampleRequest,
  familyForAlias,
  fillFamily,
  hasDraftErrors,
  isDraftDirty,
  joinWords,
  previewEffortDraft,
  removeRow,
  setDefaultRow,
  setDraftAlias,
  setRowLevel,
  setRowModel,
  validateEffortDraft,
  type DraftChange,
  type DraftErrors,
  type EffortDraft,
  type EffortDraftRow,
  type RequestFormat,
} from "../lib/effort.js";
import { providerMark } from "../lib/models.js";
import { confirmAction, toast } from "../state/actions.js";
import { api, ApiError } from "../state/api.js";
import { effortPath, navigate, query } from "../state/router.js";
import { overview, refreshSnapshot } from "../state/store.js";
import { Icon } from "../components/icons.js";
import { Drawer, Menu } from "../components/overlays.js";
import { Button, Link, Panel, Pill, Switch } from "../components/ui.js";
import { copyText } from "./shared.js";

/** Apply a change, toast its outcome, and keep the returned catalog. */
export type CatalogChange = (
  fn: () => Promise<ModelCatalogResponse>,
  messages: { success?: string; failure: string },
) => Promise<void>;

/** Apply a change that reports its own outcome; null leaves the catalog as it was. */
export type CatalogCommit = (fn: () => Promise<ModelCatalogResponse | null>) => Promise<void>;

const ANTIGRAVITY = "google-antigravity";
const fold = (value: string) => value.trim().toLowerCase();

/**
 * Creating or renaming a route reopens the editor at its new URL; this carries
 * the confirmation across so it shows beside Save instead of in a toast that
 * would cover the drawer's buttons.
 */
let savedNotice: { alias: string; message: string } | null = null;

/** The Models page switch that turns an effort-routed ID off. */
export function effortSwitchKey(alias: string): string {
  return `${ANTIGRAVITY}/${alias}`;
}

function providerNames(state: ModelCatalogResponse): Record<string, string> {
  return Object.fromEntries(state.providers.map((provider) => [provider.id, provider.name]));
}

function AntigravityMark({ size = "md" }: { size?: "sm" | "md" | "lg" }): JSX.Element {
  const mark = providerMark(ANTIGRAVITY);
  return (
    <span class={`provider-mark provider-mark-${size}`} style={{ "--hue": String(mark.hue) }} aria-hidden="true">
      {mark.mark}
    </span>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────

export function EffortRoutingPanel({ state, change }: { state: ModelCatalogResponse; change: CatalogChange }): JSX.Element {
  const routes = state.effortRoutes;
  const suggestions = state.effortSuggestions;
  const requests = overview.value?.recentRequestsByModel ?? {};
  const names = providerNames(state);

  return (
    <Panel
      flush
      class="effort-panel"
      title="Effort routing"
      subtitle="Give clients one model ID. The rotator picks its variant from the effort each request asks for."
      actions={
        routes.length > 0 ? (
          <Button size="sm" icon="plus" onClick={() => navigate(effortPath(null))}>
            New effort model
          </Button>
        ) : undefined
      }
    >
      {routes.length === 0 ? (
        <EffortEmptyState suggestions={suggestions} />
      ) : (
        <>
          <div class="table-scroll">
            <table class="table effort-table">
              <thead>
                <tr>
                  <th scope="col">Model ID</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num-col hide-sm" title="Requests in the last hour">
                    Last hour
                  </th>
                  <th scope="col">Enabled</th>
                  <th scope="col">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <EffortRouteRow key={route.alias} route={route} names={names} requests={requests} change={change} />
                ))}
              </tbody>
            </table>
          </div>
          {suggestions.length > 0 && (
            <div class="effort-suggest" role="group" aria-label="Suggested effort models">
              {suggestions.map((family) => (
                <div class="effort-suggest-item" key={family.alias}>
                  <Icon name="zap" size={16} class="effort-suggest-icon" />
                  <p>
                    <span class="model-id">{family.alias}</span> has {joinWords(family.targets.map((target) => target.effort))} variants.
                    Combine them into one model ID?
                  </p>
                  <Button size="sm" onClick={() => navigate(effortPath(null, family.alias))} aria-label={`Set up ${family.alias}`}>
                    Set up
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function EffortEmptyState({ suggestions }: { suggestions: CatalogEffortSuggestion[] }): JSX.Element {
  return (
    <>
      <div class="empty effort-empty">
        <span class="empty-icon">
          <Icon name="zap" size={18} />
        </span>
        <strong>No effort models yet</strong>
        <p>
          An effort model is one ID, like <code>gemini-3.8-flash</code>, that sends each request to its low, medium or high
          variant based on the effort the request asks for.
        </p>
      </div>
      {suggestions.length > 0 && (
        <div class="effort-suggest-block">
          <h3 class="effort-suggest-head">Found in your catalog</h3>
          <ul class="effort-suggest-list" aria-label="Suggested effort models">
            {suggestions.map((family) => (
              <li key={family.alias}>
                <div>
                  <span class="model-id">{family.alias}</span>
                  <div class="cell-sub">
                    {family.targets.length} variants · {family.targets.map((target) => target.effort).join(" · ")}
                  </div>
                </div>
                <Button variant="primary" size="sm" onClick={() => navigate(effortPath(null, family.alias))} aria-label={`Set up ${family.alias}`}>
                  Set up
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div class="effort-empty-foot">
        <Button variant="ghost" size="sm" icon="plus" onClick={() => navigate(effortPath(null))}>
          Start from scratch
        </Button>
      </div>
    </>
  );
}

function EffortLevels({ route }: { route: CatalogEffortRoute }): JSX.Element {
  return (
    <ul class="effort-levels" aria-label={`Effort levels of ${route.alias}`}>
      {route.targets.map((target) => {
        const isDefault = target.effort === route.defaultEffort;
        return (
          <li
            key={target.effort}
            class={`effort-level${isDefault ? " is-default" : ""}${target.served ? "" : " is-off"}`}
            title={`${target.effort} → ${target.model}${target.served ? "" : " (off)"}`}
          >
            <span class="effort-level-name">{target.effort}</span>
            {isDefault && <span class="effort-level-default">default</span>}
            {!target.served && <span class="sr-only">, model off</span>}
          </li>
        );
      })}
    </ul>
  );
}

function EffortRouteRow({
  route,
  names,
  requests,
  change,
}: {
  route: CatalogEffortRoute;
  names: Record<string, string>;
  requests: Record<string, number>;
  change: CatalogChange;
}): JSX.Element {
  const meta = effortRouteStatus(route, names);
  const count = effortRouteRequests(route, requests);
  const providerOff = route.status === "provider-off";

  const setEnabled = (on: boolean) =>
    change(() => api.setModelsEnabled([effortSwitchKey(route.alias)], on), {
      success: on ? `${route.alias} is on. Clients can call it again.` : `${route.alias} turned off. Requests for it get a 404.`,
      failure: `Could not turn ${route.alias} ${on ? "on" : "off"}`,
    });

  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${route.alias}?`,
      body: `Clients calling ${route.alias} get a 404, and its variants return to /v1/models.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) await change(() => api.deleteEffortRoute(route.alias), { success: `Deleted ${route.alias}`, failure: `Could not delete ${route.alias}` });
  };

  return (
    <tr
      class={`effort-row${route.enabled ? "" : " is-inactive"}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a, .switch-field, .menu-anchor")) return;
        navigate(effortPath(route.alias));
      }}
    >
      <th scope="row">
        <Link href={effortPath(route.alias)} class="effort-alias model-id">
          {route.alias}
        </Link>
        <EffortLevels route={route} />
      </th>
      <td>
        <Pill tone={meta.tone}>{meta.label}</Pill>
        <div class="cell-sub">{meta.detail}</div>
      </td>
      <td class="num-col num hide-sm">{count > 0 ? count.toLocaleString() : <span class="muted">—</span>}</td>
      <td class="cell-switch">
        <Switch label="" ariaLabel={`Serve ${route.alias}`} checked={route.enabled} disabled={providerOff} onChange={setEnabled} />
      </td>
      <td class="cell-action">
        <Menu
          label={`Actions for ${route.alias}`}
          items={[
            { label: "Edit", icon: "edit", onSelect: () => navigate(effortPath(route.alias)) },
            {
              label: "Copy model ID",
              icon: "copy",
              onSelect: () => void copyText(route.alias).then((ok) => toast(ok ? `Copied ${route.alias}` : "Copy failed", "info")),
            },
            "separator",
            {
              label: route.enabled ? "Turn off" : "Turn on",
              icon: route.enabled ? "pause" : "play",
              disabled: providerOff,
              onSelect: () => void setEnabled(!route.enabled),
            },
            { label: "Delete…", icon: "trash", danger: true, onSelect: () => void remove() },
          ]}
        />
      </td>
    </tr>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────

export function EffortRouteDrawer({
  state,
  match,
  change,
  commit,
  onClose,
}: {
  state: ModelCatalogResponse;
  match: { alias: string | null } | null;
  change: CatalogChange;
  commit: CatalogCommit;
  onClose: () => void;
}): JSX.Element {
  const dirty = useRef(false);
  const from = query.value.get("from");
  const confirmDiscard = async () =>
    !dirty.current ||
    (await confirmAction({
      title: "Discard your changes?",
      body: "Your changes to this effort model aren't saved yet.",
      confirmLabel: "Discard",
      danger: true,
    }));
  const close = async () => {
    if (await confirmDiscard()) onClose();
  };

  return (
    <Drawer open={Boolean(match)} onClose={onClose} label="Effort model" confirmClose={confirmDiscard}>
      {match && (
        <EffortRouteEditor
          key={match.alias ?? `new:${from ?? ""}`}
          state={state}
          alias={match.alias}
          from={match.alias === null ? from : null}
          dirtyRef={dirty}
          change={change}
          commit={commit}
          onClose={() => void close()}
          onDeleted={onClose}
        />
      )}
    </Drawer>
  );
}

function mergeErrors(local: DraftErrors, server: DraftErrors | null): DraftErrors {
  if (!server) return local;
  return {
    alias: server.alias ?? local.alias,
    rows: { ...local.rows, ...server.rows },
    form: server.form ?? local.form,
  };
}

const FORMATS: Array<{ id: RequestFormat; label: string }> = [
  { id: "chat", label: "Chat Completions" },
  { id: "responses", label: "Responses" },
  { id: "messages", label: "Anthropic Messages" },
];

function EffortRouteEditor({
  state,
  alias,
  from,
  dirtyRef,
  change,
  commit,
  onClose,
  onDeleted,
}: {
  state: ModelCatalogResponse;
  alias: string | null;
  from: string | null;
  dirtyRef: { current: boolean };
  change: CatalogChange;
  commit: CatalogCommit;
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const route = alias === null ? null : (state.effortRoutes.find((entry) => fold(entry.alias) === fold(alias)) ?? null);
  const family = alias === null && from ? (state.effortSuggestions.find((entry) => entry.alias === from) ?? null) : null;
  const names = providerNames(state);

  const [initial] = useState(() =>
    route ? createEffortDraft(route, route.alias) : createEffortDraft(family ? { alias: family.alias, targets: family.targets } : null),
  );
  const [saved, setSaved] = useState<EffortDraft | null>(route ? initial : null);
  const [draft, setDraft] = useState(initial);
  const [aliasTouched, setAliasTouched] = useState(Boolean(route || family));
  const [showAll, setShowAll] = useState(false);
  const [serverErrors, setServerErrors] = useState<DraftErrors | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<RequestFormat>("chat");
  const [justSaved, setJustSaved] = useState(() => route !== null && savedNotice !== null && fold(savedNotice.alias) === fold(route.alias));
  const [announcement, setAnnouncement] = useState(() => {
    const message = route !== null && savedNotice !== null && fold(savedNotice.alias) === fold(route.alias) ? savedNotice.message : "";
    savedNotice = null;
    return message;
  });
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const dirty = isDraftDirty(draft, saved ?? initial);
  dirtyRef.current = dirty;
  useEffect(() => () => {
    dirtyRef.current = false;
  }, []);

  // Focus moves after the render that creates its target.
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest === "summary") summaryRef.current?.focus();
    else document.getElementById(focusRequest)?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  if (alias !== null && !route) {
    return (
      <div class="drawer-empty">
        <div class="drawer-head">
          <h2>Effort model not found</h2>
          <Button variant="ghost" icon="x" iconOnly onClick={onDeleted}>
            Close
          </Button>
        </div>
        <p class="muted">There is no effort model called “{alias}”.</p>
      </div>
    );
  }

  const errors = mergeErrors(validateEffortDraft(draft, state, names), serverErrors);
  const aliasIssue = errors.alias && (errors.alias.live || aliasTouched || showAll) ? errors.alias.message : null;
  const preview = previewEffortDraft(draft, state);
  const options = effortModelOptions(state, draft.alias);
  const offerFamily = familyForAlias(draft, state.effortSuggestions);
  const renamed = draft.original !== null && draft.alias.trim() !== "" && draft.alias.trim() !== draft.original;
  const status = route ? effortRouteStatus(route, names) : null;
  const creating = draft.original === null;

  const edit = (next: EffortDraft) => {
    setDraft(next);
    setServerErrors(null);
    setConfirmingDelete(false);
    setJustSaved(false);
  };
  const editRows = ({ draft: next, movedDefaultTo }: DraftChange) => {
    edit(next);
    if (movedDefaultTo) setAnnouncement(`Default moved to ${movedDefaultTo}.`);
  };

  const issues: Array<{ target: string; message: string }> = [];
  if (errors.alias) issues.push({ target: "effort-alias", message: errors.alias.message });
  for (const row of draft.rows) {
    const issue = errors.rows[row.id];
    if (!issue) continue;
    const target = row.custom && (!row.level.trim() || !issue.message.startsWith("Choose")) ? `effort-level-${row.id}` : `effort-model-${row.id}`;
    issues.push({ target, message: `${row.level.trim() || "Custom level"}: ${issue.message}` });
  }
  if (errors.form) issues.push({ target: "effort-model-level:medium", message: errors.form });

  const save = async () => {
    if (hasDraftErrors(validateEffortDraft(draft, state, names))) {
      setShowAll(true);
      setAliasTouched(true);
      setServerErrors(null);
      setFocusRequest("summary");
      return;
    }
    const body = draftBody(draft);
    let savedAlias = null as string | null;
    setSaving(true);
    await commit(async () => {
      try {
        const next = creating ? await api.createEffortRoute(body) : await api.updateEffortRoute(draft.original!, body);
        savedAlias = body.alias;
        return next;
      } catch (err) {
        const refused = err instanceof ApiError ? (err.body as EffortRouteErrorResponse | null) : null;
        if (refused?.fieldErrors) {
          setServerErrors(draftErrorsFromServer(draft, refused.fieldErrors));
          setShowAll(true);
          setFocusRequest("summary");
        } else {
          toast(`Could not save ${body.alias}: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return null;
      }
    });
    setSaving(false);
    void refreshSnapshot();
    if (savedAlias === null) return;
    const message = creating ? `Created ${savedAlias}. Clients can call it now.` : `Saved ${savedAlias}. New requests use it right away.`;
    if (creating || savedAlias !== draft.original) {
      dirtyRef.current = false;
      savedNotice = { alias: savedAlias, message };
      navigate(effortPath(savedAlias), { replace: true });
    } else {
      setSaved(draft);
      setJustSaved(true);
      setAnnouncement(message);
      setFocusRequest("effort-editor-title");
    }
  };

  const remove = async () => {
    const target = draft.original!;
    let deleted = false;
    await commit(async () => {
      try {
        const next = await api.deleteEffortRoute(target);
        deleted = true;
        return next;
      } catch (err) {
        toast(`Could not delete ${target}: ${err instanceof Error ? err.message : String(err)}`, "error");
        return null;
      }
    });
    void refreshSnapshot();
    if (!deleted) return;
    dirtyRef.current = false;
    toast(`Deleted ${target}. Its variants are back in /v1/models.`, "success");
    onDeleted();
  };

  const turnOn = (model: string) =>
    change(() => api.setModelsEnabled([`${ANTIGRAVITY}/${model}`], true), {
      success: `${model} turned on`,
      failure: `Could not turn on ${model}`,
    });

  return (
    <article class="account-detail effort-editor" aria-labelledby="effort-editor-title">
      <header class="drawer-head">
        <div class="drawer-title provider-detail-title">
          <AntigravityMark size="lg" />
          <div>
            <h2 id="effort-editor-title" tabIndex={-1} class={draft.alias.trim() ? "effort-title-id" : undefined}>
              {draft.alias.trim() || "New effort model"}
            </h2>
            <div class="drawer-sub">
              <span>{creating ? (family ? "Suggested effort model" : "New effort model") : "Effort model"} on Google Antigravity</span>
              {status && <Pill tone={status.tone}>{status.label}</Pill>}
            </div>
          </div>
        </div>
        <Button variant="ghost" icon="x" iconOnly onClick={onClose}>
          Close
        </Button>
      </header>

      {showAll && issues.length > 0 && (
        <div class="effort-errors">
          <div class="callout tone-bad" role="alert" tabIndex={-1} ref={summaryRef}>
            <Icon name="critical" />
            <div>
              <strong>{issues.length === 1 ? "Fix this problem to save" : `Fix these ${issues.length} problems to save`}</strong>
              <ul class="callout-list">
                {issues.map((issue) => (
                  <li key={issue.target + issue.message}>
                    <button type="button" class="link-button" onClick={() => document.getElementById(issue.target)?.focus()}>
                      {issue.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <section class="detail-section">
        <div class="field">
          <label class="field-label" for="effort-alias">
            Model ID
          </label>
          <input
            id="effort-alias"
            class="input mono"
            value={draft.alias}
            placeholder="e.g. gemini-3.8-flash"
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            autoFocus={creating && !family}
            aria-invalid={aliasIssue ? "true" : undefined}
            aria-describedby={`effort-alias-hint${aliasIssue ? " effort-alias-error" : ""}`}
            onInput={(event) => edit(setDraftAlias(draft, (event.target as HTMLInputElement).value))}
            onBlur={() => setAliasTouched(true)}
          />
          <p class={`field-hint${renamed ? " effort-hint-warn" : ""}`} id="effort-alias-hint">
            {renamed ? (
              <>
                Renaming breaks clients that still call <code>{draft.original}</code>.
              </>
            ) : (
              <>
                Clients send this as <code>model</code>.
              </>
            )}
          </p>
          {aliasIssue && (
            <p class="form-error" id="effort-alias-error">
              {aliasIssue}
            </p>
          )}
        </div>
        {offerFamily && (
          <div class="callout tone-info effort-fill">
            <Icon name="info" />
            <div>
              <strong>
                Found {offerFamily.targets.length} variants of {offerFamily.alias}
              </strong>
              <p>{joinWords(offerFamily.targets.map((target) => target.effort))}. Use them for the matching effort levels?</p>
              <Button
                size="sm"
                onClick={() => {
                  edit(fillFamily(draft, offerFamily));
                  setAnnouncement(`Filled ${offerFamily.targets.length} effort levels.`);
                }}
              >
                Use these variants
              </Button>
            </div>
          </div>
        )}
      </section>

      <section class="detail-section">
        <fieldset class="effort-fieldset">
          <legend class="effort-legend">Effort levels</legend>
          <p class="effort-lead">Choose a model for each level clients may ask for, then pick the default.</p>
          <table class="table table-compact effort-ladder">
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Model</th>
                <th scope="col" class="effort-default-col">
                  Default
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((row) => (
                <LadderRow
                  key={row.id}
                  row={row}
                  draft={draft}
                  options={options}
                  models={state.models}
                  issue={errors.rows[row.id] && (errors.rows[row.id].live || showAll) ? errors.rows[row.id].message : null}
                  onModel={(model) => editRows(setRowModel(draft, row.id, model))}
                  onLevel={(level) => editRows(setRowLevel(draft, row.id, level))}
                  onDefault={() => edit(setDefaultRow(draft, row.id))}
                  onRemove={() => {
                    editRows(removeRow(draft, row.id));
                    setAnnouncement(`Removed the ${row.level.trim() || "custom"} level.`);
                    setFocusRequest("effort-add-level");
                  }}
                />
              ))}
            </tbody>
          </table>
          <div class="effort-ladder-foot">
            <Button
              variant="ghost"
              size="sm"
              icon="plus"
              id="effort-add-level"
              onClick={() => {
                const added = addCustomRow(draft);
                edit(added.draft);
                setFocusRequest(`effort-level-${added.rowId}`);
              }}
            >
              Add custom level
            </Button>
            <span class="field-hint">Levels left on Not used fall back to the default.</span>
          </div>
        </fieldset>
      </section>

      <section class="detail-section" aria-labelledby="effort-resolve-title">
        <h3 id="effort-resolve-title">How requests resolve</h3>
        {preview.levels.length === 0 ? (
          <p class="muted">Choose a model for at least one level to see where requests go.</p>
        ) : (
          <>
            <table class="table table-compact effort-resolve">
              <thead>
                <tr>
                  <th scope="col">Request asks for</th>
                  <th scope="col" class="effort-arrow">
                    <span class="sr-only">Goes to</span>
                  </th>
                  <th scope="col">Served by</th>
                </tr>
              </thead>
              <tbody>
                {preview.levels.map((entry) => (
                  <tr key={entry.level}>
                    <th scope="row">
                      <code>{entry.level}</code>
                    </th>
                    <td class="effort-arrow" aria-hidden="true">
                      <Icon name="chevronRight" size={14} />
                    </td>
                    <td>
                      <ResolvedTarget model={entry.model} served={entry.served} />
                    </td>
                  </tr>
                ))}
                {preview.fallback && (
                  <tr>
                    <th scope="row">
                      Anything else
                      <div class="cell-sub">
                        <span>
                          No effort
                          {preview.unmappedExample && (
                            <>
                              , an unmapped level like <code>{preview.unmappedExample}</code>
                            </>
                          )}
                          , or adaptive thinking
                        </span>
                      </div>
                    </th>
                    <td class="effort-arrow" aria-hidden="true">
                      <Icon name="chevronRight" size={14} />
                    </td>
                    <td>
                      <ResolvedTarget model={preview.fallback.model} served={preview.fallback.served} isDefault />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div class="effort-claude">
              <h4>Claude-style requests</h4>
              <p>
                In <code>/v1/messages</code>, <code>output_config.effort</code> picks the level. Without it, <code>thinking</code> does:
              </p>
              <ul>
                {claudeThinkingRules().map((rule) => (
                  <li key={rule.when}>
                    <span>{rule.when}</span>
                    <Icon name="chevronRight" size={12} />
                    <code>{rule.level}</code>
                  </li>
                ))}
              </ul>
            </div>
            <RequestExample
              alias={draft.alias}
              level={(preview.levels.find((entry) => entry.level === "high") ?? preview.levels[preview.levels.length - 1]).level}
              format={format}
              onFormat={setFormat}
            />
          </>
        )}
      </section>

      <section class="detail-section" aria-labelledby="effort-effects-title">
        <h3 id="effort-effects-title">What clients see</h3>
        <EffortEffects draft={draft} route={route} renamed={renamed} preview={preview} onTurnOn={turnOn} />
      </section>

      <p class="sr-only" aria-live="polite">
        {announcement}
      </p>

      <footer class="effort-foot">
        {confirmingDelete && draft.original ? (
          <div class="effort-confirm" role="group" aria-labelledby="effort-delete-question">
            <p id="effort-delete-question">
              <strong>Delete {draft.original}?</strong> Clients calling it get a 404, and its variants return to <code>/v1/models</code>.
            </p>
            <div class="effort-foot-actions">
              <Button id="effort-delete-keep" onClick={() => {
                setConfirmingDelete(false);
                setFocusRequest("effort-delete");
              }}>
                Keep it
              </Button>
              <Button variant="danger" icon="trash" class="effort-delete-confirm" onClick={() => void remove()}>
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <>
            {!creating && (
              <Button variant="danger" icon="trash" id="effort-delete" onClick={() => {
                setConfirmingDelete(true);
                setFocusRequest("effort-delete-keep");
              }}>
                Delete
              </Button>
            )}
            <span class="effort-foot-spacer" />
            {!creating && (
              <span class={`effort-dirty${!dirty && justSaved ? " is-saved" : ""}`}>
                {dirty ? (
                  "Unsaved changes"
                ) : justSaved ? (
                  <>
                    <Icon name="checkCircle" size={14} />
                    Saved
                  </>
                ) : (
                  "No changes"
                )}
              </span>
            )}
            <Button onClick={onClose}>{dirty ? "Cancel" : "Close"}</Button>
            <Button variant="primary" loading={saving} disabled={!creating && !dirty} onClick={() => void save()}>
              {creating ? "Create effort model" : "Save changes"}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}

function ResolvedTarget({ model, served, isDefault }: { model: string; served: boolean; isDefault?: boolean }): JSX.Element {
  return (
    <div class="effort-target">
      <span class="model-id">{model}</span>
      {isDefault && <span class="tag tag-accent">Default</span>}
      {!served && <Pill tone="bad">404 · model off</Pill>}
    </div>
  );
}

function LadderRow({
  row,
  draft,
  options,
  models,
  issue,
  onModel,
  onLevel,
  onDefault,
  onRemove,
}: {
  row: EffortDraftRow;
  draft: EffortDraft;
  options: { variants: CatalogModelEntry[]; others: CatalogModelEntry[] };
  models: CatalogModelEntry[];
  issue: string | null;
  onModel: (model: string) => void;
  onLevel: (level: string) => void;
  onDefault: () => void;
  onRemove: () => void;
}): JSX.Element {
  const name = row.level.trim() || "custom";
  const mapped = Boolean(row.model) && Boolean(row.level.trim());
  const isDefault = mapped && draft.defaultRowId === row.id;
  const entry = row.model ? models.find((model) => model.providerId === ANTIGRAVITY && fold(model.id) === fold(row.model)) : undefined;
  const missing = Boolean(row.model) && !entry;
  const errorId = `effort-error-${row.id}`;
  const option = (model: CatalogModelEntry) => (
    <option key={model.id} value={model.id}>
      {model.id}
      {model.offReason === null ? "" : " (off)"}
    </option>
  );

  return (
    <tr class={`${mapped ? "" : "is-unused"}${isDefault ? " is-default" : ""}`}>
      <th scope="row">
        {row.custom ? (
          <input
            id={`effort-level-${row.id}`}
            class="input input-sm mono"
            value={row.level}
            placeholder="name"
            aria-label="Custom level name"
            aria-invalid={issue ? "true" : undefined}
            aria-describedby={issue ? errorId : undefined}
            onInput={(event) => onLevel((event.target as HTMLInputElement).value)}
          />
        ) : (
          <span class="effort-level-label">{row.level}</span>
        )}
      </th>
      <td>
        <select
          id={`effort-model-${row.id}`}
          class="select mono"
          aria-label={`Model for ${name} effort`}
          aria-describedby={issue ? errorId : undefined}
          value={row.model}
          onChange={(event) => onModel((event.target as HTMLSelectElement).value)}
        >
          <option value="">Not used</option>
          {missing && <option value={row.model}>{row.model} (not listed)</option>}
          {options.variants.length > 0 && <optgroup label={`Variants of ${draft.alias.trim()}`}>{options.variants.map(option)}</optgroup>}
          <optgroup label={options.variants.length > 0 ? "Other Antigravity models" : "Google Antigravity models"}>{options.others.map(option)}</optgroup>
        </select>
        {(missing || (entry && entry.offReason !== null)) && (
          <div class="effort-row-note">
            <Icon name="warning" size={13} />
            {missing ? `Not listed. ${name} requests may fail.` : `Off. ${name} requests get a 404.`}
          </div>
        )}
        {issue && (
          <div class="form-error effort-row-error" id={errorId}>
            {issue}
          </div>
        )}
      </td>
      <td class="effort-default-col">
        <div class="effort-default-cell">
          <label class="effort-default">
            <input
              type="radio"
              name="effort-default"
              checked={isDefault}
              disabled={!mapped}
              aria-label={`Use ${name} by default`}
              onChange={onDefault}
            />
            <span class="effort-default-text" aria-hidden="true">
              Default
            </span>
          </label>
          {row.custom && (
            <Button variant="ghost" size="sm" icon="trash" iconOnly id={`effort-remove-${row.id}`} onClick={onRemove}>
              Remove the {name} level
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function RequestExample({
  alias,
  level,
  format,
  onFormat,
}: {
  alias: string;
  level: string;
  format: RequestFormat;
  onFormat: (format: RequestFormat) => void;
}): JSX.Element {
  const text = exampleRequest(format, alias, level);
  const select = (next: RequestFormat) => {
    onFormat(next);
    requestAnimationFrame(() => document.getElementById(`effort-tab-${next}`)?.focus());
  };
  return (
    <div class="effort-code">
      <div class="effort-code-head">
        <div
          class="tabs tabs-sm effort-code-tabs"
          role="tablist"
          aria-label="Request format"
          onKeyDown={(event) => {
            const index = FORMATS.findIndex((entry) => entry.id === format);
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (step !== 0) {
              event.preventDefault();
              select(FORMATS[(index + step + FORMATS.length) % FORMATS.length].id);
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              select(FORMATS[event.key === "Home" ? 0 : FORMATS.length - 1].id);
            }
          }}
        >
          {FORMATS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`effort-tab-${entry.id}`}
              class={format === entry.id ? "is-active" : undefined}
              aria-selected={format === entry.id}
              aria-controls="effort-code-panel"
              tabIndex={format === entry.id ? 0 : -1}
              onClick={() => onFormat(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="copy"
          onClick={async () => toast((await copyText(text)) ? "Copied the request example" : "Copy failed", "info")}
        >
          Copy
        </Button>
      </div>
      <pre id="effort-code-panel" role="tabpanel" aria-labelledby={`effort-tab-${format}`} tabIndex={0}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function EffortEffects({
  draft,
  route,
  renamed,
  preview,
  onTurnOn,
}: {
  draft: EffortDraft;
  route: CatalogEffortRoute | null;
  renamed: boolean;
  preview: ReturnType<typeof previewEffortDraft>;
  onTurnOn: (model: string) => Promise<void>;
}): JSX.Element {
  const alias = draft.alias.trim();
  const name = alias ? <code>{alias}</code> : "Your model ID";
  const models = [...new Set(preview.levels.map((entry) => entry.model))];
  const fallback = draftDefaultRow(draft);
  // One warning per model, naming the first level that uses it.
  const offTargets = preview.levels.filter(
    (entry, index) =>
      !entry.served &&
      entry.model !== fallback?.model &&
      preview.levels.findIndex((other) => other.model === entry.model) === index,
  );
  const switchedOff = route !== null && !route.enabled;

  return (
    <>
      <ul class="effort-effects">
        {switchedOff ? (
          <li class="is-warn">
            <Icon name="pause" size={15} />
            <span>
              {name} is turned off: it isn't listed in <code>/v1/models</code> and requests for it get a 404.
            </span>
          </li>
        ) : (
          <li class="is-ok">
            <Icon name="plus" size={15} />
            <span>
              {name} is listed in <code>/v1/models</code> with its default model's context window.
            </span>
          </li>
        )}
        {models.length > 0 && !switchedOff && (
          <li>
            <Icon name="eyeOff" size={15} />
            <span>
              {models.length === 1 ? "Its variant is" : `Its ${models.length} variants are`} hidden from <code>/v1/models</code>. Clients
              can still call {models.length === 1 ? "it" : "them"} by full ID.
            </span>
          </li>
        )}
        <li>
          <Icon name="info" size={15} />
          <span>Usage, quota and spend are recorded under the variant that served each request.</span>
        </li>
        {renamed && draft.original && (
          <li class="is-warn">
            <Icon name="warning" size={15} />
            <span>
              Clients calling <code>{draft.original}</code> get a 404 after the rename.
            </span>
          </li>
        )}
      </ul>
      {preview.fallback && !preview.fallback.served && (
        <div class="callout tone-bad effort-callout">
          <Icon name="critical" />
          <div>
            <strong>The default model is off</strong>
            <p>
              {name} is hidden from <code>/v1/models</code>, and requests that fall back to the default get a 404.
            </p>
            <Button size="sm" onClick={() => void onTurnOn(preview.fallback!.model)}>
              Turn on {preview.fallback.model}
            </Button>
          </div>
        </div>
      )}
      {offTargets.map((entry) => (
        <div class="callout tone-warn effort-callout" key={entry.level}>
          <Icon name="warning" />
          <div>
            <strong>{entry.model} is off</strong>
            <p>
              Requests that ask for <code>{entry.level}</code> get a 404 until it's on.
            </p>
            <Button size="sm" onClick={() => void onTurnOn(entry.model)}>
              Turn on {entry.model}
            </Button>
          </div>
        </div>
      ))}
    </>
  );
}
