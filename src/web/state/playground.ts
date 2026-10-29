import { signal } from "@preact/signals";
import { newDocument, type PlaygroundDocument } from "../lib/playground.js";
import {
  readWorkspace,
  writeWorkspace,
  type PlaygroundWorkspace,
} from "../lib/playground-storage.js";

export const workspace = signal<PlaygroundWorkspace | null>(null);
export const storageError = signal("");
let initialization: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function initializePlayground(): Promise<void> {
  initialization ??= (async () => {
    try {
      workspace.value = await readWorkspace();
    } catch (err) {
      storageError.value = String(err);
    }
    if (!workspace.value || !workspace.value.documents.length) {
      const doc = newDocument();
      workspace.value = { version: 1, currentId: doc.id, documents: [doc] };
    }
  })();
  return initialization;
}
export function currentDocument(): PlaygroundDocument | null {
  const state = workspace.value;
  return (
    state?.documents.find((doc) => doc.id === state.currentId) ??
    state?.documents[0] ??
    null
  );
}
export function saveWorkspace(
  next: PlaygroundWorkspace,
  immediate = false,
): void {
  workspace.value = next;
  clearTimeout(saveTimer);
  const save = () => {
    void writeWorkspace(workspace.value!)
      .then(() => {
        storageError.value = "";
      })
      .catch((err) => {
        storageError.value = String(err);
      });
  };
  if (immediate) save();
  else saveTimer = setTimeout(save, 300);
}
export function updateDocument(
  update: (doc: PlaygroundDocument) => PlaygroundDocument,
  immediate = false,
): void {
  const doc = currentDocument();
  if (!doc || !workspace.value) return;
  const next = { ...update(doc), updatedAt: Date.now() };
  saveWorkspace(
    {
      ...workspace.value,
      documents: workspace.value.documents.map((d) =>
        d.id === doc.id ? next : d,
      ),
    },
    immediate,
  );
}
