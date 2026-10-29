import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button, Panel, Pill } from "../components/ui.js";
import { copyText, downloadText } from "./shared.js";
import { toast } from "../state/actions.js";
import { masked, masker } from "../state/store.js";
import { transcribeAudio } from "../state/transcription-client.js";
import { newId, type TranscriptionState } from "../lib/playground.js";
import {
  AUDIO_ACCEPT,
  AudioRecorder,
  audioFileLimit,
  MAX_RECORDING_MS,
  validateAudioFile,
  type RecordingState,
} from "../lib/audio-recorder.js";
import { formatMs } from "../lib/format.js";

interface Props {
  state: TranscriptionState;
  models: string[];
  maxBodyBytes: number;
  disabled: boolean;
  onChange: (update: (state: TranscriptionState) => TranscriptionState) => void;
  onBusyChange: (busy: boolean) => void;
  controllers: Map<string, AbortController>;
}
export function TranscriptionPage({
  state,
  models,
  maxBodyBytes,
  disabled,
  onChange,
  onBusyChange,
  controllers,
}: Props): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [recording, setRecording] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const capture = useRef<AudioRecorder | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const maxBytes = audioFileLimit(maxBodyBytes);
  const available = models.filter(
    (id) =>
      id === "whisper-1" || (/^gemini-/i.test(id) && !/image|tts/i.test(id)),
  );
  const selected =
    state.model ||
    (available.includes("whisper-1") ? "whisper-1" : available[0] || "");
  const active = sending || recording !== "idle";
  const locked = disabled || active;
  const canRecord =
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.isSecureContext;

  useEffect(() => {
    onBusyChange(active);
  }, [active]);
  useEffect(() => {
    mounted.current = true;
    const recorder = new AudioRecorder({
      maxBytes,
      onState: (value) => {
        if (mounted.current) setRecording(value);
        if (value === "idle") controllers.delete("microphone");
      },
      onFile: (audio) => {
        if (mounted.current) {
          setFile(audio);
          setError("");
        }
      },
      onError: (message) => {
        if (mounted.current) setError(message);
      },
    });
    capture.current = recorder;
    return () => {
      mounted.current = false;
      recorder.cancel();
      request.current?.abort();
      controllers.delete("microphone");
      controllers.delete("transcription");
      onBusyChange(false);
    };
  }, [maxBytes]);
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  useEffect(() => {
    if (recording !== "recording") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  function selectFile(next: File): void {
    try {
      validateAudioFile(next, maxBytes);
      setFile(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  function startRecording(): void {
    if (!canRecord || locked) return;
    setError("");
    setFile(null);
    const controller = new AbortController();
    controller.signal.addEventListener(
      "abort",
      () => capture.current?.cancel(),
      { once: true },
    );
    controllers.set("microphone", controller);
    void capture.current?.start();
  }
  async function transcribe(): Promise<void> {
    if (!file || locked) return;
    if (!available.includes(selected)) {
      setError("Choose an enabled audio model.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    controllers.set("transcription", controller);
    setSending(true);
    setError("");
    try {
      const result = await transcribeAudio(
        {
          file,
          model: selected,
          language: state.language.trim(),
          prompt: state.prompt,
          maxBodyBytes,
        },
        controller.signal,
      );
      if (mounted.current)
        onChange((current) => ({
          ...current,
          model: selected,
          results: [
            { ...result, id: newId(), createdAt: Date.now() },
            ...current.results,
          ],
        }));
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      controllers.delete("transcription");
      request.current = null;
      if (mounted.current) setSending(false);
    }
  }

  return (
    <div class="pg-transcription">
      <Panel
        title="Transcription"
        subtitle="Upload an audio file or record with this device's microphone, then preview and send it to the rotator."
      >
        <div class="form">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">Audio model</span>
              <select
                class="input"
                aria-label="Audio model"
                value={selected}
                disabled={locked}
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    model: e.currentTarget.value,
                  }))
                }
              >
                {!available.length && (
                  <option value="">No audio models enabled</option>
                )}
                {state.model && !available.includes(state.model) && (
                  <option value={state.model}>
                    {state.model} (unavailable)
                  </option>
                )}
                {available.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <span class="field-hint">
                Transcription uses Gemini. whisper-1 is a compatibility alias;
                audio support depends on the selected model.
              </span>
            </label>
            <label class="field">
              <span class="field-label">Language (optional)</span>
              <input
                class="input"
                value={state.language}
                maxLength={12}
                placeholder="Auto detect (e.g. es, en)"
                disabled={locked}
                onInput={(e) =>
                  onChange((current) => ({
                    ...current,
                    language: e.currentTarget.value,
                  }))
                }
              />
            </label>
          </div>
          <label class="field">
            <span class="field-label">Vocabulary context (optional)</span>
            <textarea
              class="input pg-audio-context"
              rows={2}
              maxLength={1000}
              value={state.prompt}
              disabled={locked}
              placeholder="Names, technical terms or other vocabulary to help recognition."
              onInput={(e) =>
                onChange((current) => ({
                  ...current,
                  prompt: e.currentTarget.value,
                }))
              }
            />
          </label>
          <div class="pg-toolbar">
            <Button
              icon="upload"
              disabled={locked}
              onClick={() => inputRef.current?.click()}
            >
              Upload audio
            </Button>
            <input
              ref={inputRef}
              class="sr-only"
              type="file"
              accept={AUDIO_ACCEPT}
              aria-label="Audio file"
              disabled={locked}
              onChange={(e) => {
                const next = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (next) selectFile(next);
              }}
            />
            <Button
              icon="play"
              disabled={locked || !canRecord}
              onClick={startRecording}
            >
              Record microphone
            </Button>
            {recording === "recording" && (
              <>
                <Pill tone="bad">
                  Recording · {Math.floor(elapsed / 60_000)}:
                  {String(Math.floor(elapsed / 1000) % 60).padStart(2, "0")}
                </Pill>
                <Button
                  variant="primary"
                  onClick={() => capture.current?.stop()}
                >
                  Stop recording
                </Button>
              </>
            )}
            {recording === "requesting" && (
              <span role="status">Waiting for microphone permission…</span>
            )}
            {recording === "finalizing" && (
              <span role="status">Preparing recording…</span>
            )}
            {recording !== "idle" && (
              <Button
                variant="danger"
                onClick={() => capture.current?.cancel()}
              >
                Cancel recording
              </Button>
            )}
          </div>
          {!canRecord && (
            <p class="field-hint">
              Microphone recording requires HTTPS or localhost and a browser
              with MediaRecorder support. You can still upload an audio file.
            </p>
          )}
          <p class="field-hint">
            WAV, MP3, M4A/MP4, WebM, OGG/OGA, FLAC or PCM. Up to{" "}
            {(maxBytes / 1024 / 1024).toFixed(1)} MiB per file. Recording stops
            automatically after {MAX_RECORDING_MS / 60_000} minutes.
          </p>
          {file && (
            <div class="pg-audio-preview">
              <div class="pg-toolbar">
                <strong>{masked.value ? "Audio file" : file.name}</strong>
                <span class="muted">{(file.size / 1024).toFixed(1)} KiB</span>
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => setFile(null)}
                >
                  Remove audio
                </Button>
              </div>
              {url && (
                <audio
                  controls
                  preload="metadata"
                  src={url}
                  aria-label="Audio preview"
                />
              )}
            </div>
          )}
          {error && (
            <p class="form-error" role="alert">
              {masker.value.text(error)}
            </p>
          )}
          <div class="pg-toolbar">
            <Button
              variant="primary"
              disabled={locked || !file || !available.includes(selected)}
              onClick={() => void transcribe()}
            >
              Transcribe
            </Button>
            {sending && (
              <>
                <span role="status">Transcribing…</span>
                <Button
                  variant="danger"
                  onClick={() => request.current?.abort()}
                >
                  Cancel transcription
                </Button>
              </>
            )}
          </div>
          <p class="field-hint">
            Audio is sent only when you press Transcribe. Only results and
            settings are saved in local history; audio files and recordings stay
            in this tab.
          </p>
        </div>
      </Panel>
      {state.results.map((result) => (
        <Panel
          key={result.id}
          title={masked.value ? "Transcript" : result.filename}
          subtitle={`${result.model} · ${new Date(result.createdAt).toLocaleString()} · ${formatMs(result.elapsedMs)}`}
          actions={
            <>
              <Button
                size="sm"
                onClick={() =>
                  void copyText(result.text).then((ok) =>
                    toast(
                      ok ? "Transcript copied" : "Could not copy transcript",
                      ok ? "success" : "error",
                    ),
                  )
                }
              >
                Copy text
              </Button>
              <Button
                size="sm"
                icon="download"
                onClick={() =>
                  downloadText(
                    `transcript-${result.id}.txt`,
                    result.text,
                    "text/plain;charset=utf-8",
                  )
                }
              >
                Download text
              </Button>
              <Button
                size="sm"
                disabled={locked}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    results: current.results.filter((r) => r.id !== result.id),
                  }))
                }
              >
                Delete result
              </Button>
            </>
          }
        >
          <pre class="pg-answer">
            {result.text
              ? masker.value.text(result.text)
              : "No clear speech detected."}
          </pre>
        </Panel>
      ))}
    </div>
  );
}
