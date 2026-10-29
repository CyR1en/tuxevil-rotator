// Minimal History API router. Every view has a real URL, so pages, filters
// and the open account drawer survive reloads and can be shared.

import { computed, signal } from "@preact/signals";

export const BASE = "/dashboard";

export type PageId = "overview" | "accounts" | "models" | "requests" | "usage" | "keys" | "settings" | "playground";

export interface RouteMatch {
  page: PageId | "not-found";
  /** Email of the account whose drawer is open. */
  account: string | null;
  /** Id of the provider whose drawer is open on the Models page. */
  provider: string | null;
  /** Effort route editor on the Models page; alias null while creating one. */
  effort: { alias: string | null } | null;
}

export interface LocationState {
  path: string;
  search: string;
}

function readLocation(): LocationState {
  return { path: window.location.pathname, search: window.location.search };
}

export const location = signal<LocationState>(readLocation());

/**
 * Asked before navigation would lose something, such as an editor's unsaved
 * changes. The target is null when the page itself is leaving (reload, close).
 */
export interface NavigationGuard {
  blocks(target: LocationState | null): boolean;
  /** Whether to leave anyway. */
  confirm(): Promise<boolean>;
}

let guard: NavigationGuard | null = null;
let asking = false;

/** Guard navigation until the returned function is called. */
export function guardNavigation(next: NavigationGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

function blocked(target: LocationState | null): boolean {
  return guard?.blocks(target) ?? false;
}

async function askToLeave(leave: () => void): Promise<void> {
  const current = guard;
  if (!current || asking) return;
  asking = true;
  try {
    if (await current.confirm()) leave();
  } finally {
    asking = false;
  }
}

// Each history entry the router adds records its position (the first one has
// none and counts as 0), so a Back or Forward the guard blocks can be undone
// with history.go() without dropping entries.
function readPosition(): number {
  const state = window.history.state as { position?: unknown } | null | undefined;
  return typeof state?.position === "number" ? state.position : 0;
}

let position = readPosition();
// Traversals the router makes itself: undoing a blocked one, then redoing it
// once the user chooses to leave. A redo chosen before the undo lands waits
// for it, because browsers mishandle a traversal started while another is on
// its way. Chromium drops it and Firefox runs it first, which leaves the
// editor open, and WebKit counts it from the wrong entry.
let undoing = false;
let redoing = false;
// A redo chosen before the undo landed, as a history.go() delta.
let redoAfterUndo = 0;

function redo(delta: number): void {
  if (undoing) {
    redoAfterUndo = delta;
    return;
  }
  redoing = true;
  window.history.go(delta);
}

window.addEventListener("popstate", () => {
  const from = position;
  position = readPosition();
  if (undoing) {
    undoing = false;
    if (redoAfterUndo !== 0) redo(redoAfterUndo);
    redoAfterUndo = 0;
    return;
  }
  const delta = from - position;
  if (!redoing && delta !== 0 && (asking || blocked(readLocation()))) {
    undoing = true;
    window.history.go(delta);
    void askToLeave(() => redo(-delta));
    return;
  }
  redoing = false;
  location.value = readLocation();
});

window.addEventListener("beforeunload", (event) => {
  if (blocked(null)) event.preventDefault();
});

function decodeSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function matchRoute(path: string): RouteMatch {
  const rest = path.replace(/\/+$/, "").slice(BASE.length).split("/").filter(Boolean);
  const [head, second, third] = rest;
  const none = { account: null, provider: null, effort: null };
  if (!head) return { ...none, page: "overview" };
  if (head === "accounts") return { ...none, page: "accounts", account: decodeSegment(second) };
  if (head === "models" && second === "effort") return { ...none, page: "models", effort: { alias: decodeSegment(third) } };
  if (head === "models") return { ...none, page: "models", provider: decodeSegment(second) };
  if (head === "playground" || head === "requests" || head === "usage" || head === "keys" || head === "settings") {
    return { ...none, page: head };
  }
  return { ...none, page: "not-found" };
}

export const route = computed(() => matchRoute(location.value.path));
export const query = computed(() => new URLSearchParams(location.value.search));

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = new URL(to, window.location.origin);
  const next = target.pathname + target.search;
  if (next === window.location.pathname + window.location.search) return;
  if (blocked({ path: target.pathname, search: target.search })) {
    void askToLeave(() => go(target, options.replace ?? false));
    return;
  }
  go(target, options.replace ?? false);
}

function go(target: URL, replace: boolean): void {
  const next = target.pathname + target.search;
  const pathChanged = target.pathname !== window.location.pathname;
  if (replace) window.history.replaceState({ position }, "", next);
  else {
    position += 1;
    window.history.pushState({ position }, "", next);
  }
  location.value = readLocation();
  const match = matchRoute(target.pathname);
  if (pathChanged && !match.account && !match.provider && !match.effort) {
    // Pages scroll inside the canvas, not the window.
    document.getElementById("main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }
}

/** Update query parameters in place (null removes a key). */
export function setQuery(params: Record<string, string | null>, options: { replace?: boolean } = {}): void {
  const search = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === "") search.delete(key);
    else search.set(key, value);
  }
  const text = search.toString();
  navigate(window.location.pathname + (text ? `?${text}` : ""), { replace: options.replace ?? true });
}

export function accountPath(email: string): string {
  return `${BASE}/accounts/${encodeURIComponent(email)}`;
}

export function providerPath(providerId: string): string {
  const search = route.value.page === "models" ? location.value.search : "";
  return `${BASE}/models/${encodeURIComponent(providerId)}${search}`;
}

/**
 * The effort route editor, keeping the Models filters. With no alias it
 * creates one, prefilled from the suggested family `from` when given.
 */
export function effortPath(alias: string | null, from?: string): string {
  const search = new URLSearchParams(route.value.page === "models" ? location.value.search : "");
  search.delete("from");
  if (alias === null && from) search.set("from", from);
  const text = search.toString();
  return `${BASE}/models/effort${alias === null ? "" : `/${encodeURIComponent(alias)}`}${text ? `?${text}` : ""}`;
}

/**
 * Which effort editor a location opens, or null for none. The editor keeps
 * its draft only while this stays the same.
 */
export function effortEditorKey(target: LocationState): string | null {
  const effort = matchRoute(target.path).effort;
  if (!effort) return null;
  return effort.alias ?? `new:${new URLSearchParams(target.search).get("from") ?? ""}`;
}

/** Legacy routes from the old dashboard. */
export function redirectLegacyRoutes(): void {
  const { pathname, search } = window.location;
  if (pathname === `${BASE}/logs`) {
    const params = new URLSearchParams(search);
    params.set("view", "history");
    navigate(`${BASE}/requests?${params.toString()}`, { replace: true });
  }
}
