import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  Button,
  EmptyState,
  PageHeader,
  Panel,
  Pill,
  Segmented,
  Spinner,
} from "../components/ui.js";
import { confirmAction, toast } from "../state/actions.js";
import { api } from "../state/api.js";
import { query, setQuery } from "../state/router.js";
import { masked, masker, overview } from "../state/store.js";
import {
  currentDocument,
  initializePlayground,
  saveWorkspace,
  storageError,
  updateDocument,
  workspace,
} from "../state/playground.js";
import { PlaygroundError, runChat } from "../state/playground-client.js";
import {
  buildChatRequest,
  newTranscription,
  CASES,
  complianceRequest,
  emptyResult,
  errorVerdict,
  evaluateCompliance,
  newDocument,
  newId,
  newPanel,
  userMessage,
  VERDICT_LABELS,
  type CaseId,
  type ChatRequest,
  type ChatResult,
  type ComplianceResult,
  type ImageAttachment,
  type Parameters,
  type PlaygroundPanel,
  type PlaygroundTab,
  type Turn,
} from "../lib/playground.js";
import { parsePlaygroundDocument } from "../lib/playground-storage.js";
import { TranscriptionPage } from "./Transcription.js";
import { formatMs } from "../lib/format.js";

const TABS: Array<{ value: PlaygroundTab; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "compare", label: "Compare" },
  { value: "compliance", label: "Compliance" },
  { value: "transcription", label: "Transcription" },
];
const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function PlaygroundPage(): JSX.Element {
  const doc = currentDocument();
  const requestedTab = query.value.get("tab");
  const tab: PlaygroundTab =
    requestedTab === "compare" ||
    requestedTab === "compliance" ||
    requestedTab === "transcription"
      ? requestedTab
      : "chat";
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [maxBodyBytes, setMaxBodyBytes] = useState(25 * 1024 * 1024);
  const controllers = useRef(new Map<string, AbortController>());
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const routing = JSON.stringify([
    overview.value?.modelCatalogRevision,
    overview.value?.accounts.map((a) => [
      a.email,
      a.status,
      a.disabledProviders,
      a.invalidProviders,
    ]),
  ]);
  const running = checking || busy.length > 0 || audioBusy;

  const loadModels = async () => {
    try {
      const response = await api.models();
      setModels([...new Set(response.data.map((m) => m.id))].sort());
      setModelError("");
    } catch (err) {
      setModelError(errorText(err));
    }
  };
  useEffect(() => {
    void initializePlayground();
  }, []);
  useEffect(() => {
    void loadModels();
  }, [routing]);
  useEffect(() => {
    void api
      .playgroundConfig()
      .then((config) => setMaxBodyBytes(config.maxBodyBytes))
      .catch(() => {});
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
    };
  }, []);

  function patchPanel(
    id: string,
    update: (panel: PlaygroundPanel) => PlaygroundPanel,
    immediate = false,
  ): void {
    updateDocument(
      (d) => ({
        ...d,
        chat: d.chat.id === id ? update(d.chat) : d.chat,
        compare: d.compare.map((p) => (p.id === id ? update(p) : p)),
      }),
      immediate,
    );
  }
  function changeParams(id: string, patch: Partial<Parameters>): void {
    updateDocument((d) => ({
      ...d,
      chat:
        d.chat.id === id
          ? { ...d.chat, params: { ...d.chat.params, ...patch } }
          : d.chat,
      compare: d.compare.map((p) =>
        p.id === id || (d.sync && d.compare.some((p) => p.id === id))
          ? { ...p, params: { ...p.params, ...patch } }
          : p,
      ),
    }));
  }
  function ensureSize(request: ChatRequest): void {
    if (new Blob([JSON.stringify(request)]).size > maxBodyBytes)
      throw new Error(
        `Request exceeds the server's ${(maxBodyBytes / 1024 / 1024).toFixed(1)} MiB limit. Remove images or start a new conversation.`,
      );
  }
  async function executePanel(
    panel: PlaygroundPanel,
    request: ChatRequest,
    retry: boolean,
  ): Promise<void> {
    const documentId = doc!.id;
    const controller = new AbortController();
    controllers.current.set(panel.id, controller);
    setBusy((ids) => [...ids, panel.id]);
    const turns = retry ? panel.turns.slice(0, -1) : panel.turns;
    const index = turns.length;
    patchPanel(panel.id, (p) => ({
      ...p,
      turns: [...turns, { request, result: null }],
    }));
    const setTurn = (result: ChatResult, error?: string) => {
      if (currentDocument()?.id !== documentId) return;
      patchPanel(
        panel.id,
        (p) => ({
          ...p,
          turns: p.turns.map((turn, i) =>
            i === index
              ? { request, result, ...(error ? { error } : {}) }
              : turn,
          ),
        }),
        result.done || !!error,
      );
    };
    try {
      setTurn(
        await runChat(request, controller.signal, (result) => setTurn(result)),
      );
    } catch (err) {
      if (err instanceof PlaygroundError) setTurn(err.result, err.message);
      else toast(errorText(err), "error");
    } finally {
      controllers.current.delete(panel.id);
      setBusy((ids) => ids.filter((id) => id !== panel.id));
    }
  }
  async function send(retryPanel?: PlaygroundPanel): Promise<void> {
    if (!doc) return;
    try {
      const panels = retryPanel
        ? [retryPanel]
        : tab === "compare"
          ? doc.compare
          : [doc.chat];
      const next = userMessage(doc.draft, doc.images);
      if (!retryPanel && !doc.draft.trim() && !doc.images.length) return;
      const requests = panels.map((panel) => {
        if (!models.includes(panel.model))
          throw new Error("Choose an enabled model in every panel.");
        const lastRequest = panel.turns.at(-1)?.request;
        const message =
          retryPanel && lastRequest
            ? lastRequest.messages[lastRequest.messages.length - 1]
            : next;
        const request = buildChatRequest(panel, message, !!retryPanel);
        ensureSize(request);
        return request;
      });
      if (!retryPanel)
        updateDocument((d) => ({
          ...d,
          draft: "",
          images: [],
          title:
            d.title === "Untitled playground"
              ? doc.draft.trim().slice(0, 60) || "Image conversation"
              : d.title,
        }));
      await Promise.all(
        panels.map((panel, i) =>
          executePanel(panel, requests[i], !!retryPanel),
        ),
      );
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  async function attach(files: File[]): Promise<void> {
    const documentId = doc?.id;
    try {
      const attachments: ImageAttachment[] = [];
      if (
        files.some(
          (file) =>
            !["image/png", "image/jpeg", "image/webp"].includes(file.type),
        )
      )
        throw new Error("Choose PNG, JPEG or WebP images.");
      if (
        (files.reduce((sum, file) => sum + file.size, 0) * 4) / 3 >
        maxBodyBytes
      )
        throw new Error("Images exceed the request size limit.");
      for (const file of files) {
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        attachments.push({ name: file.name, url });
      }
      if (currentDocument()?.id === documentId)
        updateDocument((d) => ({
          ...d,
          images: [...d.images, ...attachments],
        }));
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  function exportDoc(): void {
    if (!doc) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `playground-${doc.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importDoc(file: File): Promise<void> {
    try {
      if (file.size > 100 * 1024 * 1024)
        throw new Error("Playground imports must be smaller than 100 MiB.");
      const imported = parsePlaygroundDocument(JSON.parse(await file.text()));
      const state = workspace.value!;
      const restored = { ...imported, id: newId(), updatedAt: Date.now() };
      saveWorkspace(
        {
          ...state,
          currentId: restored.id,
          documents: [...state.documents, restored],
        },
        true,
      );
      toast("Imported playground. No requests were sent.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  async function deleteHistory(all: boolean): Promise<void> {
    if (!doc || !workspace.value) return;
    if (
      !(await confirmAction({
        title: all
          ? "Delete all playground history?"
          : "Delete this playground?",
        body: "This removes the local copy from this browser. Export anything you want to keep first.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    const remaining = all
      ? []
      : workspace.value.documents.filter((d) => d.id !== doc.id);
    if (!remaining.length) remaining.push(newDocument());
    saveWorkspace(
      { version: 1, currentId: remaining[0].id, documents: remaining },
      true,
    );
  }
  async function runCompliance(retry = false): Promise<void> {
    if (!doc || !doc.complianceModels.length || !doc.cases.length) return;
    const documentId = doc.id;
    const failed = doc.results.filter(
      (r) => r.verdict === "failed" || r.verdict === "error",
    );
    const jobs = doc.complianceModels.map((model) => ({
      model,
      cases: doc.cases.filter(
        (caseId) =>
          !retry ||
          failed.some((r) => r.model === model && r.caseId === caseId),
      ),
    }));
    if (jobs.some((job) => !models.includes(job.model))) {
      toast("Select enabled models before running compliance.", "error");
      return;
    }
    const jobKey = (model: string, caseId: CaseId) =>
      JSON.stringify([model, caseId]);
    const selected = new Set(
      jobs.flatMap((job) =>
        job.cases.map((caseId) => jobKey(job.model, caseId)),
      ),
    );
    updateDocument((d) => ({
      ...d,
      results: retry
        ? d.results.filter((r) => !selected.has(jobKey(r.model, r.caseId)))
        : [],
    }));
    setChecking(true);
    try {
      await Promise.all(
        jobs.map(async ({ model, cases }) => {
          const controller = new AbortController();
          controllers.current.set(`compliance:${model}`, controller);
          try {
            for (const caseId of cases) {
              const request = complianceRequest(model, caseId);
              let row: ComplianceResult;
              try {
                if (controller.signal.aborted)
                  throw new PlaygroundError(
                    "Request cancelled.",
                    emptyResult(),
                    true,
                  );
                const result = await runChat(request, controller.signal);
                row = {
                  model,
                  caseId,
                  ...evaluateCompliance(caseId, result),
                  turn: { request, result },
                };
              } catch (err) {
                row = {
                  model,
                  caseId,
                  verdict:
                    err instanceof PlaygroundError && err.cancelled
                      ? "cancelled"
                      : errorVerdict(
                          err instanceof PlaygroundError
                            ? err.result.status
                            : 0,
                          errorText(err),
                        ),
                  explanation: errorText(err),
                  turn: {
                    request,
                    result: err instanceof PlaygroundError ? err.result : null,
                    error: errorText(err),
                  },
                };
              }
              if (currentDocument()?.id === documentId)
                updateDocument((d) => ({ ...d, results: [...d.results, row] }));
            }
          } finally {
            controllers.current.delete(`compliance:${model}`);
          }
        }),
      );
    } finally {
      setChecking(false);
    }
  }

  if (!doc) return <Spinner />;
  const panels = tab === "compare" ? doc.compare : [doc.chat];
  return (
    <>
      <PageHeader
        title="Playground"
        description="Chat, compare, transcribe audio and check API compatibility through your rotator."
        actions={
          <>
            <Button
              disabled={running}
              onClick={() => {
                const fresh = newDocument();
                saveWorkspace(
                  {
                    ...workspace.value!,
                    currentId: fresh.id,
                    documents: [...workspace.value!.documents, fresh],
                  },
                  true,
                );
              }}
            >
              New playground
            </Button>
            <Button icon="download" onClick={exportDoc}>
              Export JSON
            </Button>
            <Button
              icon="upload"
              disabled={running}
              onClick={() => importRef.current?.click()}
            >
              Import JSON
            </Button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              class="sr-only"
              aria-label="Import playground JSON"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) void importDoc(file);
              }}
            />
          </>
        }
      />
      <div class="playground">
        {storageError.value && (
          <div class="callout tone-warn" role="alert">
            Local history could not be saved. Your work is still in memory;
            export JSON to keep it. {masker.value.text(storageError.value)}
          </div>
        )}
        {modelError && (
          <div class="callout tone-bad" role="alert">
            {modelError}{" "}
            <Button size="sm" onClick={() => void loadModels()}>
              Reload models
            </Button>
          </div>
        )}
        <div class="pg-toolbar">
          <Segmented
            label="Playground mode"
            value={tab}
            options={TABS}
            onChange={(value) => setQuery({ tab: value }, { replace: false })}
          />
          <label class="field pg-history">
            <span class="sr-only">Local history</span>
            <select
              class="input"
              aria-label="Local history"
              disabled={running}
              value={doc.id}
              onChange={(e) =>
                saveWorkspace(
                  { ...workspace.value!, currentId: e.currentTarget.value },
                  true,
                )
              }
            >
              {workspace.value!.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {masked.value ? "Saved playground" : d.title} ·{" "}
                  {new Date(d.updatedAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            disabled={running}
            onClick={() => void deleteHistory(false)}
          >
            Delete
          </Button>
          <Button
            size="sm"
            disabled={running}
            onClick={() => void deleteHistory(true)}
          >
            Clear history
          </Button>
          {running && (
            <Button
              variant="danger"
              onClick={() => {
                for (const c of controllers.current.values()) c.abort();
              }}
            >
              Stop all
            </Button>
          )}
        </div>
        <p class="field-hint">
          History stays in this browser. Requests use real quota and may also
          appear in the rotator's server logs.
        </p>
        {!models.length && !modelError && (
          <EmptyState icon="models" title="No enabled models">
            Connect a provider and enable models on the Models page, then reload
            the catalog.{" "}
            <Button onClick={() => void loadModels()}>Reload models</Button>
          </EmptyState>
        )}
        {tab === "transcription" ? (
          <TranscriptionPage
            key={doc.id}
            state={doc.transcription ?? newTranscription()}
            models={models}
            maxBodyBytes={maxBodyBytes}
            disabled={checking || busy.length > 0}
            onBusyChange={setAudioBusy}
            controllers={controllers.current}
            onChange={(update) =>
              updateDocument(
                (d) => ({
                  ...d,
                  transcription: update(d.transcription ?? newTranscription()),
                }),
                true,
              )
            }
          />
        ) : tab === "compliance" ? (
          <>
            <Panel
              title="API compliance"
              subtitle="Observed Chat Completions behavior through the rotator. Select up to three models. Tests consume real quota."
            >
              <div
                class="pg-check-models"
                role="group"
                aria-label="Compliance models"
              >
                {[...new Set([...models, ...doc.complianceModels])].map(
                  (model) => (
                    <label key={model}>
                      <input
                        type="checkbox"
                        checked={doc.complianceModels.includes(model)}
                        disabled={
                          running ||
                          (!doc.complianceModels.includes(model) &&
                            doc.complianceModels.length >= 3)
                        }
                        onChange={(e) =>
                          updateDocument((d) => ({
                            ...d,
                            complianceModels: e.currentTarget.checked
                              ? [...d.complianceModels, model]
                              : d.complianceModels.filter((m) => m !== model),
                          }))
                        }
                      />
                      {model}
                      {!models.includes(model) ? " (unavailable)" : ""}
                    </label>
                  ),
                )}
              </div>
              <div
                class="pg-toolbar"
                role="group"
                aria-label="Compliance cases"
              >
                {CASES.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      disabled={running}
                      checked={doc.cases.includes(c.id)}
                      onChange={(e) =>
                        updateDocument((d) => ({
                          ...d,
                          cases: e.currentTarget.checked
                            ? [...d.cases, c.id]
                            : d.cases.filter((id) => id !== c.id),
                        }))
                      }
                    />{" "}
                    {c.label}
                  </label>
                ))}
              </div>
              <div class="pg-toolbar">
                <Button
                  variant="primary"
                  disabled={
                    running || !doc.complianceModels.length || !doc.cases.length
                  }
                  onClick={() => void runCompliance()}
                >
                  Run selected tests
                </Button>
                <Button
                  disabled={
                    running ||
                    !doc.results.some(
                      (r) => r.verdict === "failed" || r.verdict === "error",
                    )
                  }
                  onClick={() => void runCompliance(true)}
                >
                  Retry failed tests
                </Button>
                {checking && (
                  <span role="status">
                    <Spinner /> {doc.results.length} results
                  </span>
                )}
              </div>
            </Panel>
            <div class="pg-results">
              {doc.results.map((row, i) => (
                <Panel
                  key={i}
                  title={`${row.model} · ${CASES.find((c) => c.id === row.caseId)?.label}`}
                  actions={
                    <Pill
                      tone={
                        row.verdict === "passed"
                          ? "ok"
                          : row.verdict === "failed" || row.verdict === "error"
                            ? "bad"
                            : "warn"
                      }
                    >
                      {VERDICT_LABELS[row.verdict]}
                    </Pill>
                  }
                >
                  <p>{masker.value.text(row.explanation)}</p>
                  <TurnView turn={row.turn} />
                </Panel>
              ))}
            </div>
          </>
        ) : (
          <>
            {tab === "compare" && (
              <div class="pg-toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={doc.sync}
                    disabled={running}
                    onChange={(e) =>
                      updateDocument((d) => ({
                        ...d,
                        sync: e.currentTarget.checked,
                        compare: e.currentTarget.checked
                          ? d.compare.map((p) => ({
                              ...p,
                              params: { ...d.compare[0].params },
                            }))
                          : d.compare,
                      }))
                    }
                  />{" "}
                  Sync settings across models
                </label>
                <Button
                  size="sm"
                  disabled={running || doc.compare.length >= 3}
                  onClick={() =>
                    updateDocument((d) => ({
                      ...d,
                      compare: [
                        ...d.compare,
                        {
                          ...newPanel(),
                          params: d.sync
                            ? { ...d.compare[0].params }
                            : { ...newPanel().params },
                        },
                      ],
                    }))
                  }
                >
                  Add model
                </Button>
              </div>
            )}
            <div class={`pg-panels pg-panels-${panels.length}`}>
              {panels.map((panel) => (
                <Panel
                  key={panel.id}
                  title={
                    tab === "chat"
                      ? "Conversation"
                      : `Model ${panels.indexOf(panel) + 1}`
                  }
                  actions={
                    tab === "compare" && doc.compare.length > 2 ? (
                      <Button
                        size="sm"
                        disabled={running}
                        onClick={() =>
                          updateDocument((d) => ({
                            ...d,
                            compare: d.compare.filter((p) => p.id !== panel.id),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    ) : undefined
                  }
                >
                  <label class="field">
                    <span class="field-label">Model</span>
                    <select
                      class="input"
                      aria-label="Model"
                      disabled={running}
                      value={panel.model}
                      onChange={(e) =>
                        patchPanel(panel.id, (p) => ({
                          ...p,
                          model: e.currentTarget.value,
                          turns: [],
                        }))
                      }
                    >
                      <option value="">Choose a model</option>
                      {panel.model && !models.includes(panel.model) && (
                        <option value={panel.model}>
                          {panel.model} (unavailable)
                        </option>
                      )}
                      {models.map((model) => (
                        <option value={model} key={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ParameterEditor
                    params={panel.params}
                    disabled={running}
                    onChange={(patch) => changeParams(panel.id, patch)}
                  />
                  <div
                    class="pg-turns"
                    aria-live="polite"
                    aria-busy={busy.includes(panel.id)}
                  >
                    {panel.turns.length ? (
                      panel.turns.map((turn, i) => (
                        <TurnView key={i} turn={turn} />
                      ))
                    ) : (
                      <p class="muted">Send a message to start testing.</p>
                    )}
                  </div>
                  <div class="pg-toolbar">
                    {busy.includes(panel.id) ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          controllers.current.get(panel.id)?.abort()
                        }
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={running || !panel.turns.length}
                        onClick={() => void send(panel)}
                      >
                        Retry last turn
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={running || !panel.turns.length}
                      onClick={() =>
                        patchPanel(panel.id, (p) => ({ ...p, turns: [] }))
                      }
                    >
                      Clear conversation
                    </Button>
                  </div>
                </Panel>
              ))}
            </div>
            <form
              class="pg-composer"
              onSubmit={(e) => {
                e.preventDefault();
                if (!running) void send();
              }}
            >
              <label class="field">
                <span class="field-label">
                  Message {tab === "compare" && "to all models"}
                </span>
                <textarea
                  class="input"
                  rows={3}
                  value={doc.draft}
                  disabled={running}
                  placeholder="Ask a question or attach an image…"
                  onInput={(e) =>
                    updateDocument((d) => ({
                      ...d,
                      draft: e.currentTarget.value,
                    }))
                  }
                />
              </label>
              {!!doc.images.length && (
                <div class="pg-images">
                  {doc.images.map((image, i) => (
                    <div key={i}>
                      {!masked.value && (
                        <img src={image.url} alt={image.name} />
                      )}
                      <Button
                        size="sm"
                        disabled={running}
                        onClick={() =>
                          updateDocument((d) => ({
                            ...d,
                            images: d.images.filter((_, index) => i !== index),
                          }))
                        }
                      >
                        Remove {masked.value ? "image" : image.name}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div class="pg-toolbar">
                <Button
                  icon="plus"
                  disabled={running}
                  onClick={() => imageRef.current?.click()}
                >
                  Attach images
                </Button>
                <input
                  ref={imageRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  class="sr-only"
                  aria-label="Attach images"
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    void attach(files);
                  }}
                />
                <span class="spacer" />
                <Button
                  variant="primary"
                  type="submit"
                  disabled={
                    running ||
                    !models.length ||
                    (!doc.draft.trim() && !doc.images.length)
                  }
                >
                  Send {tab === "compare" ? "to all" : "message"}
                </Button>
              </div>
              <p class="field-hint">
                Tools are displayed without executing them. Start a new
                conversation after inspecting tool calls. Images require a model
                with vision support.
              </p>
            </form>
          </>
        )}
      </div>
    </>
  );
}

function ParameterEditor({
  params,
  disabled,
  onChange,
}: {
  params: Parameters;
  disabled: boolean;
  onChange: (patch: Partial<Parameters>) => void;
}): JSX.Element {
  return (
    <details class="pg-parameters">
      <summary>Parameters & system prompt</summary>
      <fieldset disabled={disabled} class="form">
        <label class="field">
          <span class="field-label">System prompt</span>
          <textarea
            class="input"
            rows={3}
            value={params.system}
            onInput={(e) => onChange({ system: e.currentTarget.value })}
          />
        </label>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">Temperature</span>
            <input
              class="input"
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder="Provider default"
              value={params.temperature}
              onInput={(e) => onChange({ temperature: e.currentTarget.value })}
            />
          </label>
          <label class="field">
            <span class="field-label">Max tokens</span>
            <input
              class="input"
              type="number"
              min="1"
              step="1"
              placeholder="Provider default"
              value={params.maxTokens}
              onInput={(e) => onChange({ maxTokens: e.currentTarget.value })}
            />
          </label>
        </div>
        <label class="field">
          <span class="field-label">Reasoning effort</span>
          <select
            class="input"
            aria-label="Reasoning effort"
            value={params.effort}
            onChange={(e) => onChange({ effort: e.currentTarget.value })}
          >
            <option value="">Provider default</option>
            {["minimal", "low", "medium", "high", "xhigh"].map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={params.stream}
            onChange={(e) => onChange({ stream: e.currentTarget.checked })}
          />{" "}
          Stream response
        </label>
        <label class="field">
          <span class="field-label">Tools JSON (optional)</span>
          <textarea
            class="input pg-code"
            rows={4}
            spellcheck={false}
            placeholder='[{"type":"function","function":{"name":"example","parameters":{"type":"object"}}}]'
            value={params.tools}
            onInput={(e) => onChange({ tools: e.currentTarget.value })}
          />
        </label>
        <p class="field-hint">
          Parameters are sent as entered. Support depends on the model and
          adapter.
        </p>
      </fieldset>
    </details>
  );
}

function TurnView({ turn }: { turn: Turn }): JSX.Element {
  const result = turn.result;
  const lastMessage = turn.request.messages.at(-1)?.content;
  const m = masker.value;
  const content =
    typeof lastMessage === "string"
      ? [{ type: "text" as const, text: lastMessage }]
      : (lastMessage ?? []);
  return (
    <article class="pg-turn">
      <div class="pg-user">
        <strong>You</strong>
        {content.map((part, i) =>
          part.type === "text" ? (
            <p key={i}>{m.text(part.text)}</p>
          ) : masked.value ? (
            <p key={i}>[Image hidden]</p>
          ) : (
            <img key={i} src={part.image_url.url} alt="Attached image" />
          ),
        )}
      </div>
      <div class="pg-assistant">
        <strong>Assistant</strong>
        {result?.content ? (
          <pre class="pg-answer">{m.text(result.content)}</pre>
        ) : (
          !turn.error &&
          !result?.tools.length && (
            <p class="muted">
              {result?.done ? "Empty response." : "Waiting for response…"}
            </p>
          )
        )}
        {result?.reasoning && (
          <details>
            <summary>Reasoning</summary>
            <pre class="pg-answer">{m.text(result.reasoning)}</pre>
          </details>
        )}
        {!!result?.tools.length && (
          <details open>
            <summary>Tool calls (not executed)</summary>
            <pre class="pg-code">
              {m.text(JSON.stringify(result.tools, null, 2))}
            </pre>
          </details>
        )}
        {turn.error && (
          <p class="form-error" role="alert">
            {m.text(turn.error)}
          </p>
        )}
        {result && (
          <div class="pg-metrics">
            <span>Total: {formatMs(result.durationMs)}</span>
            <span>
              First content:{" "}
              {result.firstContentMs === null
                ? "Not available"
                : formatMs(result.firstContentMs)}
            </span>
            <span>
              Tokens in/out: {result.inputTokens ?? "N/A"} /{" "}
              {result.outputTokens ?? "N/A"}
            </span>
            {result.finishReason && <span>Finish: {result.finishReason}</span>}
            {result.metadata["x-rotator-cost-usd"] && (
              <span>
                Estimated list price: ${result.metadata["x-rotator-cost-usd"]}
              </span>
            )}
          </div>
        )}
        <details class="pg-inspect">
          <summary>Request, response & routing</summary>
          {masked.value ? (
            <p class="muted">
              Raw details hidden while the privacy mask is on.
            </p>
          ) : (
            <pre class="pg-code">
              {JSON.stringify(
                {
                  request: turn.request,
                  response: result?.raw,
                  routing: result?.metadata,
                },
                (_, value: unknown) =>
                  typeof value === "string" && value.startsWith("data:image/")
                    ? `${value.slice(0, 45)}… [image data omitted from preview]`
                    : value,
                2,
              )}
            </pre>
          )}
        </details>
      </div>
    </article>
  );
}
