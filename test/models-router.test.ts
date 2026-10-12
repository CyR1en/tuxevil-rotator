import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

type Router = typeof import("../src/web/state/router.js");
let bundle: string;

before(async () => {
  const output = await build({
    entryPoints: [resolve("src/web/state/router.ts")], bundle: true, write: false, platform: "node", format: "cjs",
  });
  bundle = output.outputFiles[0].text;
});

function browser(path: string) {
  const listeners = new Map<string, () => void>();
  const window = {
    location: new URL(path, "http://dashboard.test"),
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    scrollTo() {},
    history: {
      pushState(_state: unknown, _unused: string, url: string) { window.location = new URL(url, window.location.origin); },
      replaceState(_state: unknown, _unused: string, url: string) { window.location = new URL(url, window.location.origin); },
    },
  };
  const module = { exports: {} as Router };
  runInNewContext(bundle, { module, window, document: { getElementById: () => null }, URL, URLSearchParams });
  return { router: module.exports, window };
}

describe("Models provider drawer navigation", () => {
  it("preserves search, filters, sort and privacy when opening and closing the drawer", () => {
    const initial = "/dashboard/models?filter=off&provider=ollama&q=gemma&sort=name&mask=1";
    const { router, window } = browser(initial);
    router.navigate(router.providerPath("ollama"));
    assert.equal(window.location.pathname + window.location.search, initial.replace("/models?", "/models/ollama?"));
    const back = router.query.value.toString();
    router.navigate(`${router.BASE}/models${back ? `?${back}` : ""}`);
    assert.equal(window.location.pathname + window.location.search, initial);
  });

  it("keeps the Models query when moving between drawers and encodes provider IDs", () => {
    const { router, window } = browser("/dashboard/models/ollama?q=two+words&filter=shared");
    router.navigate(router.providerPath("provider/other"));
    assert.equal(window.location.pathname, "/dashboard/models/provider%2Fother");
    assert.equal(router.query.value.get("q"), "two words");
    assert.equal(router.query.value.get("filter"), "shared");
  });

  it("does not transfer another page's query to a provider drawer", () => {
    const { router } = browser("/dashboard/requests?q=error&view=history");
    assert.equal(router.providerPath("ollama"), "/dashboard/models/ollama");
  });
});
