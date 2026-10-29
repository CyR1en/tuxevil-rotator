import { ApiError, notifyUnauthorized } from "./api.js";
import {
  apiErrorMessage,
  applyCompletion,
  emptyResult,
  SseDecoder,
  type ChatRequest,
  type ChatResult,
} from "../lib/playground.js";

export class PlaygroundError extends Error {
  constructor(
    message: string,
    readonly result: ChatResult,
    readonly cancelled = false,
  ) {
    super(message);
  }
}

/** One cancellable request, shared by Chat, Compare and Compliance. */
export async function runChat(
  request: ChatRequest,
  signal: AbortSignal,
  onProgress: (result: ChatResult) => void = () => {},
  fetcher: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<ChatResult> {
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const result = emptyResult();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher("/api/playground/chat/completions", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    result.status = response.status;
    response.headers.forEach((value, key) => {
      if (key.startsWith("x-rotator-")) result.metadata[key] = value;
    });
    if (response.status === 401) {
      notifyUnauthorized();
      throw new ApiError(401, "Your session ended. Sign in again.");
    }
    if (!response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (data) result.raw.push(data);
      throw new Error(
        apiErrorMessage(data) || `Request failed (HTTP ${response.status}).`,
      );
    }
    if (request.stream) {
      if (
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      )
        throw new Error("Expected an SSE response.");
      let terminated = false;
      const parser = new SseDecoder((data) => {
        if (terminated) throw new Error("Received data after [DONE].");
        if (data === "[DONE]") {
          terminated = true;
          return;
        }
        applyCompletion(
          result,
          JSON.parse(data) as unknown,
          true,
          performance.now() - started,
        );
        result.durationMs = performance.now() - started;
        onProgress(structuredClone(result));
      });
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.finish();
      if (!terminated || !result.finishReason)
        throw new Error("Stream ended without a finish reason and [DONE].");
    } else {
      applyCompletion(
        result,
        await response.json(),
        false,
        performance.now() - started,
      );
      if (!result.finishReason)
        throw new Error("Response is missing finish_reason.");
    }
    if (controller.signal.aborted) throw new Error("Request aborted.");
    result.done = true;
    return result;
  } catch (err) {
    const message = timedOut
      ? "Request timed out after 120 seconds."
      : signal.aborted
        ? "Request cancelled."
        : err instanceof Error
          ? err.message
          : String(err);
    throw new PlaygroundError(message, result, signal.aborted && !timedOut);
  } finally {
    result.durationMs = performance.now() - started;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // Cancel a malformed or interrupted response so server capacity is released.
    try {
      await reader?.cancel();
    } catch {
      /* the transport may already be closed */
    }
    reader?.releaseLock();
  }
}
