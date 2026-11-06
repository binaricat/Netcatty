"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RegistryCatalogService } = require("./registryCatalogService.cjs");
const { PluginContributionIconService } = require("./contributionIconService.cjs");
const { MarketSourcesService } = require("./marketSourcesService.cjs");
const { OFFICIAL_SOURCE, LOCAL_SOURCE, thirdPartySource } = require("./sourceIdentity.cjs");
const { catalog, delivery, digest, makeFiles, read } = require("./fixtures/staticDistributionFixture.cjs");

const sourcePng = read(delivery.plugins[0].iconLight.path.slice(1));
const avatar = { path: `/assets/${digest(sourcePng)}.png`, sha256: digest(sourcePng), size: sourcePng.length };
function filesFor(entries = catalog, change = () => {}) {
  const files = makeFiles(entries, (index, sidecar) => {
    sidecar.schemaVersion = 2;
    for (const item of sidecar.plugins) {
      item.avatar = structuredClone(avatar);
      const entry = entries.find((entry) => entry.id === item.id);
      if (entry.artifact) {
        item.artifact = { path: `/assets/${entry.artifact.sha256}.ncpkg`, sha256: entry.artifact.sha256, size: 1 };
        index.plugins.find((plugin) => plugin.id === item.id).versions[0].distribution = "release";
      }
    }
    change(index, sidecar);
  });
  files.set(avatar.path, sourcePng);
  return files;
}
function imageService(rasterizeIcon) {
  return new PluginContributionIconService({ rasterizeIcon: rasterizeIcon ?? (async () => {
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12); png.writeUInt32BE(32, 16); png.writeUInt32BE(32, 20); return png;
  }) });
}
function registry(options = {}) {
  const requests = [];
  let files = options.files ?? filesFor();
  const service = new RegistryCatalogService({ ...options,
    fetch: options.fetch ?? (async (url, init) => {
      requests.push(url);
      assert.equal(new URL(url).origin, options.source?.origin ?? OFFICIAL_SOURCE.origin);
      assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
      return files.has(new URL(url).pathname) ? new Response(files.get(new URL(url).pathname)) : new Response(null, { status: 404 });
    }),
    resolveAvatar: options.resolveAvatar ?? ((request) => imageServiceSingleton.resolveCatalogAvatar(request)),
  });
  const imageServiceSingleton = imageService();
  return { service, requests, setFiles(value) { files = value; } };
}

test("v2 avatars use verified same-origin bytes and the shared image cache without GitHub", async () => {
  const r = registry(); const snapshot = await r.service.list(); assert.equal(snapshot.error, null);
  const entry = snapshot.entries[0];
  const values = await Promise.all([r.service.author(entry.id, entry.selectionToken), r.service.author(entry.id, entry.selectionToken)]);
  assert.deepEqual(values[0], values[1]); assert.match(values[0].avatar, /^data:image\/png;base64,/);
  assert.equal(values[0].officialMaintained, true); assert.equal(values[0].author, "Netcatty");
  assert.equal(r.requests.filter((url) => new URL(url).pathname === avatar.path).length, 1);
  assert.ok(r.requests.every((url) => new URL(url).origin === OFFICIAL_SOURCE.origin));
  await r.service.author(entry.id, entry.selectionToken);
  assert.equal(r.requests.length, 5, "cached raster avoids another download");
});

test("third-party copies, community entries and local imports cannot acquire maintenance authority", async () => {
  const copied = registry({ source: thirdPartySource("Netcatty official", "https://community.example.com") });
  const entry = (await copied.service.list()).entries[0];
  assert.equal((await copied.service.author(entry.id, entry.selectionToken)).officialMaintained, false);
  const community = structuredClone(catalog[0]); community.id = "com.community.official";
  community.manifest.id = community.id; community.author = "Netcatty official"; community.manifest.publisher = "netcatty";
  const r = registry({ files: filesFor([community]) }); const listed = (await r.service.list()).entries[0];
  assert.equal((await r.service.author(listed.id, listed.selectionToken)).officialMaintained, false);
  const local = new MarketSourcesService({ database: { getActivePlugin: () => ({ id: catalog[0].id, activeVersion: catalog[0].version,
    source: LOCAL_SOURCE, archiveSha256: "a".repeat(64), manifest: catalog[0].manifest, runtime: {} }) } });
  assert.equal((await local.author({ kind: "installed", pluginId: catalog[0].id })).officialMaintained, false);
  await assert.rejects(local.author({ kind: "installed", pluginId: catalog[0].id, officialMaintained: true }), /Invalid/);
});

test("avatar failure, redirects and mismatched bytes yield a placeholder without another origin", async () => {
  for (const kind of ["missing", "hash", "format", "redirect"]) {
    const files = filesFor(); const requests = [];
    const r = registry({ files, fetch: async (url) => {
      requests.push(url); const p = new URL(url).pathname;
      if (p === avatar.path) {
        if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://avatars.githubusercontent.com/u/1" } });
        if (kind === "missing") return new Response(null, { status: 404 });
        if (kind === "hash") return new Response(Buffer.alloc(sourcePng.length));
      }
      return new Response(files.get(p));
    }, ...(kind === "format" ? { resolveAvatar: async () => { throw new Error("Invalid PNG"); } } : {}) });
    const entry = (await r.service.list()).entries[0]; const value = await r.service.author(entry.id, entry.selectionToken);
    assert.equal(value.avatar, null, kind); assert.equal(value.officialMaintained, true);
    assert.ok(requests.every((url) => new URL(url).origin === OFFICIAL_SOURCE.origin));
  }
});

