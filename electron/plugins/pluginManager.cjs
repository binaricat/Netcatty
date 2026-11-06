"use strict";

class PluginManager {
  constructor(options) {
    this.database = options.database;
    this.packageStore = options.packageStore;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.contributionService = options.contributionService ?? {
      initialize: () => this.runtimeSupervisor.startEnabled(),
      onPluginDisabled() {},
      onPluginEnabled: (pluginId) => this.runtimeSupervisor.start(pluginId),
    };
    this.beforeClose = options.beforeClose ?? null;
    this.permissionEngine = options.permissionEngine ?? null;
    this.secretStore = options.secretStore ?? null;
    this.initialized = false;
    this.initializePromise = null;
    this.mutationTail = Promise.resolve();
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  initialize() {
    this.initializePromise ??= this.#initialize();
    return this.initializePromise;
  }

  async #initialize() {
    await this.packageStore.initialize();
    await this.contributionService.initialize();
    this.initialized = true;
  }

  async #ready() {
    await this.initialize();
  }

  #mutate(operation) {
    if (this.shuttingDown) return Promise.reject(new Error("Plugin manager is shutting down"));
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async list() {
    await this.#ready();
    return this.database.listPlugins();
  }

  changeMarketSource(operation, disableSourceId) {
    return this.#mutate(async () => {
      await this.#ready();
      const result = operation();
      if (disableSourceId) {
        const errors = [];
        for (const plugin of this.database.listPlugins()) {
          if (plugin.source?.id !== disableSourceId) continue;
          try { this.database.setEnabled(plugin.id, false); } catch (error) { errors.push(error); }
          try { this.contributionService.onPluginDisabled(plugin.id); } catch (error) { errors.push(error); }
          try { await this.runtimeSupervisor.stop(plugin.id); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "Source removed, but some plugin shutdown steps failed");
      }
      return result;
    });
  }

  install(archivePath, options) {
    return this.#mutate(async () => {
      await this.#ready();
      options?.sourceGuard?.();
      let stoppedPlugin = null;
      let plugin;
      try {
        plugin = await this.packageStore.install(archivePath, {
          enable: options?.enable,
          catalog: options?.catalog,
          source: options?.source,
          beforeActivate: async ({ pluginId, previousPlugin }) => {
            options?.sourceGuard?.();
            if (!previousPlugin?.enabled) return;
            this.database.setEnabled(pluginId, false);
            this.contributionService.onPluginDisabled(pluginId);
            stoppedPlugin = { pluginId, version: previousPlugin.activeVersion };
            await this.runtimeSupervisor.stop(pluginId);
          },
        });
      } catch (error) {
        if (stoppedPlugin) {
          const current = this.database.getActivePlugin(stoppedPlugin.pluginId);
          if (current?.activeVersion === stoppedPlugin.version) {
            this.database.setEnabled(stoppedPlugin.pluginId, true);
            try {
              await this.contributionService.onPluginEnabled(stoppedPlugin.pluginId);
            } catch {
              this.database.setEnabled(stoppedPlugin.pluginId, false);
            }
          }
        }
        throw error;
      }
      if (plugin?.enabled) {
        try {
          await this.contributionService.onPluginEnabled(plugin.id);
        } catch (error) {
          this.database.setEnabled(plugin.id, false);
          this.contributionService.onPluginDisabled(plugin.id);
          if (stoppedPlugin && stoppedPlugin.version !== plugin.activeVersion) {
            try {
              this.database.setActiveVersion(stoppedPlugin.pluginId, stoppedPlugin.version, {
                enabled: true,
                expectedActiveVersion: plugin.activeVersion,
              });
              await this.contributionService.onPluginEnabled(stoppedPlugin.pluginId);
            } catch {
              const restored = this.database.getActivePlugin(stoppedPlugin.pluginId);
              if (restored?.activeVersion === stoppedPlugin.version && restored.enabled) {
                this.database.setEnabled(stoppedPlugin.pluginId, false);
              }
            }
          }
          throw error;
        }
      }
      return plugin;
    });
  }

  setEnabled(pluginId, enabled, options = {}) {
    return this.#mutate(async () => {
      await this.#ready();
      if (options.expectedSourceOwner !== undefined && this.database.privateOwner(pluginId) !== options.expectedSourceOwner) {
        throw new Error("Plugin source changed before its lifecycle update");
      }
      if (enabled) {
        const plugin = this.database.getActivePlugin(pluginId);
        if (plugin) await this.packageStore.assertCompatible?.(plugin);
        if (plugin?.runtime?.quarantinedAt != null) {
          this.database.clearQuarantine(pluginId, plugin.activeVersion);
        }
        this.database.setEnabled(pluginId, true);
        try { await this.contributionService.onPluginEnabled(pluginId); }
        catch (error) {
          this.database.setEnabled(pluginId, false);
          this.contributionService.onPluginDisabled(pluginId);
          throw error;
        }
      } else {
        this.database.setEnabled(pluginId, false);
        this.contributionService.onPluginDisabled(pluginId);
        await this.runtimeSupervisor.stop(pluginId);
      }
      return this.database.getActivePlugin(pluginId);
    });
  }

  revokePermissions(pluginId) {
    return this.#mutate(async () => {
      await this.#ready();
      if (!this.permissionEngine) throw new Error("Plugin permissions are unavailable");
      if (!this.database.getActivePlugin(pluginId)) throw new Error("Plugin is not installed");
      // Disable before revoking. Lazy activation cannot re-create authority while
      // runtime shutdown cancels pending RPC, streams, leases and provider work.
      const errors = [];
      // Every containment stage must be attempted even when persistence,
      // revocation audit, or contribution invalidation fails.
      try { this.database.setEnabled(pluginId, false); } catch (error) { errors.push(error); }
      try { this.permissionEngine.revokeAll(pluginId); } catch (error) { errors.push(error); }
      try { this.contributionService.onPluginDisabled(pluginId); } catch (error) { errors.push(error); }
      try { await this.runtimeSupervisor.stop(pluginId); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Plugin grant revocation or cleanup failed");
      return this.database.getActivePlugin(pluginId);
    });
  }

  restart(pluginId) {
    return this.#mutate(async () => {
      await this.#ready();
      await this.runtimeSupervisor.restart(pluginId);
      return this.database.getActivePlugin(pluginId);
    });
  }

  resetUninstalledSource(pluginId, expectedSourceId) {
    return this.#mutate(async () => {
      await this.#ready();
      if (this.database.getActivePlugin(pluginId)) throw new Error("Uninstall the plugin before changing source");
      if (this.database.getPluginSource(pluginId).id !== expectedSourceId) throw new Error("Plugin source changed; review the reset again");
      await this.runtimeSupervisor.stop(pluginId);
      this.permissionEngine?.revokeAll(pluginId);
      this.secretStore?.clearPluginMemory(pluginId);
      await this.packageStore.clearUninstalledPrivateFiles(pluginId);
      this.database.clearUninstalledSourceData(pluginId, expectedSourceId);
    });
  }

  uninstall(pluginId) {
    return this.#mutate(async () => {
      await this.#ready();
      const plugin = this.database.getActivePlugin(pluginId);
      if (plugin) {
        this.database.setEnabled(pluginId, false);
        this.contributionService.onPluginDisabled(pluginId);
      }
      await this.runtimeSupervisor.stop(pluginId);
      return this.packageStore.uninstall(pluginId);
    });
  }

  shutdown() {
    this.shutdownPromise ??= this.#shutdown();
    return this.shutdownPromise;
  }

  async #shutdown() {
    this.shuttingDown = true;
    let supervisorError;
    const supervisorShutdown = Promise.resolve()
      .then(() => this.runtimeSupervisor.shutdown())
      .catch((error) => { supervisorError = error; });
    await this.mutationTail;
    if (this.initializePromise) {
      try { await this.initializePromise; } catch {}
    }
    await supervisorShutdown;
    const errors = supervisorError ? [supervisorError] : [];
    try { await this.beforeClose?.(); }
    catch (error) { errors.push(error); }
    try { this.database.close(); }
    catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Plugin host shutdown failed");
  }
}

module.exports = { PluginManager };
