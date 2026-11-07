"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { resolveThemePalette } = require("../../domain/pluginThemePack.cjs");
const { isStaticThemePack } = require("../../domain/pluginRuntimePolicy.cjs");
const validatePalette = createDefinitionValidator("ThemePackPalette");
const validateApply = createDefinitionValidator("ThemePackApplyRequest");
const validateSelection = createDefinitionValidator("ThemePackSelection");
const limits = require("./generated/plugin-contract.schema.json").$defs
  .ThemePackLimits.const;
const key = (ref) =>
  JSON.stringify([
    ref.pluginId,
    ref.themeId,
    ref.version,
    ref.digest,
    ref.variant,
  ]);
class PluginThemeService {
  constructor({ database, packageStore, contributionService }) {
    Object.assign(this, { database, packageStore });
    this.generation = 0;
    this.cache = new Map();
    this.listeners = new Set();
    this.tail = Promise.resolve();
    this.dispose = contributionService?.onDidChange?.((event) => {
      if (
        !["initialized", "plugin-enabled", "plugin-disabled"].includes(
          event.reason,
        )
      )
        return;
      this.generation++;
      this.cache.clear();
      this.emit();
    });
  }
  onDidChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
  active(ref) {
    const p = this.database.getActivePlugin(ref.pluginId);
    return (
      p?.enabled &&
      p.activeVersion === ref.version &&
      p.archiveSha256 === ref.digest &&
      p.manifest?.contributes?.themes?.some(
        (t) => t.id === ref.themeId && t.variant === ref.variant,
      )
    );
  }
  catalog() {
    if (!this.pendingCatalog) {
      const pending = this.readCatalog().finally(() => {
        if (this.pendingCatalog === pending) this.pendingCatalog = null;
      });
      this.pendingCatalog = pending;
    }
    return this.pendingCatalog;
  }
  async readCatalog(retry = true) {
    const generation = this.generation,
      entries = [],
      diagnostics = [];
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.enabled) continue;
      let packageRoot;
      for (const theme of plugin.manifest?.contributes?.themes ?? []) {
        if (entries.length >= limits.catalogEntries) {
          if (diagnostics.length < 256)
            diagnostics.push({ pluginId: plugin.id, code: "capacity" });
          break;
        }
        const ref = {
          pluginId: plugin.id,
          themeId: theme.id,
          version: plugin.activeVersion,
          digest: plugin.archiveSha256,
          variant: theme.variant,
        };
        try {
          let palette = this.cache.get(key(ref));
          if (!palette) {
            const root = (packageRoot ??=
              await this.packageStore.preparePackageRoot(plugin));
            const target = path.resolve(root, theme.entry);
            if (
              !theme.entry.endsWith(".json") ||
              !target.startsWith(root + path.sep)
            )
              throw new Error("Invalid path");
            const handle = await fs.open(
              target,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > limits.jsonBytes)
                throw new Error("Invalid theme size");
              const bytes = Buffer.alloc(limits.jsonBytes + 1);
              const { bytesRead } = await handle.read(
                bytes,
                0,
                bytes.length,
                0,
              );
              if (bytesRead > limits.jsonBytes)
                throw new Error("Invalid theme size");
              palette = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes.subarray(0, bytesRead),
                ),
              );
            } finally {
              await handle.close();
            }
            if (
              !validatePalette(palette) ||
              palette.base !==
                (theme.variant.endsWith("dark") ? "dark" : "light")
            )
              throw new Error("Invalid theme palette");
            resolveThemePalette(palette);
            // Only immutable, validated data enters the catalog/cache.
            palette = JSON.parse(JSON.stringify(palette));
            if (generation === this.generation && this.active(ref))
              this.cache.set(key(ref), palette);
          }
          if (generation !== this.generation || !this.active(ref)) continue;
          const label =
            typeof theme.label === "string"
              ? theme.label
              : (theme.label.en ??
                theme.label.default ??
                Object.values(theme.label)[0]);
          entries.push({
            ref,
            label,
            pluginName: plugin.manifest.name,
            dataOnly: isStaticThemePack(plugin.manifest),
            palette,
          });
        } catch {
          if (diagnostics.length < 256)
            diagnostics.push({
              pluginId: plugin.id,
              themeId: theme.id,
              code: "invalid",
            });
        }
      }
    }
    // A package change during an async read must never publish an old palette.
    if (generation !== this.generation) {
      if (retry) return this.readCatalog(false);
      throw new Error("Theme packages changed; refresh again");
    }
    const selection = this.database.getHostThemeSelection();
    if (!validateSelection(selection))
      throw new Error("Invalid saved theme selection");
    return { selection, entries, diagnostics };
  }
  apply(request) {
    const run = async () => {
      if (!validateApply(request))
        throw new TypeError("Invalid theme selection request");
      const { selection, entries } = await this.catalog();
      if (selection.revision !== request.expectedRevision)
        throw new Error("Theme selection changed; refresh before applying");
      if (request.choice) {
        const entry = entries.find(
          (e) => key(e.ref) === key(request.choice.ref),
        );
        if (
          !entry ||
          entry.palette.base !== request.mode ||
          !this.active(entry.ref)
        )
          throw new Error("Theme is no longer available");
      }
      if (selection.revision >= Number.MAX_SAFE_INTEGER)
        throw new Error("Theme revision exhausted");
      const next = {
        ...selection,
        revision: selection.revision + 1,
        [request.mode]: request.choice,
      };
      // Synchronous active check immediately before the atomic preference/audit write.
      if (request.choice && !this.active(request.choice.ref))
        throw new Error("Theme changed before apply");
      this.database.commitHostThemeSelection(
        request.expectedRevision,
        next,
        request.choice?.ref.pluginId,
      );
      this.emit();
      return this.catalog();
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
  shutdown() {
    if (typeof this.dispose === "function") this.dispose();
    else this.dispose?.dispose();
    this.cache.clear();
    this.listeners.clear();
  }
}
module.exports = { PluginThemeService };
