"use strict";
const { PluginSourceRegistry } = require("./sourceRegistry.cjs");
const { RegistryCatalogService } = require("./registryCatalogService.cjs");
const { createSourceFetch } = require("./sourceFetch.cjs");
const { isDeepStrictEqual } = require("node:util");

const installedIdentity = (plugin) => JSON.stringify([plugin?.id, plugin?.activeVersion, plugin?.archiveSha256, plugin?.source, plugin?.manifest, plugin?.runtime?.quarantinedAt]);

class MarketSourcesService {
  constructor(options) {
    this.options = options;
    this.manager = options.manager;
    this.registry = new PluginSourceRegistry(options.database);
    this.catalogs = new Map();
    this.catalogIdentities = new Map();
    this.changeListeners = new Set();
  }
  onDidChange(listener) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }
  #changed(sourceId) {
    for (const listener of this.changeListeners) listener({ sourceId });
  }
  #catalog(sourceId = "official") {
    const source = this.registry.get(sourceId);
    let catalog = this.catalogs.get(source.id);
    if (!catalog) {
      catalog = new RegistryCatalogService({ ...this.options, source,
        fetch: source.id === "official" ? this.options.fetch : (this.options.createSourceFetch ?? createSourceFetch)(source.origin),
        sourceGuard: () => this.registry.get(source.id),
      });
      this.catalogs.set(source.id, catalog);
    }
    return catalog;
  }
  #publishCatalogIdentity(sourceId, entries) {
    // Selection tokens bind the validated entry and its delivery resources.
    const identity = JSON.stringify(entries.map((entry) => [entry.id, entry.selectionToken]));
    if (this.catalogIdentities.get(sourceId) !== identity) {
      this.catalogIdentities.set(sourceId, identity);
      this.#changed(sourceId);
    }
  }
  list(sourceId = "official") {
    return this.#catalog(sourceId).list().then((snapshot) => {
      this.#publishCatalogIdentity(sourceId, snapshot.entries);
      return snapshot;
    });
  }
  readme(id, token, sourceId) { return this.#catalog(sourceId).readme(id, token); }
  readmeImages(id, token, sourceId) { return this.#catalog(sourceId).readmeImages(id, token); }
  async author(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || typeof request.pluginId !== "string" || !/^[a-z0-9][a-z0-9.-]{1,127}$/u.test(request.pluginId)) throw new TypeError("Invalid plugin author request");
    if (request.kind === "catalog") {
      if (Object.keys(request).some((key) => !["kind", "pluginId", "selectionToken", "sourceId"].includes(key))) throw new TypeError("Invalid plugin author request");
      return this.#catalog(request.sourceId).author(request.pluginId, request.selectionToken);
    }
    if (request.kind !== "installed" || Object.keys(request).some((key) => !["kind", "pluginId"].includes(key))) throw new TypeError("Invalid installed author request");
    const plugin = this.options.database.getActivePlugin(request.pluginId);
    if (!plugin?.activeVersion) return null;
    const captured = installedIdentity(plugin);
    let value = { author: plugin.manifest?.publisher ?? "", avatar: null, officialMaintained: false,
      sourceId: plugin.source.id, version: plugin.activeVersion, archiveSha256: plugin.archiveSha256 ?? null };
    if (plugin.runtime?.quarantinedAt == null) {
      try {
        // Presentation reuses an already validated catalog. It never refreshes
        // a source merely because the installed list becomes visible.
        this.registry.get(plugin.source.id);
        const catalog = this.catalogs.get(plugin.source.id);
        const entry = catalog?.publicEntries.find((item) => item.id === plugin.id && item.version === plugin.activeVersion
          && item.artifact?.sha256 === plugin.archiveSha256 && isDeepStrictEqual(item.manifest, plugin.manifest));
        if (entry) value = await catalog.author(entry.id, entry.selectionToken);
      } catch { /* No exact current source match confers no maintenance badge. */ }
    }
    if (captured !== installedIdentity(this.options.database.getActivePlugin(request.pluginId))) throw new Error("Installed plugin changed while loading its author");
    return value;
  }
  install(id, token, sourceId = "official", acceptedSourceId) {
    if (sourceId !== "official" && acceptedSourceId !== sourceId) throw new Error("Review and confirm this third-party source before installing");
    const catalog = this.#catalog(sourceId);
    return catalog.install(id, token).finally(() => {
      // A rejected stale selection can still have published a newer snapshot.
      this.#publishCatalogIdentity(sourceId, catalog.publicEntries);
    });
  }
  listSources() { return this.registry.list(); }
  addSource(payload) { return this.manager.changeMarketSource(() => this.registry.add(payload?.name, payload?.address)); }
  async updateSource(payload) {
    const source = await this.manager.changeMarketSource(() => this.registry.update(payload?.id, payload?.name, payload?.enabled));
    this.#changed(source.id);
    return source;
  }
  async removeSource(payload) {
    if (typeof payload?.disablePlugins !== "boolean") throw new Error("Choose whether to disable installed plugins");
    await this.manager.changeMarketSource(() => {
      this.registry.remove(payload.id);
      this.catalogs.delete(payload.id);
      this.catalogIdentities.delete(payload.id);
    }, payload.disablePlugins ? payload.id : undefined);
    this.#changed(payload.id);
  }
}
module.exports = { MarketSourcesService };
