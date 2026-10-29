import { ApiError, notifyUnauthorized } from "./api.js";
import {
  apiErrorMessage,
  record,
  type TranscriptionResult,
} from "../lib/playground.js";
import { validateAudioFile, audioFileLimit } from "../lib/audio-recorder.js";

export interface TranscriptionInput {
  file: File;
  model: string;
  language: string;
  prompt: string;
  maxBodyBytes: number;
}
export async function transcribeAudio(
  input: TranscriptionInput,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Omit<TranscriptionResult, "id" | "createdAt">> {
  validateAudioFile(input.file, audioFileLimit(input.maxBodyBytes));
  if (!input.model) throw new Error("Choose an audio model first.");
  if (input.language && !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(input.language))
    throw new Error(
      "Use a language code such as es or en, or leave it blank for automatic detection.",
    );
  if (input.prompt.length > 1000)
    throw new Error("Vocabulary context must be 1000 characters or fewer.");
  const form = new FormData();
  form.append("file", input.file);
  form.append("model", input.model);
  form.append("response_format", "json");
  if (input.language) form.append("language", input.language);
  if (input.prompt) form.append("prompt", input.prompt);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const started = performance.now();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 40_000);
  try {
    const response = await fetcher("/api/playground/audio/transcriptions", {
      method: "POST",
      credentials: "same-origin",
      body: form,
      signal: controller.signal,
    });
    if (response.status === 401) {
      notifyUnauthorized();
      throw new ApiError(401, "Your session ended. Sign in again.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Invalid transcription response (HTTP ${response.status}).`,
      );
    }
    if (!response.ok)
      throw new Error(
        apiErrorMessage(body) ||
          `Transcription failed (HTTP ${response.status}).`,
      );
    if (!record(body) || typeof body.text !== "string")
      throw new Error("Transcription response is missing text.");
    if (controller.signal.aborted) throw new Error("Request cancelled.");
    return {
      filename: input.file.name,
      model: input.model,
      language: input.language,
      prompt: input.prompt,
      text: body.text,
      elapsedMs: performance.now() - started,
    };
  } catch (err) {
    if (timedOut)
      throw new Error(
        "Transcription request timed out. Try a shorter recording.",
        { cause: err },
      );
    if (signal.aborted)
      throw new Error("Transcription cancelled.", { cause: err });
    throw err;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
