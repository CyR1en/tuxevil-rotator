import {
  CASES,
  record,
  newTranscription,
  type PlaygroundDocument,
} from "./playground.js";

export interface PlaygroundWorkspace {
  version: 1;
  currentId: string;
  documents: PlaygroundDocument[];
}
const CASE_IDS = new Set(CASES.map((c) => c.id));
const imageUrl = (value: unknown): boolean =>
  typeof value === "string" &&
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
const finite = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const nullableNumber = (v: unknown): boolean => v === null || finite(v);
const text = (v: unknown): v is string => typeof v === "string";
function content(v: unknown): boolean {
  return (
    v === null ||
    text(v) ||
    (Array.isArray(v) &&
      v.every(
        (p) =>
          record(p) &&
          ((p.type === "text" && text(p.text)) ||
            (p.type === "image_url" &&
              record(p.image_url) &&
              imageUrl(p.image_url.url))),
      ))
  );
}
function tools(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        record(t) &&
        text(t.id) &&
        t.type === "function" &&
        record(t.function) &&
        text(t.function.name) &&
        text(t.function.arguments),
    )
  );
}
function request(v: unknown): boolean {
  return (
    record(v) &&
    text(v.model) &&
    typeof v.stream === "boolean" &&
    Array.isArray(v.messages) &&
    v.messages.length > 0 &&
    v.messages.every(
      (m) =>
        record(m) &&
        ["user", "system", "assistant"].includes(String(m.role)) &&
        content(m.content) &&
        (m.tool_calls === undefined || tools(m.tool_calls)),
    )
  );
}
function result(v: unknown): boolean {
  return (
    v === null ||
    (record(v) &&
      text(v.content) &&
      text(v.reasoning) &&
      tools(v.tools) &&
      finite(v.durationMs) &&
      nullableNumber(v.firstContentMs) &&
      nullableNumber(v.inputTokens) &&
      nullableNumber(v.outputTokens) &&
      (v.finishReason === null || text(v.finishReason)) &&
      record(v.metadata) &&
      Object.values(v.metadata).every(text) &&
      Array.isArray(v.raw) &&
      typeof v.done === "boolean" &&
      finite(v.status))
  );
}
function turn(v: unknown): boolean {
  return (
    record(v) &&
    request(v.request) &&
    result(v.result) &&
    (v.error === undefined || text(v.error))
  );
}
function panel(v: unknown): boolean {
  return (
    record(v) &&
    text(v.id) &&
    text(v.model) &&
    record(v.params) &&
    ["system", "temperature", "maxTokens", "effort", "tools"].every((k) =>
      text(v.params && (v.params as Record<string, unknown>)[k]),
    ) &&
    typeof v.params.stream === "boolean" &&
    Array.isArray(v.turns) &&
    v.turns.every(turn)
  );
}
function transcription(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      text(value.model) &&
      text(value.language) &&
      text(value.prompt) &&
      Array.isArray(value.results) &&
      value.results.every(
        (r) =>
          record(r) &&
          text(r.id) &&
          text(r.filename) &&
          text(r.model) &&
          text(r.language) &&
          text(r.prompt) &&
          text(r.text) &&
          finite(r.elapsedMs) &&
          finite(r.createdAt),
      ))
  );
}
/** Validate imports before any UI or request-building code sees them. Never run imports. */
export function parsePlaygroundDocument(input: unknown): PlaygroundDocument {
  if (
    !record(input) ||
    input.version !== 1 ||
    !text(input.id) ||
    !input.id ||
    !text(input.title) ||
    !finite(input.updatedAt) ||
    !panel(input.chat) ||
    !transcription(input.transcription) ||
    !Array.isArray(input.compare) ||
    input.compare.length < 2 ||
    input.compare.length > 3 ||
    !input.compare.every(panel) ||
    new Set(input.compare.map((p) => (p as { id: string }).id)).size !==
      input.compare.length ||
    typeof input.sync !== "boolean" ||
    !text(input.draft) ||
    !Array.isArray(input.images) ||
    !input.images.every((i) => record(i) && text(i.name) && imageUrl(i.url)) ||
    !Array.isArray(input.complianceModels) ||
    input.complianceModels.length > 3 ||
    !input.complianceModels.every(text) ||
    !Array.isArray(input.cases) ||
    !input.cases.every((c) => CASE_IDS.has(c)) ||
    !Array.isArray(input.results) ||
    !input.results.every(
      (r) =>
        record(r) &&
        text(r.model) &&
        CASE_IDS.has(r.caseId as never) &&
        ["passed", "failed", "unsupported", "error", "cancelled"].includes(
          String(r.verdict),
        ) &&
        text(r.explanation) &&
        turn(r.turn),
    )
  ) {
    throw new Error(
      "Invalid playground file or unsupported version. Expected a version 1 playground export.",
    );
  }
  const doc = input as unknown as PlaygroundDocument;
  const restorePanel = (p: typeof doc.chat) => ({
    ...p,
    turns: p.turns.map((t) =>
      !t.error && !t.result?.done
        ? {
            ...t,
            error:
              "Interrupted before completion. Retry this turn to send it again.",
          }
        : t,
    ),
  });
  return {
    ...doc,
    transcription: doc.transcription ?? newTranscription(),
    chat: restorePanel(doc.chat),
    compare: doc.compare.map(restorePanel),
  };
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Local storage is unavailable."));
      return;
    }
    const req = indexedDB.open("tuxevil-playground", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("workspace");
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error("Close other dashboard tabs to open local history."));
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
  });
  return database;
}
export async function readWorkspace(): Promise<PlaygroundWorkspace | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("workspace", "readonly");
    const req = tx.objectStore("workspace").get("current");
    req.onsuccess = () => {
      try {
        const value: unknown = req.result;
        if (value === undefined) {
          resolve(null);
          return;
        }
        if (
          !record(value) ||
          value.version !== 1 ||
          !text(value.currentId) ||
          !Array.isArray(value.documents)
        )
          throw new Error("Invalid local playground history.");
        const documents = value.documents.map(parsePlaygroundDocument);
        resolve({ version: 1, currentId: value.currentId, documents });
      } catch (err) {
        reject(err);
      }
    };
    req.onerror = () => reject(req.error);
  });
}
// Serialize snapshots so an older, slower write cannot replace newer work.
let writeTail = Promise.resolve();
export function writeWorkspace(workspace: PlaygroundWorkspace): Promise<void> {
  const snapshot = structuredClone(workspace);
  const operation = writeTail
    .catch(() => {})
    .then(async () => {
      const db = await openDatabase();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(snapshot, "current");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error || new Error("Local history write aborted."));
      });
    });
  writeTail = operation;
  return operation;
}
