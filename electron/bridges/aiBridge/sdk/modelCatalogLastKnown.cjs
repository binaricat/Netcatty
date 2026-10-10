/* eslint-disable no-undef */

const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Last-known-good model catalog persistence. A successful live catalog fetch
// is rare (TTL-cached, coalesced), so this file is written at most once per
// fetch and read only when a live fetch fails — the safety net between a dead
// CLI catalog and build-time curated presets (copilot has no presets at all).
const LAST_KNOWN_CATALOG_FILE = "model-catalog-last-known.json";
const LAST_KNOWN_STORE_VERSION = 1;
// Generous per-entry cap so a huge provider catalog cannot grow the store file
// without bound.
const LAST_KNOWN_MAX_MODELS = 200;

function buildLastKnownCatalogPath(userDataDir) {
  if (!userDataDir) return null;
  return path.join(userDataDir, LAST_KNOWN_CATALOG_FILE);
}

/** Read the whole store; any corruption or absence degrades to {}. */
function readLastKnownCatalogStore(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== LAST_KNOWN_STORE_VERSION) return {};
    return parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch {
    return {};
  }
}

/**
 * Load the persisted catalog for one cache key. Returns null unless the entry
 * carries a non-empty models list — the renderer has nothing to show otherwise.
 */
function readLastKnownCatalogEntry(filePath, cacheKey) {
  if (!filePath || !cacheKey) return null;
  const entry = readLastKnownCatalogStore(filePath)[cacheKey];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return null;
  return entry;
}

/**
 * Persist one successful catalog. Keys are the same \0-joined
 * backend+binPath+runtime+envHash strings the in-memory TTL cache uses, so a
 * different CLI path or agent environment never clobbers another entry.
 * Returns false (no write) for empty catalogs, missing inputs, or IO errors —
 * persistence must never break the catalog path.
 */
function writeLastKnownCatalogEntry(filePath, cacheKey, { backend, models, currentModelId } = {}, { now = Date.now() } = {}) {
  if (!filePath || !cacheKey) return false;
  const trimmedModels = Array.isArray(models)
    ? models.filter((model) => model && model.id).slice(0, LAST_KNOWN_MAX_MODELS)
    : [];
  if (trimmedModels.length === 0) return false;
  try {
    const entries = readLastKnownCatalogStore(filePath);
    entries[cacheKey] = {
      backend: String(backend || ""),
      models: trimmedModels,
      currentModelId: currentModelId || null,
      fetchedAt: new Date(now).toISOString(),
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ version: LAST_KNOWN_STORE_VERSION, entries }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  LAST_KNOWN_CATALOG_FILE,
  LAST_KNOWN_MAX_MODELS,
  buildLastKnownCatalogPath,
  readLastKnownCatalogEntry,
  readLastKnownCatalogStore,
  writeLastKnownCatalogEntry,
};
