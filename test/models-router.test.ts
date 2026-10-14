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
  const origin = "http://dashboard.test";
  const listeners = new Map<string, (event: unknown) => void>();
  const entries: Array<{ url: URL; state: unknown }> = [{ url: new URL(path, origin), state: null }];
  let index = 0;
  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(state: unknown, _unused: string, url: string) {
      entries.splice(index + 1, entries.length, { url: new URL(url, origin), state });
      index += 1;
    },
    replaceState(state: unknown, _unused: string, url: string) {
      entries[index] = { url: new URL(url, origin), state };
    },
    // Like a browser, the entry changes and popstate fires in a later task.
    go(delta: number) {
      setTimeout(() => {
        if (!entries[index + delta]) return;
        index += delta;
        listeners.get("popstate")?.({});
      });
    },
    back: () => history.go(-1),
    forward: () => history.go(1),
  };
  const window = {
    get location() {
      return entries[index].url;
    },
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    scrollTo() {},
    history,
  };
  const module = { exports: {} as Router };
  runInNewContext(bundle, { module, window, document: { getElementById: () => null }, URL, URLSearchParams });
  return {
    router: module.exports,
    window,
    history,
    entries: () => entries.map((entry) => entry.url.pathname + entry.url.search),
    dispatch: (name: string, event: unknown) => listeners.get(name)?.(event),
  };
}

