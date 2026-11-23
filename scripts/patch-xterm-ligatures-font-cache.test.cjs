"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  EXPECTED_VERSION,
  PATCHES,
  patchXtermSource,
  patchInstalledLigatures,
} = require("./patch-xterm-ligatures-font-cache.cjs");

for (const patch of PATCHES) {
  test(`${patch.file}: applies once and rejects unknown or ambiguous shapes`, () => {
    const first = patchXtermSource(`before;${patch.original}after`, patch);
    assert.equal(first.changed, true);
    assert.equal(first.source, `before;${patch.replacement}after`);
    assert.match(first.source, /new Map/);
    assert.match(first.source, /\.has\(fontFamily\)/);
    assert.match(first.source, /\.set\(fontFamily,\s*promise\)/);
    assert.deepEqual(patchXtermSource(first.source, patch), { source: first.source, changed: false });
    for (const source of ["upstream changed", patch.original.repeat(2), patch.replacement.repeat(2), patch.original + patch.replacement]) {
      assert.throws(() => patchXtermSource(source, patch), /unexpected ligatures font-cache patch shape/);
    }
  });
}

test("version guard matches the pinned package dependency", () => {
  assert.equal(EXPECTED_VERSION, "0.11.0-beta.292");
  assert.equal(EXPECTED_VERSION, require("../package.json").devDependencies["@xterm/addon-ligatures"]);
});

function createLoader(patch) {
  const state = { requests: 0, queries: 0, blobs: 0, buffers: 0, parses: 0, permission: "granted" };
  state.parse = buffer => ({ family: buffer.family });
  const metadata = ["Font A", "Font B"].map(family => ({
    family,
    blob: async () => {
      state.blobs++;
      return { arrayBuffer: async () => { state.buffers++; return { family }; } };
    },
  }));
  const parse = family => family.split(",").map(value => value.trim());
  const loadBuffer = (buffer, options) => {
    state.parses++;
    assert.equal(options.cacheSize, 1e5);
    return state.parse(buffer);
  };
  const context = {
    Error,
    navigator: {
      permissions: { request: async permission => {
        assert.equal(permission.name, "local-fonts");
        state.requests++;
        return { state: state.permission };
      } },
      fonts: { query: async () => { state.queries++; return metadata; } },
    },
    t: {},
    n: id => {
      if (id === 431) return { loadBuffer };
      assert.equal(id, 838);
      return { default: parse };
    },
    s: value => value,
    Or: parse,
    Hi: loadBuffer,
  };
  let source = patchXtermSource(patch.original, patch).source;
  if (patch.file.endsWith(".js")) {
    source += 'let a;const i=["monospace"];t.default;';
  } else if (patch.file.endsWith(".mjs")) {
    source = 'let zn;' + source + '["monospace"];Ir;';
  } else {
    // Execute the readable wrapper with a stub uncached loader; bundle tests
    // above exercise the original Font Access and loadBuffer implementations.
    source = source.slice(source.indexOf("const fontCache"), source.lastIndexOf("async function loadUncached"));
    source = require("typescript").transpileModule(source, {
      compilerOptions: { module: require("typescript").ModuleKind.CommonJS },
    }).outputText;
    context.exports = {};
    context.loadUncached = async (family, cacheSize) => {
      const status = await context.navigator.permissions.request({ name: "local-fonts" });
      if (status.state !== "granted") throw new Error("Permission to access local fonts not granted.");
      await context.navigator.fonts.query();
      const font = metadata.find(value => value.family === family);
      if (!font) return undefined;
      return loadBuffer(await (await font.blob()).arrayBuffer(), { cacheSize });
    };
    source += "\nexports.default;";
  }
  return { load: vm.runInNewContext(source, context), state };
}

