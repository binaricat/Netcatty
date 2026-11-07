"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { assertDownloadUrl, fetchBounded, validateCatalog } = require("./catalogService.cjs");
const { RegistryCatalogService, REGISTRY_URL } = require("./registryCatalogService.cjs");
const { fetchVerified, assertAsset } = require("./distributionSnapshot.cjs");
const { read, digest, catalog, delivery, realFiles, makeFiles, responseFor } = require("./fixtures/staticDistributionFixture.cjs");

test("current-contract fixture hashes and all README/icon assets verify without GitHub requests", async () => {
  assert.equal(digest(read("snapshot.json")), "25400e152accb1faa3cb28d86cf423569fa02db250397e0816c275c72d201705");
  assert.equal(digest(read("delivery.json")), "dd5c2e20defbbf2126541de40d8f59d5a77f146c83e0e0cda8d3c4054a472988");
  const requests = []; const files = realFiles();
  const fetch = async (url, options) => {
    requests.push(url); assert.equal(new URL(url).origin, "https://plugins.netcatty.app");
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
    return responseFor(files, url);
  };
  const service = new RegistryCatalogService({ fetch });
  const snapshot = await service.list();
  assert.equal(snapshot.error, null); assert.equal(snapshot.source, "registry");
  assert.equal(requests.length, 4); assert.equal(requests[0], REGISTRY_URL);
  for (const entry of snapshot.entries) {
    const resource = delivery.plugins.find((item) => item.id === entry.id);
    assert.equal(await service.readme(entry.id, entry.selectionToken), read(resource.readme.path.slice(1)).toString());
    for (const icon of [resource.iconLight, resource.iconDark]) if (icon) {
      assertAsset(icon, ["png", "webp"]);
      const bytes = await fetchVerified(icon, fetch);
      assert.equal(bytes.length, icon.size); assert.equal(digest(bytes), icon.sha256);
    }
    assert.equal(entry.artifact, undefined);
    assert.equal(resource.avatar, null); assert.equal(resource.artifact, null);
  }
  assert.ok(requests.every((url) => !/github/u.test(url)));
});

test("GitHub, tracking and noncanonical URLs are rejected before any upstream request", async () => {
  for (const url of [
    "https://api.github.com/repos/a/b", "https://raw.githubusercontent.com/a/b/main/README.md",
    "https://avatars.githubusercontent.com/u/1", "https://github.com/a/b/releases/download/v1/a.ncpkg",
    "https://release-assets.githubusercontent.com/a", "https://objects.githubusercontent.com/a",
    "https://plugins.netcatty.app.attacker.invalid/a", "https://plugins.netcatty.app@attacker.invalid/a",
    "http://plugins.netcatty.app/a", "https://plugins.netcatty.app/a?track=1", "https://plugins.netcatty.app/a#fragment",
    "https://plugins.netcatty.app/a/../b", "https://plugins.netcatty.app/%2e%2e/b", "https://plugins.netcatty.app/\ta",
  ]) {
    assert.throws(() => assertDownloadUrl(url));
    assert.throws(() => validateCatalog([{ ...catalog[0], artifact: { url, sha256: "a".repeat(64) } }]));
    await assert.rejects(fetchBounded(url, 1024, () => assert.fail("invalid source must not be requested")));
  }
});

test("official responses never redirect to GitHub or another official path", async () => {
  for (const location of ["https://github.com/a", "https://raw.githubusercontent.com/a/b/main/catalog.json", "https://plugins.netcatty.app/another.json"]) {
    const requests = [];
    await assert.rejects(fetchBounded(REGISTRY_URL, 1024, async (url) => {
      requests.push(url); return new Response(null, { status: 302, headers: { location } });
    }), /redirects/);
    assert.deepEqual(requests, [REGISTRY_URL]);
  }
});