test("avatar schema rejects foreign paths, non-raster formats and invalid sizes before fetching", async () => {
  for (const ref of [
    { ...avatar, path: "https://avatars.githubusercontent.com/u/1" },
    { ...avatar, path: `/assets/${avatar.sha256}.svg` },
    { ...avatar, path: `/assets/${"a".repeat(64)}.png` },
    { ...avatar, size: 0 }, { ...avatar, size: 256 * 1024 + 1 }, { ...avatar, size: 1.5 },
  ]) {
    const r = registry({ files: filesFor(catalog, (_index, delivery) => { delivery.plugins[0].avatar = ref; }) });
    const result = await r.service.list(); assert.ok(result.error, JSON.stringify(ref));
    assert.equal(r.requests.length, 4, "invalid delivery cannot cause an avatar request");
  }
});

test("v2 package references enforce the publisher's positive 16MiB bound without installing", async () => {
  const entry = structuredClone(catalog[0]);
  entry.artifact = { sha256: "a".repeat(64), url: `${OFFICIAL_SOURCE.origin}/assets/${"a".repeat(64)}.ncpkg` };
  for (const size of [0, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
    const r = registry({ files: filesFor([entry], (_index, sidecar) => { sidecar.plugins[0].artifact.size = size; }) });
    const snapshot = await r.service.list();
    assert.equal(Boolean(snapshot.error), size !== 16 * 1024 * 1024);
    assert.equal(r.requests.length, 4, "catalog validation never downloads or installs the package");
  }
});

test("a changed selection or removed source cannot publish an in-flight avatar result", async () => {
  for (const change of ["selection", "source"]) {
    let release; let entered; let enabled = true;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const r = registry({ sourceGuard() { if (!enabled) throw new Error("Source removed"); }, resolveAvatar: async () => { entered(); await gate; return "data:image/png;base64,eA=="; } });
    const entry = (await r.service.list()).entries[0]; const pending = r.service.author(entry.id, entry.selectionToken); await started;
    if (change === "selection") { r.setFiles(filesFor(catalog, (_i, sidecar) => { sidecar.plugins[0].avatar = null; })); await r.service.refresh(); }
    else enabled = false;
    release(); await assert.rejects(pending, /changed|removed/);
  }
});

test("installed presentation requires exact source/version/package/manifest and rejects replacement during load", async () => {
  const entry = structuredClone(catalog[0]); entry.artifact = { sha256: "a".repeat(64), url: `${OFFICIAL_SOURCE.origin}/assets/${"a".repeat(64)}.ncpkg` };
  let plugin = { id: entry.id, activeVersion: entry.version, archiveSha256: entry.artifact.sha256, source: OFFICIAL_SOURCE, manifest: entry.manifest, runtime: {} };
  const requests = []; const files = filesFor([entry]);
  const database = { getActivePlugin: () => plugin, db: { prepare: () => ({ get: () => undefined }) } };
  const service = new MarketSourcesService({ database, fetch: async (url) => { requests.push(url); return new Response(files.get(new URL(url).pathname)); } });
  const query = { kind: "installed", pluginId: entry.id };
  assert.equal((await service.author(query)).officialMaintained, false); assert.equal(requests.length, 0);
  await service.list(); assert.equal((await service.author(query)).officialMaintained, true);
  for (const patch of [{ activeVersion: "9.0.0" }, { archiveSha256: "b".repeat(64) }, { manifest: { ...entry.manifest, publisher: "other" } }, { source: LOCAL_SOURCE }]) {
    const saved = plugin; plugin = { ...plugin, ...patch };
    assert.equal((await service.author(query)).officialMaintained, false); plugin = saved;
  }
  let release; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  service.catalogs.get("official").resolveAvatar = async () => { entered(); await new Promise((resolve) => { release = resolve; }); return null; };
  const pending = service.author(query); await started; plugin = { ...plugin, archiveSha256: "b".repeat(64) }; release();
  await assert.rejects(pending, /Installed plugin changed/);
});

test("avatar decoding validates bytes and uses the existing bounded rasterizer", async () => {
  let calls = 0;
  const service = imageService(async () => { calls++; throw new Error("Decode failed"); });
  const request = { sourceId: "official", reference: avatar, read: async () => sourcePng };
  await assert.rejects(service.resolveCatalogAvatar(request), /Decode failed/); assert.equal(calls, 1);
  await assert.rejects(service.resolveCatalogAvatar({ ...request, read: async () => Buffer.alloc(sourcePng.length) }), /bytes/); assert.equal(calls, 1);
  await assert.rejects(service.resolveCatalogAvatar({ ...request, reference: { ...avatar, path: `/assets/${avatar.sha256}.webp` } }), /format|signature/); assert.equal(calls, 1);
  const cached = imageService();
  await cached.resolveCatalogAvatar(request);
  await assert.rejects(cached.resolveCatalogAvatar({ ...request, reference: { ...avatar, size: avatar.size + 1 } }), /bytes/);
  await assert.rejects(cached.resolveCatalogAvatar({ ...request, reference: { ...avatar, path: `/assets/${avatar.sha256}.webp` } }), /format|signature/);
});
