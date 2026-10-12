import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { DashboardAccount, ModelCatalogResponse } from "../../dashboard-types.js";

/** The live fields that can change the Models catalog or its chosen provider. */
export interface CatalogRoutingState {
  accounts: Array<Pick<DashboardAccount, "email" | "provider" | "status" | "disabledProviders" | "invalidProviders"> & { id?: string }>;
  modelCatalogRevision?: string;
}

function routingSignature(state: CatalogRoutingState): string {
  const accounts = state.accounts.map((account) => [
    account.id ?? account.email,
    account.provider.split("+").sort(),
    account.status === "disabled" || account.status === "flagged" || account.status === "off",
    [...(account.disabledProviders ?? [])].sort(),
    Object.keys(account.invalidProviders ?? {}).filter((id) => Boolean(account.invalidProviders?.[id])).sort(),
  ]);
  // Ordering, activity, quotas and countdowns do not change catalog routing.
  accounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([state.modelCatalogRevision, accounts]);
}

/** Kept across visits by ModelsPage; owns catalog reads and mutations. */
export function createModelCatalogState(fetchCatalog: () => Promise<ModelCatalogResponse>) {
  const catalog = signal<ModelCatalogResponse | null>(null);
  const catalogError = signal<string | null>(null);
  let readVersion = 0;
  let loadRequested = false;
  let loading: Promise<void> | null = null;
  let mutationTail = Promise.resolve();
  let pendingMutations = 0;

  function loadCatalog(): Promise<void> {
    readVersion++;
    loadRequested = true;
    if (loading) return loading;

    loading = Promise.resolve().then(async () => {
      try {
        while (loadRequested) {
          // A refresh requested during a mutation reads its committed result.
          while (pendingMutations > 0) await mutationTail;
          loadRequested = false;
          const version = readVersion;
          try {
            const next = await fetchCatalog();
            if (version === readVersion && pendingMutations === 0) {
              catalog.value = next;
              catalogError.value = null;
            }
          } catch (err) {
            if (version === readVersion && pendingMutations === 0) {
              catalogError.value = err instanceof Error ? err.message : String(err);
            }
          }
        }
      } finally {
        loading = null;
      }
    });
    return loading;
  }

  function change(fn: () => Promise<ModelCatalogResponse | null>): Promise<void> {
    // Invalidate older GETs as soon as the action is queued, not after it ends.
    readVersion++;
    pendingMutations++;
    const operation = mutationTail.then(async () => {
      try {
        const next = await fn();
        if (next) {
          catalog.value = next;
          catalogError.value = null;
        }
      } finally {
        pendingMutations--;
      }
    });
    // One request finishes before the next is sent; failures cannot block it.
    mutationTail = operation.catch(() => {});
    return operation;
  }

  function watchRouting(source: ReadonlySignal<CatalogRoutingState | null>, focusTarget?: EventTarget): () => void {
    let previous: string | undefined;
    const stop = effect(() => {
      const current = source.value;
      if (!current) return;
      const signature = routingSignature(current);
      if (signature === previous) return;
      previous = signature;
      void loadCatalog();
    });
    const onFocus = () => void loadCatalog();
    focusTarget?.addEventListener("focus", onFocus);
    return () => {
      stop();
      focusTarget?.removeEventListener("focus", onFocus);
    };
  }

  return { catalog, catalogError, loadCatalog, change, watchRouting };
}
