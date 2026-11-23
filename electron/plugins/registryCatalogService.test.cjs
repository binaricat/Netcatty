"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { RegistryCatalogService, REGISTRY_URL } = require("./registryCatalogService.cjs");
const { catalog, realFiles, makeFiles, responseFor } = require("./fixtures/staticDistributionFixture.cjs");

test("registry starts at a fixed anonymous pointer and retains only complete validated snapshots", async () => {
  let files = realFiles();
  const service = new RegistryCatalogService({ fetch: async (url, options) => {
    assert.equal(new URL(url).origin, "https://plugins.netcatty.app");
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
    assert.equal(options.referrerPolicy, "no-referrer"); assert.ok(options.signal);
    return responseFor(files, url);
  } });
  const good = await service.list();
  assert.equal(good.source, "registry"); assert.equal(good.entries.length, 2);
  assert.match(good.entries[0].selectionToken, /^[a-f0-9]{64}$/);
  for (const invalid of ["{", "{}", JSON.stringify({ schemaVersion: 2 }), '{"schemaVersion":1e999}', " ".repeat(16 * 1024 + 1)]) {
    files = realFiles(); files.set("/v1/snapshot.json", Buffer.from(invalid));
    const cached = await service.list();
    assert.equal(cached.source, "cached"); assert.ok(cached.error);
    assert.deepEqual(cached.entries, good.entries);
  }
  files = makeFiles([]);
  assert.deepEqual((await service.list()).entries, []);
});

test("offline first launch returns bundled source examples with no GitHub README fallback", async () => {
  let calls = 0;
  const service = new RegistryCatalogService({ fetch: async (url) => { calls++; assert.equal(url, REGISTRY_URL); throw new Error("offline"); }, manager: {
    install() { assert.fail("offline must not install"); },
  } });
  const snapshot = await service.list();
  assert.equal(snapshot.source, "builtin"); assert.equal(snapshot.entries.length, 2);
  await assert.rejects(service.readme(snapshot.entries[0].id, snapshot.entries[0].selectionToken), /No published README/);
  assert.equal(calls, 1);
  await assert.rejects(service.install(snapshot.entries[0].id, snapshot.entries[0].selectionToken), /browse-only/);
});

test("selection binds source and delivery metadata; changes and withdrawal cannot silently install", async () => {
  let files = realFiles(); const requests = [];
  const service = new RegistryCatalogService({ fetch: async (url) => { requests.push(url); return responseFor(files, url); }, manager: { install() { assert.fail("source-only must not install"); } } });
  const selected = (await service.list()).entries[0];
  assert.match(await service.readme(selected.id, selected.selectionToken), /Starter/);
  await assert.rejects(service.readme(selected.id, "bad"), /changed/);
  const before = requests.length;
  await assert.rejects(service.install(selected.id), /changed/); assert.equal(requests.length, before);
  await assert.rejects(service.install(selected.id, selected.selectionToken), /no published package/);
  const changed = structuredClone(catalog); changed[0].description += " changed";
  files = makeFiles(changed);
  await assert.rejects(service.install(selected.id, selected.selectionToken), /changed/);
  await assert.rejects(service.readme(selected.id, selected.selectionToken), /changed/);
  files = makeFiles([]);
  assert.deepEqual((await service.list()).entries, []);
  await assert.rejects(service.install(selected.id, selected.selectionToken), /curated catalog/);
});

