import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIO_ACCEPT,
  AudioRecorder,
  audioFileLimit,
  microphoneError,
  validateAudioFile,
  type RecordingState,
} from "../src/web/lib/audio-recorder.js";
import { newDocument } from "../src/web/lib/playground.js";
import { parsePlaygroundDocument } from "../src/web/lib/playground-storage.js";
import { transcribeAudio } from "../src/web/state/transcription-client.js";

function captureFixture(
  options: { maxBytes?: number; maxDurationMs?: number } = {},
) {
  let stoppedTracks = 0;
  const files: File[] = [];
  const errors: string[] = [];
  const states: RecordingState[] = [];
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          stoppedTracks++;
        },
      },
    ],
  } as unknown as MediaStream;
  const native = {
    state: "inactive",
    mimeType: "audio/webm;codecs=opus",
    ondataavailable: null as ((e: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as (() => void) | null,
    start() {
      this.state = "recording";
    },
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob(["recorded audio"], { type: this.mimeType }),
      });
      this.onstop?.();
    },
  };
  const config = {
    maxBytes: 1024,
    ...options,
    onFile: (file: File) => files.push(file),
    onError: (error: string) => errors.push(error),
    onState: (state: RecordingState) => states.push(state),
    openMicrophone: async () => stream,
    makeRecorder: () => native as unknown as MediaRecorder,
  };
  return {
    native,
    stream,
    config,
    files,
    errors,
    states,
    get stoppedTracks() {
      return stoppedTracks;
    },
  };
}
describe("microphone capture lifecycle", () => {
  it("returns a correctly typed file and releases the device after Stop", async () => {
    const fixture = captureFixture();
    const capture = new AudioRecorder(fixture.config);
    await capture.start();
    capture.stop();
    assert.equal(fixture.files.length, 1);
    assert.equal(fixture.files[0].type, "audio/webm;codecs=opus");
    assert.match(fixture.files[0].name, /\.webm$/);
    assert.equal(fixture.stoppedTracks, 1);
    assert.deepEqual(fixture.states, [
      "requesting",
      "recording",
      "finalizing",
      "idle",
    ]);
  });
  it("discards recordings on cancel and closes late permission streams", async () => {
    const fixture = captureFixture();
    const capture = new AudioRecorder(fixture.config);
    await capture.start();
    capture.cancel();
    assert.equal(fixture.files.length, 0);
    assert.equal(fixture.stoppedTracks, 1);
    let grant!: (stream: MediaStream) => void;
    const waiting = new AudioRecorder({
      ...fixture.config,
      openMicrophone: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    });
    const pending = waiting.start();
    waiting.cancel();
    grant(fixture.stream);
    await pending;
    assert.equal(fixture.stoppedTracks, 2);
    assert.equal(fixture.files.length, 0);
  });
  it("releases tracks after browser errors and constructor failures", async () => {
    const fixture = captureFixture();
    const capture = new AudioRecorder(fixture.config);
    await capture.start();
    fixture.native.onerror!();
    assert.equal(fixture.stoppedTracks, 1);
    assert.equal(fixture.errors.length, 1);
    const broken = new AudioRecorder({
      ...fixture.config,
      makeRecorder: () => {
        throw new Error("codec unavailable");
      },
    });
    await broken.start();
    assert.equal(fixture.stoppedTracks, 2);
    assert.match(fixture.errors[1], /codec/);
  });
  it("stops at the duration limit and rejects oversized recordings", async () => {
    const fixture = captureFixture({ maxDurationMs: 5 });
    await new AudioRecorder(fixture.config).start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(fixture.files.length, 1);
    assert.equal(fixture.stoppedTracks, 1);
    const large = captureFixture({ maxBytes: 2 });
    const capture = new AudioRecorder(large.config);
    await capture.start();
    large.native.ondataavailable!({ data: new Blob(["too big"]) });
    assert.equal(large.files.length, 0);
    assert.equal(large.stoppedTracks, 1);
    assert.match(large.errors[0], /upload limit/);
  });
  it("explains denied permission and unavailable hardware", async () => {
    const fixture = captureFixture();
    const denied = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    await new AudioRecorder({
      ...fixture.config,
      openMicrophone: async () => {
        throw denied;
      },
    }).start();
    assert.match(fixture.errors[0], /permission was denied/);
    assert.match(
      microphoneError(
        Object.assign(new Error("none"), { name: "NotFoundError" }),
      ),
      /No microphone/,
    );
    assert.match(
      microphoneError(
        Object.assign(new Error("busy"), { name: "NotReadableError" }),
      ),
      /in use/,
    );
  });
});
describe("transcription client and persistence", () => {
  const file = new File(["audio bytes"], "sample.webm", { type: "audio/webm" });
  const input = {
    file,
    model: "whisper-1",
    language: "es",
    prompt: "Tuxevil",
    maxBodyBytes: 1024 * 1024,
  };
  it("uploads multipart audio with the dashboard session and preserves transcript metadata", async () => {
    const result = await transcribeAudio(
      input,
      new AbortController().signal,
      async (url, init) => {
        assert.equal(url, "/api/playground/audio/transcriptions");
        assert.equal(init?.credentials, "same-origin");
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        assert.equal(
          new Headers(init?.headers).has("content-type"),
          false,
          "browser must provide the multipart boundary",
        );
        const form = init?.body as FormData;
        assert.equal((form.get("file") as File).name, "sample.webm");
        assert.equal(form.get("model"), "whisper-1");
        assert.equal(form.get("language"), "es");
        assert.equal(form.get("prompt"), "Tuxevil");
        return Response.json({ text: "Hola mundo" });
      },
    );
    assert.equal(result.text, "Hola mundo");
    assert.equal(result.filename, "sample.webm");
    assert.ok(result.elapsedMs >= 0);
    const doc = newDocument();
    doc.transcription = {
      model: "whisper-1",
      language: "es",
      prompt: "Tuxevil",
      results: [{ ...result, id: "transcript", createdAt: 123 }],
    };
    assert.deepEqual(
      parsePlaygroundDocument(JSON.parse(JSON.stringify(doc))),
      doc,
    );
    const old = { ...doc };
    delete old.transcription;
    assert.deepEqual(parsePlaygroundDocument(old).transcription?.results, []);
    assert.throws(
      () =>
        parsePlaygroundDocument({
          ...doc,
          transcription: {
            model: "x",
            language: "",
            prompt: "",
            results: [{}],
          },
        }),
      /Invalid playground/,
    );
  });
  it("accepts .oga uploads regardless of the browser MIME label", async () => {
    assert.ok(AUDIO_ACCEPT.split(",").includes(".oga"));
    for (const type of ["audio/ogg", "application/ogg", ""]) {
      const file = new File(["OggS audio bytes"], "voice.OGA", { type });
      const result = await transcribeAudio(
        { ...input, file },
        new AbortController().signal,
        async (_url, init) => {
          const uploaded = (init?.body as FormData).get("file") as File;
          assert.equal(uploaded.name, "voice.OGA");
          assert.equal(await uploaded.text(), "OggS audio bytes");
          return Response.json({ text: "Hola" });
        },
      );
      assert.equal(result.text, "Hola");
    }
  });
  it("validates uploads and displays server errors and silence correctly", async () => {
    assert.throws(
      () => validateAudioFile(new File([], "empty.wav"), 1000),
      /empty/,
    );
    assert.throws(
      () => validateAudioFile(new File(["x"], "text.txt"), 1000),
      /Choose/,
    );
    assert.throws(() => validateAudioFile(file, 1), /limit/);
    assert.equal(audioFileLimit(1024), 0);
    await assert.rejects(
      transcribeAudio(
        { ...input, language: "Spanish" },
        new AbortController().signal,
      ),
      /language code/,
    );
    await assert.rejects(
      transcribeAudio(input, new AbortController().signal, async () =>
        Response.json(
          { error: { message: "All accounts cooling down" } },
          { status: 429 },
        ),
      ),
      /cooling down/,
    );
    await assert.rejects(
      transcribeAudio(input, new AbortController().signal, async () =>
        Response.json({ wrong: "field" }),
      ),
      /missing text/,
    );
    assert.equal(
      (
        await transcribeAudio(input, new AbortController().signal, async () =>
          Response.json({ text: "" }),
        )
      ).text,
      "",
    );
  });
  it("propagates cancellation to the upload", async () => {
    const controller = new AbortController();
    const pending = transcribeAudio(
      input,
      controller.signal,
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  });
});