for (const patch of PATCHES) {
  test(`${patch.file}: shares in-flight parses and retains results by family`, async () => {
    const { load, state } = createLoader(patch);
    let finishParse;
    let startedParse;
    const started = new Promise(resolve => { startedParse = resolve; });
    const pending = new Promise(resolve => { finishParse = resolve; });
    state.parse = () => { startedParse(); return pending; };
    const first = load("Font A", 1e5);
    assert.equal(load("Font A", 1e5), first);
    await started;
    assert.equal(load("Font A", 1e5), first, "shares the promise while parsing is pending");
    assert.equal(state.blobs, 1);
    assert.equal(state.buffers, 1);
    assert.equal(state.parses, 1);
    const font = { family: "Font A" };
    finishParse(font);
    assert.equal(await first, font);
    assert.equal(load("Font A", 1e5), first, "retains the settled promise");
    assert.equal(await load("Font A", 1e5), font);
    state.parse = buffer => ({ family: buffer.family });
    const other = load("Font B", 1e5);
    assert.notEqual(other, first);
    assert.deepEqual(await other, { family: "Font B" });
    assert.equal(state.parses, 2);
    assert.equal(state.blobs, 2);
    assert.equal(await load("monospace", 1e5), undefined);
    assert.equal(await load("Missing Font", 1e5), undefined);
    assert.equal(state.parses, 2, "unresolved fonts still fall back without parsing");
    if (!patch.file.endsWith(".ts")) {
      assert.equal(state.requests, 1);
      assert.equal(state.queries, 1);
    }
  });

  test(`${patch.file}: evicts failed parses so the same family can retry`, async () => {
    const { load, state } = createLoader(patch);
    state.parse = () => { throw new Error("parse failed"); };
    const failed = load("Font A", 1e5);
    assert.equal(load("Font A", 1e5), failed);
    await assert.rejects(failed, /parse failed/);
    state.parse = buffer => ({ family: buffer.family });
    const retry = load("Font A", 1e5);
    assert.notEqual(retry, failed);
    assert.deepEqual(await retry, { family: "Font A" });
    assert.equal(state.parses, 2);
    assert.equal(state.blobs, 2);
    assert.equal(load("Font A", 1e5), retry);
  });

  test(`${patch.file}: preserves permission rejection and allows a later retry`, async () => {
    const { load, state } = createLoader(patch);
    state.permission = "denied";
    await assert.rejects(load("Font A", 1e5), /Permission to access local fonts not granted/);
    assert.equal(state.parses, 0);
    assert.equal(state.queries, 0);
    state.permission = "granted";
    assert.deepEqual(await load("Font A", 1e5), { family: "Font A" });
    assert.equal(state.requests, 2);
    assert.equal(state.queries, 1);
    assert.equal(state.parses, 1);
  });
}

function createInstallation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ligatures-font-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, "node_modules/@xterm/addon-ligatures/package.json");
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.writeFileSync(packagePath, JSON.stringify({ version: EXPECTED_VERSION }));
  for (const patch of PATCHES) {
    const target = path.join(root, patch.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, patch.original);
  }
  const viteCache = path.join(root, "node_modules/.vite");
  fs.mkdirSync(viteCache, { recursive: true });
  fs.writeFileSync(path.join(viteCache, "fixture"), "cached bundle");
  return { root, packagePath, viteCache };
}

test("installation patches all files, invalidates Vite cache and reruns without changes", t => {
  const { root, viteCache } = createInstallation(t);
  assert.deepEqual(patchInstalledLigatures(root), { changed: PATCHES.length, checked: PATCHES.length, version: EXPECTED_VERSION });
  assert.equal(fs.existsSync(viteCache), false);
  for (const patch of PATCHES) {
    assert.equal(fs.readFileSync(path.join(root, patch.file), "utf8"), patch.replacement);
  }
  fs.mkdirSync(viteCache);
  assert.deepEqual(patchInstalledLigatures(root), { changed: 0, checked: PATCHES.length, version: EXPECTED_VERSION });
  assert.equal(fs.existsSync(viteCache), true, "a no-op leaves the Vite cache intact");
});

test("installation rejects unsupported versions before writing files", t => {
  const { root, packagePath, viteCache } = createInstallation(t);
  fs.writeFileSync(packagePath, JSON.stringify({ version: "0.11.0" }));
  assert.throws(() => patchInstalledLigatures(root), /unsupported @xterm\/addon-ligatures version/);
  for (const patch of PATCHES) {
    assert.equal(fs.readFileSync(path.join(root, patch.file), "utf8"), patch.original);
  }
  assert.equal(fs.existsSync(viteCache), true);
});

test("installation validates every file before writing any", t => {
  const { root, viteCache } = createInstallation(t);
  fs.writeFileSync(path.join(root, PATCHES.at(-1).file), "upstream changed");
  assert.throws(() => patchInstalledLigatures(root), /unexpected ligatures font-cache patch shape/);
  for (const patch of PATCHES.slice(0, -1)) {
    assert.equal(fs.readFileSync(path.join(root, patch.file), "utf8"), patch.original);
  }
  assert.equal(fs.existsSync(viteCache), true);
});