test("README images are resolved only from the selected snapshot", async () => {
  const bytes = Buffer.from("verified image");
  const { digest } = require("./fixtures/staticDistributionFixture.cjs");
  const ref = { path: `/assets/${digest(bytes)}.png`, sha256: digest(bytes), size: bytes.length };
  const files = makeFiles(catalog, (_index, sidecar) => { sidecar.schemaVersion = 2; sidecar.plugins[0].readmeImages = [ref]; });
  files.set(ref.path, bytes);
  const requests = [];
  const service = new RegistryCatalogService({ fetch: async (url) => { requests.push(url); return responseFor(files, url); },
    resolveReadmeImage: async ({ read }) => { assert.deepEqual(await read(), bytes); return "data:image/png;base64,c2FmZQ=="; } });
  const selected = (await service.list()).entries[0];
  assert.deepEqual(await service.readmeImages(selected.id, selected.selectionToken), { [ref.path]: "data:image/png;base64,c2FmZQ==" });
  await assert.rejects(service.readmeImages(selected.id, "invalid"), /changed/);
  assert.equal(requests.filter((url) => url.endsWith(ref.path)).length, 1);
});

test("README image failures use placeholders and stale or disabled sources cannot return images", async () => {
  const { digest } = require("./fixtures/staticDistributionFixture.cjs");
  const bytes = Buffer.from("x");
  const ref = { path: `/assets/${digest(bytes)}.png`, sha256: digest(bytes), size: 1 };
  const files = makeFiles(catalog, (_index, sidecar) => { sidecar.schemaVersion = 2; sidecar.plugins[0].readmeImages = [ref]; });
  files.set(ref.path, bytes);
  let allowed = true;
  const service = new RegistryCatalogService({ fetch: async (url) => responseFor(files, url), sourceGuard: () => { if (!allowed) throw new Error("disabled"); }, resolveReadmeImage: async () => { throw new Error("decode failed"); } });
  const selected = (await service.list()).entries[0];
  assert.deepEqual(await service.readmeImages(selected.id, selected.selectionToken), {});
  allowed = false;
  await assert.rejects(service.readmeImages(selected.id, selected.selectionToken), /disabled/);
});

test("concurrent list refreshes share one pointer request and complete document set", async () => {
  let finish; const requests = []; const files = realFiles();
  const service = new RegistryCatalogService({ fetch: async (url) => { requests.push(url); if (url === REGISTRY_URL) return new Promise((resolve) => { finish = resolve; }); return responseFor(files, url); } });
  const first = service.list(); const second = service.list();
  finish(responseFor(files, REGISTRY_URL));
  assert.deepEqual(await first, await second); assert.equal(requests.length, 4);
});

test("invalid sources and unknown JSON fields cannot poison good offline snapshots", async () => {
  let files = realFiles(); let offline = false;
  const service = new RegistryCatalogService({ fetch: async (url) => { if (offline) throw new Error("offline"); return responseFor(files, url); } });
  const good = await service.list();
  let nested = null; for (let i = 0; i < 130; i++) nested = { child: nested };
  const bad = [
    { ...catalog[0], readme: "\t../main/README.md" }, { ...catalog[0], repository: "example/.." },
    { ...catalog[0], unknownNestedField: nested }, { ...catalog[0], unknownField: true },
    { ...catalog[0], readmeAsset: { url: "https://plugins.netcatty.app/a", sha256: "a".repeat(64) } },
  ];
  for (const entry of bad) {
    files = makeFiles([entry]); offline = false;
    const rejected = await service.list(); assert.equal(rejected.source, "cached"); assert.ok(rejected.error);
    assert.deepEqual(rejected.entries, good.entries);
    offline = true; assert.deepEqual((await service.list()).entries, good.entries);
  }
});

test("snapshot preparation failure leaves private resources and public tokens unchanged", async () => {
  const service = new RegistryCatalogService({ fetch: async (url) => responseFor(realFiles(), url) });
  const good = await service.list(); const resources = service.resources;
  const originalClone = global.structuredClone;
  try { global.structuredClone = () => { throw new Error("synthetic clone failure"); }; assert.equal(await service.refresh(), false); }
  finally { global.structuredClone = originalClone; }
  assert.equal(service.resources, resources);
  service.fetch = async () => { throw new Error("offline"); };
  assert.deepEqual((await service.list()).entries, good.entries);
});
