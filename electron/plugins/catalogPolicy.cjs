"use strict";

const { assertBrowserOnlyPlugin } = require("../../domain/pluginRuntimePolicy.cjs");

function assertCatalogManifest(manifest, expected) {
  if (manifest.id !== expected.id || manifest.version !== expected.version) {
    throw new Error("Catalog package identity/version mismatch");
  }
  assertBrowserOnlyPlugin(manifest);
  if (!manifest.license || manifest.license !== expected.license) throw new Error("Catalog package license mismatch");
}

module.exports = { assertCatalogManifest };
