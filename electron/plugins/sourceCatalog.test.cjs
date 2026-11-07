"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RegistryCatalogService } = require("./registryCatalogService.cjs");
const { thirdPartySource } = require("./sourceIdentity.cjs");
const { catalog, realFiles, makeFiles, digest } = require("./fixtures/staticDistributionFixture.cjs");
const first = thirdPartySource("First", "https://first.example.com");
const second = thirdPartySource("Netcatty", "https://second.example.com");

test("identical mirrored catalogs never share selection tokens or offline cache", async () => {
  const service = (source) => new RegistryCatalogService({ source, fetch: async (url) => {
    assert.equal(new URL(url).origin, source.origin);
    return new Response(realFiles().get(new URL(url).pathname));
  } });
  const a = service(first); const b = service(second);
  const entryA = (await a.list()).entries[0];
  const entryB = (await b.list()).entries[0];
  assert.notEqual(entryA.selectionToken, entryB.selectionToken);
  await assert.rejects(b.readme(entryB.id, entryA.selectionToken), /changed/);
  const offline = new RegistryCatalogService({ source: second, fetch: async () => { throw new Error("offline"); } });
  assert.deepEqual((await offline.list()).entries, [], "third-party failure never substitutes the official bundled catalog");
});

test("delivery v2 binds package bytes, size, source and fresh non-withdrawn index before install", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic package bytes; manager is stubbed");
  const sha256 = digest(bytes);
  const asset = `/assets/${sha256}.ncpkg`;
  const entry = { ...structuredClone(catalog[0]), artifact: { url: `${first.origin}${asset}`, sha256 } };
  let files = makeFiles([entry], (index, delivery) => {
    index.plugins[0].versions[0].distribution = "release";
    delivery.schemaVersion = 2;
    delivery.plugins[0].artifact = { path: asset, sha256, size: bytes.length };
  });
  files.set(asset, bytes);
  let calls = 0;
  const service = new RegistryCatalogService({ source: first, getTempFilePath: (name) => path.join(root, name), fetch: async (url) => {
    assert.equal(new URL(url).origin, first.origin);
    const body = files.get(new URL(url).pathname);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  }, manager: { install(archive, options) {
    assert.deepEqual(fs.readFileSync(archive), bytes);
    assert.equal(options.enable, false);
    assert.equal(options.source.id, first.id);
    assert.equal(options.catalog.artifact.sha256, sha256);
    calls++;
  } } });
  const selected = (await service.list()).entries[0];
  assert.ok(selected, service.error);
  await service.install(selected.id, selected.selectionToken);
  assert.equal(calls, 1);
  files = makeFiles([]);
  await assert.rejects(service.install(selected.id, selected.selectionToken), /curated catalog/);
  assert.equal(calls, 1);
});
