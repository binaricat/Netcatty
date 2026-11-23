/* eslint-disable no-undef */

const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Last-known-good model catalog persistence. A successful live catalog fetch
// is rare (TTL-cached, coalesced), so this file is written at most once per
// fetch and read only when a live fetch fails - the safety net between a dead
// CLI catalog and build-time curated presets (copilot has no presets at all).
const LAST_KNOWN_CATALOG_FILE = "model-catalog-last-known.json";
const LAST_KNOWN_STORE_VERSION = 1;
// Generous per-entry cap so a huge provider catalog cannot grow the store file
// without bound.
const LAST_KNOWN_MAX_MODELS = 200;
// Store-wide cap mirroring the in-memory TTL cache size. Fingerprinted cache
// keys change whenever an agent's CLI path or environment changes, so without
// a cap the store would retain one entry per historical profile forever. Over
// the cap the least recently updated entries are evicted.
const LAST_KNOWN_MAX_ENTRIES = 32;

function buildLastKnownCatalogPath(userDataDir) {
  if (!userDataDir) return null;
  return path.join(userDataDir, LAST_KNOWN_CATALOG_FILE);
}

/** Read the full store object ({ entries, aliases }); any corruption degrades to empty maps. */
function readLastKnownCatalogFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== LAST_KNOWN_STORE_VERSION) {
      return { entries: {}, aliases: {} };
    }
    const aliases = parsed.aliases && typeof parsed.aliases === "object" && !Array.isArray(parsed.aliases)
      ? parsed.aliases
      : {};
    return {
      entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
      aliases,
    };
  } catch {
    return { entries: {}, aliases: {} };
  }
}

/** Read the whole store; any corruption or absence degrades to {}. */
function readLastKnownCatalogStore(filePath) {
  return readLastKnownCatalogFile(filePath).entries;
}

function pruneAliasesForEntries(aliases, entries) {
  const pruned = {};
  const validPairs = Object.entries(aliases || {}).filter(
    ([aliasKey, targetKey]) => typeof aliasKey === "string"
      && typeof targetKey === "string"
      && Object.prototype.hasOwnProperty.call(entries, targetKey),
  );
  const capped = validPairs.slice(-LAST_KNOWN_MAX_ENTRIES);
  for (const [aliasKey, targetKey] of capped) {
    pruned[aliasKey] = targetKey;
  }
  return pruned;
}

/**
 * Load the persisted catalog for one cache key. Returns null unless the entry
 * carries a non-empty models list - the renderer has nothing to show otherwise.
 */
function readLastKnownCatalogEntry(filePath, cacheKey) {
  if (!filePath || !cacheKey) return null;
  const entry = readLastKnownCatalogStore(filePath)[cacheKey];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return null;
  return entry;
}

/**
 * Resolve a persisted alias (for a bare command or Cursor sentinel) back to
 * its exact persisted catalog cache key, or null if absent/evicted.
 * For backward compatibility with pre-alias version-1 entries (even in a
 * partially migrated store where other backends already wrote aliases),
 * falls back only when there is a single unambiguous unmigrated entry
 * matching (backendKey, runtime, envHash).
 */
function readLastKnownCatalogAlias(filePath, aliasKey, legacyScope = null) {
  if (!filePath || !aliasKey) return null;
  const { entries, aliases } = readLastKnownCatalogFile(filePath);
  const targetKey = aliases[aliasKey];
  if (typeof targetKey === "string" && Object.prototype.hasOwnProperty.call(entries, targetKey)) {
    return targetKey;
  }
  if (!legacyScope?.backendKey || !legacyScope?.runtime || !legacyScope?.envHash) {
    return null;
  }
  let matchedKey = null;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) continue;
    if (entry.aliasMigrated === true) continue;
    const parts = key.split("\u0000");
    if (
      parts.length !== 4
      || parts[0] !== legacyScope.backendKey
      || parts[2] !== legacyScope.runtime
      || parts[3] !== legacyScope.envHash
    ) {
      continue;
    }
    if (matchedKey !== null) return null; // ambiguous legacy entries
    matchedKey = key;
  }
  return matchedKey;
}

/**
 * Persist a mapping from a side-effect-free alias key (bare command or Cursor
 * sentinel) to its resolved catalog cache key so cacheOnly hydration can
 * recover the exact entry across restarts without PATH/auth probing or
 * cross-matching explicit custom binaries.
 */
