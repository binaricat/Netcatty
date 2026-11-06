import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateManifestValue } from "./manifest.js";
import { checkPluginCompatibility } from "./compatibility.js";

const manifest = JSON.parse(await readFile(new URL("../../../examples/plugins/database-minimal/netcatty.plugin.json", import.meta.url), "utf8"));

test("byte stream packages require negotiated features and exact resources in optional grants", () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  assert.equal(validateManifestValue({ ...manifest, features: {} }).valid, false);
  for (const resources of [["*"], ["tcp://*:3306"], ["tcp://host:3306/"], ["udp://host:3306"], ["https://host"]]) {
    assert.equal(validateManifestValue({ ...manifest, permissions: { required: ["commands", "views"], optional: [{ permission: "network.stream", resources }] } }).valid, false);
  }
  assert.equal(validateManifestValue({ ...manifest, permissions: { required: ["commands", "views"], optional: ["network.stream"] } }).valid, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: "1.0.0", features: [] }).compatible, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: "1.0.0", features: ["network.byte-streams"] }).compatible, true);
});
