import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountRuntime } from "../src/types.js";

const testDir = mkdtempSync(join(tmpdir(), "ollama-balance-routing-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;
let extractBalancePools: typeof import("../src/providers/ollama/quota.js").extractBalancePools;
let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let closeDb: typeof import("../src/db-store.js").closeDb;
before(async () => {
  ({ extractBalancePools } = await import("../src/providers/ollama/quota.js"));
  ({ AccountRotator } = await import("../src/rotator.js"));
  const db = await import("../src/db-store.js");
  closeDb = db.closeDb;
  await db.initDb();
});
after(async () => {
  await closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("Ollama balance routing", () => {
  it("gates legacy windows and uses purchased credits after included balance is exhausted", () => {
    const rotator = new AccountRotator({
      accounts: [{ email: "credits@test.dev", credentials: [{ provider: "ollama", apiKey: "test-key" }] }],
      proxyPort: 0, requestsPerRotation: 5, rotateOnQuotaDrop: 20, quotaPollIntervalMs: 300_000,
    });
    rotator.stopQuotaPolling();
    const [account] = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
    const setBalance = (purchased: number) => {
      account.quota = extractBalancePools({
        included: { balance_usd: 0, allowance_usd: 2.5 },
        purchased: { balance_usd: purchased },
      }).map(q => ({ ...q, providerId: "ollama" }));
    };
    account.quota = extractBalancePools({ included: {
      session: { remaining_percent: 50 }, weekly: { remaining_percent: 0 },
    } }).map(q => ({ ...q, providerId: "ollama" }));
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemma4:31b", "ollama").available, false, "legacy weekly limits still gate Ollama routing");
    setBalance(5);
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemma4:31b", "ollama").available, true);
    setBalance(0);
    assert.equal(rotator.getAutoRoutingCandidateStatus("gemma4:31b", "ollama").available, false);
  });
});