/** Let queued history traversals and their popstate handlers run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("Models effort route editor navigation", () => {
  it("matches the editor for an effort ID and for a new one", () => {
    const { router } = browser("/dashboard/models");
    // The router runs in another realm; compare plain copies.
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(router.matchRoute("/dashboard/models/effort/gemini-3.8-flash")), {
      page: "models", account: null, provider: null, effort: { alias: "gemini-3.8-flash" },
    });
    assert.deepEqual(plain(router.matchRoute("/dashboard/models/effort").effort), { alias: null });
    assert.equal(router.matchRoute("/dashboard/models/ollama").effort, null);
  });

  it("keeps the Models query, encodes IDs and carries the suggested family only while creating", () => {
    const { router, window } = browser("/dashboard/models?filter=effort&q=flash");
    router.navigate(router.effortPath(null, "gemini-3.6-flash"));
    assert.equal(window.location.pathname, "/dashboard/models/effort");
    assert.equal(router.query.value.get("from"), "gemini-3.6-flash");
    assert.equal(router.query.value.get("filter"), "effort");
    router.navigate(router.effortPath("a/b"));
    assert.equal(window.location.pathname, "/dashboard/models/effort/a%2Fb");
    assert.equal(router.query.value.get("from"), null);
    assert.equal(router.query.value.get("q"), "flash");
  });
});

describe("Unsaved effort editor navigation", () => {
  const ALIAS = "gemini-3.8-flash";

  /**
   * Guard the open editor the way the drawer does. `answers` are the replies
   * to "Discard your changes?", in order.
   */
  function guardEditor(router: Router, answers: boolean[]) {
    const editor = { dirty: true, asked: 0 };
    const key = router.effortEditorKey(router.location.value);
    router.guardNavigation({
      blocks: (target) => editor.dirty && (target === null || router.effortEditorKey(target) !== key),
      confirm: async () => {
        editor.asked += 1;
        const discard = answers.shift() ?? false;
        if (discard) editor.dirty = false;
        return discard;
      },
    });
    // The editor and its draft stay mounted while the route keeps naming it.
    const editors: Array<string | null> = [];
    router.route.subscribe((match) => editors.push(match.effort?.alias ?? null));
    return { editor, editors };
  }

  function openDirtyEditor(start: string, answers: boolean[]) {
    const page = browser(start);
    page.router.navigate(page.router.effortPath(ALIAS));
    return { ...page, ...guardEditor(page.router, answers) };
  }

  it("asks before Back discards edits: cancelling keeps the editor, confirming leaves it", async () => {
    const { router, window, history, entries, editor, editors } = openDirtyEditor("/dashboard/models?filter=effort", [false, true]);
    const stack = entries();

    history.back();
    await settle();
    assert.equal(editor.asked, 1);
    assert.equal(window.location.pathname, `/dashboard/models/effort/${ALIAS}`, "the URL goes back to the editor");
    assert.equal(router.route.value.effort?.alias, ALIAS);
    assert.deepEqual(editors, [ALIAS], "the editor never unmounted, so its edits are kept");
    assert.deepEqual(entries(), stack, "no history entries are lost");

    history.back();
    await settle();
    assert.equal(editor.asked, 2);
    assert.equal(window.location.pathname + window.location.search, "/dashboard/models?filter=effort");
    assert.equal(router.route.value.effort, null, "the editor closes and its edits are discarded");
    assert.deepEqual(entries(), stack);
  });

  it("asks before Forward discards edits", async () => {
    const { router, window, history } = browser("/dashboard/models");
    router.navigate(router.effortPath(ALIAS));
    router.navigate("/dashboard/requests");
    history.back();
    await settle();
    assert.equal(window.location.pathname, `/dashboard/models/effort/${ALIAS}`);
    const { editor, editors } = guardEditor(router, [false, true]);

    history.forward();
    await settle();
    assert.equal(editor.asked, 1);
    assert.equal(window.location.pathname, `/dashboard/models/effort/${ALIAS}`);
    assert.deepEqual(editors, [ALIAS]);

    history.forward();
    await settle();
    assert.equal(editor.asked, 2);
    assert.equal(window.location.pathname, "/dashboard/requests");
    assert.equal(router.route.value.page, "requests");
  });

  it("asks before in-app navigation, such as the command palette, discards edits", async () => {
    const { router, window, editor, editors } = openDirtyEditor("/dashboard/models", [false, true]);
    router.navigate("/dashboard/usage");
    await settle();
    assert.equal(editor.asked, 1);
    assert.equal(window.location.pathname, `/dashboard/models/effort/${ALIAS}`);
    assert.deepEqual(editors, [ALIAS]);

    router.navigate("/dashboard/usage");
    await settle();
    assert.equal(editor.asked, 2);
    assert.equal(window.location.pathname, "/dashboard/usage");
    assert.equal(router.route.value.page, "usage");
  });

  it("does not ask when nothing would be lost", async () => {
    const { router, window, history, editor } = openDirtyEditor("/dashboard/models", []);
    router.setQuery({ q: "flash" });
    assert.equal(window.location.search, "?q=flash", "a query change keeps the editor");
    assert.equal(editor.asked, 0);

    editor.dirty = false;
    history.back();
    await settle();
    assert.equal(editor.asked, 0);
    assert.equal(window.location.pathname, "/dashboard/models");
  });

  it("warns before a reload or closing the tab while edits are unsaved", () => {
    const { dispatch, editor } = openDirtyEditor("/dashboard/models", []);
    const unload = () => {
      let prevented = false;
      dispatch("beforeunload", { preventDefault: () => (prevented = true) });
      return prevented;
    };
    assert.equal(unload(), true);
    editor.dirty = false;
    assert.equal(unload(), false);
  });

  it("names the editor by its ID, or by the suggested family while creating", () => {
    const { router } = browser("/dashboard/models");
    assert.equal(router.effortEditorKey({ path: `/dashboard/models/effort/${ALIAS}`, search: "?q=x" }), ALIAS);
    assert.equal(router.effortEditorKey({ path: "/dashboard/models/effort", search: "?from=gemini-3.6-flash" }), "new:gemini-3.6-flash");
    assert.equal(router.effortEditorKey({ path: "/dashboard/models/effort", search: "" }), "new:");
    assert.equal(router.effortEditorKey({ path: "/dashboard/models", search: "" }), null);
  });
});
