"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = path.join(__dirname, "static-distribution");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (name) => fs.readFileSync(path.join(root, name));
const catalog = JSON.parse(read("catalog.json"));
const delivery = JSON.parse(read("delivery.json"));
function realFiles() {
  const pointer = JSON.parse(read("snapshot.json"));
  const files = new Map([["/v1/snapshot.json", read("snapshot.json")]]);
  for (const name of ["catalog", "index", "delivery"]) files.set(pointer[name].path, read(`${name}.json`));
  for (const name of fs.readdirSync(path.join(root, "assets"))) files.set(`/assets/${name}`, read(`assets/${name}`));
  return files;
}
function makeFiles(entries = catalog, mutate = () => {}) {
  const index = { schemaVersion: 1, plugins: entries.map((entry) => ({ id: entry.id, current: entry.version, versions: [{ entry: structuredClone(entry), distribution: "source-only", withdrawal: null }] })) };
  const sidecar = { ...structuredClone(delivery), plugins: entries.map((entry) => ({ ...structuredClone(delivery.plugins.find((item) => item.id === entry.id) ?? delivery.plugins[0]), id: entry.id, version: entry.version, repository: entry.repository, commit: entry.commit })) };
  mutate(index, sidecar);
  const catalogBytes = Buffer.from(JSON.stringify(entries));
  const indexBytes = Buffer.from(JSON.stringify(index));
  sidecar.catalogSha256 = digest(catalogBytes); sidecar.indexSha256 = digest(indexBytes);
  const deliveryBytes = Buffer.from(JSON.stringify(sidecar));
  const snapshotId = digest(deliveryBytes);
  const pointer = { schemaVersion: 1, registryCommit: sidecar.registryCommit, snapshotId };
  const files = realFiles();
  for (const [name, bytes] of [["catalog", catalogBytes], ["index", indexBytes], ["delivery", deliveryBytes]]) {
    const ref = { path: `/snapshots/${snapshotId}/${name}.json`, size: bytes.length, sha256: digest(bytes) };
    pointer[name] = ref; files.set(ref.path, bytes);
  }
  files.set("/v1/snapshot.json", Buffer.from(JSON.stringify(pointer)));
  return files;
}
function responseFor(files, url) {
  if (new URL(url).origin !== "https://plugins.netcatty.app") throw new Error("Unexpected upstream origin");
  const bytes = files.get(new URL(url).pathname);
  return bytes ? new Response(bytes) : new Response("Missing fixture", { status: 404 });
}
module.exports = { root, read, digest, catalog, delivery, realFiles, makeFiles, responseFor };
