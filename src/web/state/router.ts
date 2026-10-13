// Minimal History API router. Every view has a real URL, so pages, filters
// and the open account drawer survive reloads and can be shared.

import { computed, signal } from "@preact/signals";

export const BASE = "/dashboard";

export type PageId = "overview" | "accounts" | "models" | "requests" | "usage" | "keys" | "settings";

export interface RouteMatch {
  page: PageId | "not-found";
  /** Email of the account whose drawer is open. */
  account: string | null;
  /** Id of the provider whose drawer is open on the Models page. */
  provider: string | null;
  /** Effort route editor on the Models page; alias null while creating one. */
  effort: { alias: string | null } | null;
}

interface LocationState {
  path: string;
  search: string;
}

function readLocation(): LocationState {
  return { path: window.location.pathname, search: window.location.search };
}

export const location = signal<LocationState>(readLocation());

window.addEventListener("popstate", () => {
  location.value = readLocation();
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
  if (head === "requests" || head === "usage" || head === "keys" || head === "settings") {
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
  const pathChanged = target.pathname !== window.location.pathname;
  window.history[options.replace ? "replaceState" : "pushState"](null, "", next);
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

/** Legacy routes from the old dashboard. */
export function redirectLegacyRoutes(): void {
  const { pathname, search } = window.location;
  if (pathname === `${BASE}/logs`) {
    const params = new URLSearchParams(search);
    params.set("view", "history");
    navigate(`${BASE}/requests?${params.toString()}`, { replace: true });
  }
}
