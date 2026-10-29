// Browser capture with explicit ownership: every exit releases the microphone.
export type RecordingState = "idle" | "requesting" | "recording" | "finalizing";
export const MAX_RECORDING_MS = 5 * 60_000;
export const AUDIO_ACCEPT = "audio/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.oga,.flac,.pcm";
export function audioFileLimit(maxBodyBytes: number): number {
  return Math.max(0, maxBodyBytes - 64 * 1024);
}
export function validateAudioFile(file: File, maxBytes: number): void {
  if (!file.size) throw new Error("The audio file is empty.");
  if (file.size > maxBytes)
    throw new Error(
      `Audio exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)} MiB upload limit.`,
    );
  if (!/\.(wav|mp3|m4a|mp4|webm|ogg|oga|flac|pcm)$/i.test(file.name))
    throw new Error("Choose WAV, MP3, M4A/MP4, WebM, OGG/OGA, FLAC or PCM audio.");
}
export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone permission was denied. Allow microphone access in your browser settings, or upload an audio file.";
  if (name === "NotFoundError")
    return "No microphone was found on this device. You can upload an audio file instead.";
  if (name === "NotReadableError")
    return "The microphone is unavailable or in use by another application.";
  return error instanceof Error ? error.message : String(error);
}
export interface RecorderOptions {
  maxBytes: number;
  maxDurationMs?: number;
  onState: (state: RecordingState) => void;
  onFile: (file: File) => void;
  onError: (message: string) => void;
  openMicrophone?: () => Promise<MediaStream>;
  makeRecorder?: (stream: MediaStream) => MediaRecorder;
}
export function browserRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ].find((type) => MediaRecorder.isTypeSupported(type));
  return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
}
export class AudioRecorder {
  private generation = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: RecordingState = "idle";
  constructor(private readonly options: RecorderOptions) {}
  private change(state: RecordingState): void {
    this.state = state;
    this.options.onState(state);
  }
  private release(): void {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
  async start(): Promise<void> {
    if (this.state !== "idle") return;
    const generation = ++this.generation;
    this.change("requesting");
    try {
      const stream = await (
        this.options.openMicrophone ??
        (() => navigator.mediaDevices.getUserMedia({ audio: true }))
      )();
      // Permission can resolve after a tab switch or Cancel. Never retain that stream.
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const recorder = (this.options.makeRecorder ?? browserRecorder)(stream);
      this.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (generation !== this.generation || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > this.options.maxBytes) {
          this.cancel();
          this.options.onError(
            "Recording exceeded the upload limit. Record a shorter clip.",
          );
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generation === this.generation) {
          this.cancel();
          this.options.onError(
            "Recording failed. Check your microphone or upload an audio file.",
          );
        }
      };
      recorder.onstop = () => {
        if (generation !== this.generation) return;
        this.recorder = null;
        this.release();
        this.change("idle");
        const type = chunks[0]?.type || recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          this.options.onError("The recording is empty. Try recording again.");
          return;
        }
        const extension = /mp4|aac/i.test(type)
          ? "m4a"
          : /ogg/i.test(type)
            ? "ogg"
            : "webm";
        this.options.onFile(
          new File([blob], `recording-${Date.now()}.${extension}`, { type }),
        );
      };
      recorder.start(1000);
      this.change("recording");
      this.timer = setTimeout(
        () => this.stop(),
        this.options.maxDurationMs ?? MAX_RECORDING_MS,
      );
    } catch (err) {
      if (generation !== this.generation) return;
      this.cancel();
      this.options.onError(microphoneError(err));
    }
  }
  stop(): void {
    if (!this.recorder || this.state !== "recording") return;
    this.change("finalizing");
    try {
      this.recorder.stop();
    } catch (err) {
      this.cancel();
      this.options.onError(microphoneError(err));
    }
    this.release();
  }
  cancel(): void {
    ++this.generation;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* release tracks even if the browser recorder failed */
      }
    }
    this.release();
    this.change("idle");
  }
}
