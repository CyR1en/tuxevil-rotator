// Quick successive writes to one settings key must leave the newest value on
// disk, even when the backup taken before an early write finishes last.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "settings-write-order-"));
process.env.TUXEVIL_ROTATOR_DIR = dir;

const { FileSettingsRepository } = await import("../src/settings-repository.js");

describe("settings write order", () => {
  it("keeps the newest value when an earlier write's backup is slow", async () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: "initial" }));
    const repo = new FileSettingsRepository();
    await repo.init();

    // Delay the first backup read so the first write would finish last.
    const realReadFile = fsp.readFile;
    let reads = 0;
    fsp.readFile = (async (...args: Parameters<typeof realReadFile>) => {
      if (reads++ === 0) await new Promise((resolve) => setTimeout(resolve, 60));
      return realReadFile(...args);
    }) as typeof realReadFile;
    syncBuiltinESMExports();
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => repo.set("rotator_state", JSON.stringify({ version: i }))),
      );
    } finally {
      fsp.readFile = realReadFile;
      syncBuiltinESMExports();
    }

    assert.deepEqual(JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")), { version: 4 });
    assert.equal(repo.get("rotator_state"), JSON.stringify({ version: 4 }));
  });
});