test("cross-document mismatches, withdrawn versions and unsupported assets preserve the complete good cache", async () => {
  let files = realFiles(); const service = new RegistryCatalogService({ fetch: async (url) => responseFor(files, url) });
  const good = await service.list(); const goodResources = service.resources;
  const mutations = [
    (index, sidecar) => { sidecar.registryCommit = "a".repeat(40); },
    (index, sidecar) => { sidecar.plugins[0].commit = "a".repeat(40); },
    (index, sidecar) => { sidecar.plugins.push(sidecar.plugins[0]); },
    (index, sidecar) => { sidecar.plugins.pop(); },
    (index, sidecar) => { sidecar.plugins[0].readme.path = "https://raw.githubusercontent.com/a/b/main/README.md"; },
    (index, sidecar) => { sidecar.plugins[0].readme.path = `/assets/${sidecar.plugins[0].readme.sha256}.png`; },
    (index, sidecar) => { sidecar.plugins[0].iconLight.path = `/assets/${sidecar.plugins[0].iconLight.sha256}.md`; },
    (index, sidecar) => { sidecar.plugins[0].avatar = { path: "/assets/avatar.png" }; },
    (index, sidecar) => { sidecar.plugins[0].artifact = { path: "/assets/package.ncpkg" }; },
    (index, sidecar) => { sidecar.schemaVersion = 2; sidecar.plugins[0].readmeImages = [{ path: "https://evil.example/a.png", sha256: "a".repeat(64), size: 1 }]; },
    (index, sidecar) => { sidecar.schemaVersion = 2; sidecar.plugins[0].readmeImages = [{ path: `/assets/${"a".repeat(64)}.png`, sha256: "b".repeat(64), size: 1 }]; },
    (index, sidecar) => { sidecar.schemaVersion = 2; sidecar.plugins[0].readmeImages = Array(9).fill({ path: `/assets/${"a".repeat(64)}.png`, sha256: "a".repeat(64), size: 1 }); },
    (index) => { index.plugins[0].versions[0].withdrawal = { at: "2026-10-26T00:00:00Z", reason: "synthetic withdrawal", advisory: "https://github.com/example/advisory" }; },
    (index) => { index.plugins[0].versions[0].entry.description += " mismatch"; },
    (index) => { index.plugins[0].current = "9.0.0"; },
    (index) => { index.plugins.push(index.plugins[0]); },
    (index, sidecar) => { sidecar.unknown = true; },
  ];
  for (const mutate of mutations) {
    files = makeFiles(catalog, mutate);
    // Preserve the pointer's trusted registry identity when testing delivery mismatch.
    const pointer = JSON.parse(files.get("/v1/snapshot.json")); pointer.registryCommit = delivery.registryCommit;
    files.set("/v1/snapshot.json", Buffer.from(JSON.stringify(pointer)));
    const rejected = await service.list();
    assert.equal(rejected.source, "cached"); assert.ok(rejected.error);
    assert.deepEqual(rejected.entries, good.entries); assert.equal(service.resources, goodResources);
  }
});

test("pointer/document/resource byte mismatches and partial availability never publish partial state", async () => {
  let files = realFiles(); const service = new RegistryCatalogService({ fetch: async (url) => responseFor(files, url) });
  const good = await service.list();
  const pointer = JSON.parse(read("snapshot.json"));
  for (const name of ["catalog", "index", "delivery"]) {
    files = realFiles(); files.set(pointer[name].path, Buffer.from("{}"));
    const rejected = await service.list(); assert.equal(rejected.source, "cached"); assert.deepEqual(rejected.entries, good.entries);
    files = realFiles(); files.delete(pointer[name].path);
    assert.deepEqual((await service.list()).entries, good.entries);
  }
  files = realFiles(); const altered = structuredClone(pointer); altered.catalog.path = "/catalog.json";
  files.set("/v1/snapshot.json", Buffer.from(JSON.stringify(altered)));
  assert.match((await service.list()).error, /resource reference/);
  files = realFiles(); files.set(delivery.plugins[0].readme.path, Buffer.from("x".repeat(delivery.plugins[0].readme.size)));
  await assert.rejects(service.readme(good.entries[0].id, good.entries[0].selectionToken), /SHA-256 mismatch/);
});