function writeLastKnownCatalogAlias(filePath, aliasKey, targetKey) {
  if (!filePath || !aliasKey || !targetKey || aliasKey === targetKey) return false;
  try {
    const { entries, aliases } = readLastKnownCatalogFile(filePath);
    if (!Object.prototype.hasOwnProperty.call(entries, targetKey)) return false;
    if (aliases[aliasKey] === targetKey) return false;
    const nextAliases = pruneAliasesForEntries({ ...aliases, [aliasKey]: targetKey }, entries);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({ version: LAST_KNOWN_STORE_VERSION, entries, aliases: nextAliases }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh the persisted current id for one cache key without replacing the
 * persisted models list. Current-only catalogs (models: [] with a valid
 * currentModelId) still carry the user's selection, but a models-less entry
 * is unservable, so with no persisted entry there is nothing to admit.
 * fetchedAt keeps its original meaning (when the models were fetched).
 * Returns true when the persisted entry was updated.
 */
function refreshLastKnownCatalogCurrentId(filePath, cacheKey, currentModelId) {
  if (!filePath || !cacheKey || !currentModelId) return false;
  try {
    const { entries, aliases } = readLastKnownCatalogFile(filePath);
    const entry = entries[cacheKey];
    if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return false;
    if (entry.currentModelId === currentModelId) return false;
    // The refreshed id may be absent from the persisted list: it arrived on a
    // current-only catalog whose models were not admitted, so only the id
    // was adopted. Store a synthesized minimal row for it (label = the id)
    // instead of leaving the persisted current id dangling - a dangling id
    // makes the read-back serve a non-empty list missing the current row, so
    // the picker shows the old row while the send preflight adopts the new
    // id. Clearing the id would discard the user's selection entirely, and
    // the send path already accepts id-only rows, so synthesizing keeps
    // picker and send in agreement at the cost of one coarse entry.
    let models = entry.models;
    if (!models.some((model) => model && model.id === currentModelId)) {
      models = [...models];
      // Mirror writeLastKnownCatalogEntry: keep the store within the same
      // per-entry cap by evicting the oldest row for the synthesized one.
      if (models.length >= LAST_KNOWN_MAX_MODELS) models.pop();
      models.push({ id: currentModelId, name: currentModelId });
    }
    entries[cacheKey] = { ...entry, models, currentModelId };
    const nextAliases = pruneAliasesForEntries(aliases, entries);
    writeFileSync(
      filePath,
      `${JSON.stringify({ version: LAST_KNOWN_STORE_VERSION, entries, aliases: nextAliases }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist one successful catalog. Keys are the same \0-joined
 * backend+binPath+runtime+envHash strings the in-memory TTL cache uses, so a
 * different CLI path or agent environment never clobbers another entry.
 * Returns false (no write) for empty catalogs, missing inputs, or IO errors -
 * persistence must never break the catalog path.
 */
function writeLastKnownCatalogEntry(filePath, cacheKey, { backend, models, currentModelId } = {}, { now = Date.now() } = {}) {
  if (!filePath || !cacheKey) return false;
  const validModels = Array.isArray(models)
    ? models.filter((model) => model && model.id)
    : [];
  if (validModels.length === 0) return false;
  // The persisted current id must survive the cap: a capped set that omits it
  // would serve a last-known-good catalog whose current id has no picker row,
  // and the send preflight and the picker would disagree again.
  let trimmedModels = validModels.slice(0, LAST_KNOWN_MAX_MODELS);
  if (currentModelId && !trimmedModels.some((model) => model.id === currentModelId)) {
    const current = validModels.find((model) => model.id === currentModelId);
    if (current) {
      if (trimmedModels.length >= LAST_KNOWN_MAX_MODELS) trimmedModels.pop();
      trimmedModels.push(current);
    }
  }
  try {
    const { entries, aliases } = readLastKnownCatalogFile(filePath);
    entries[cacheKey] = {
      backend: String(backend || ""),
      models: trimmedModels,
      currentModelId: currentModelId || null,
      fetchedAt: new Date(now).toISOString(),
      aliasMigrated: true,
    };
    const orderedKeys = Object.keys(entries).sort((a, b) => {
      const timeA = Date.parse(entries[a]?.fetchedAt || "") || 0;
      const timeB = Date.parse(entries[b]?.fetchedAt || "") || 0;
      return timeA - timeB;
    });
    while (orderedKeys.length > LAST_KNOWN_MAX_ENTRIES) {
      delete entries[orderedKeys.shift()];
    }
    const nextAliases = pruneAliasesForEntries(aliases, entries);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({ version: LAST_KNOWN_STORE_VERSION, entries, aliases: nextAliases }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  LAST_KNOWN_CATALOG_FILE,
  LAST_KNOWN_MAX_ENTRIES,
  LAST_KNOWN_MAX_MODELS,
  buildLastKnownCatalogPath,
  readLastKnownCatalogAlias,
  readLastKnownCatalogEntry,
  readLastKnownCatalogStore,
  refreshLastKnownCatalogCurrentId,
  writeLastKnownCatalogAlias,
  writeLastKnownCatalogEntry,
};
