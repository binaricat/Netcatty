"use strict";

const { createHash } = require("node:crypto");

const { assertPluginContextKey, evaluateContextKeyExpression } = require("./contextKeys.cjs");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const { compileRestrictedJsonSchema } = require("./restrictedJsonSchema.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { InteractiveCommandFeature, InteractiveCommandLimits } = require("./generated/plugin-contract.schema.json").$defs;

const MAX_SETTING_BYTES = 128 * 1024;
const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_VALUE_LENGTH = 4_096;
const MAX_SCOPE_ID_LENGTH = 256;
const SETTINGS_SCOPES = new Set(["application", "workspace", "host", "session", "device"]);

function invalidArgument(message) {
  return new PluginRpcError(RPC_ERRORS.invalidArgument, message);
}

function notFound(message) {
  return new PluginRpcError(RPC_ERRORS.notFound, message);
}

function freezeJson(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Array.isArray(item) ? item : Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

function assertJsonValue(value, label = "value") {
  try { assertPluginJsonValue(value, { maxBytes: MAX_SETTING_BYTES }); }
  catch (error) {
    throw invalidArgument(`Plugin ${label} must be a bounded JSON value: ${error?.message ?? error}`);
  }
  return value;
}

function resolveLocalizedText(value, locale = "en") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const base = locale.split("-")[0];
  return value[locale] ?? value[base] ?? value.en ?? value.default ?? Object.values(value)[0] ?? "";
}

function normalizeScopeId(scope, scopeId) {
  if (!SETTINGS_SCOPES.has(scope)) throw invalidArgument("Plugin setting scope is invalid");
  if (scope === "application") return "application";
  const value = scope === "device" && scopeId == null ? "device" : scopeId;
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_SCOPE_ID_LENGTH || value.includes("\0")) {
    throw invalidArgument(`Plugin ${scope} setting requires a valid scope ID`);
  }
  return value;
}

function getContribution(manifest, kind, id) {
  return manifest?.contributes?.[kind]?.find((item) => item.id === id || item.command === id) ?? null;
}

function compileSettingPattern(source, settingId = "setting") {
  if (typeof source !== "string" || source.length < 1 || source.length > MAX_PATTERN_LENGTH
    || /\(\?/u.test(source) || /\\(?:[1-9]|k<)/u.test(source)
    || /\)(?:[*+?]|\{\d+(?:,\d*)?\})/u.test(source)) {
    throw invalidArgument(`${settingId} has an unsafe pattern`);
  }
  try { return new RegExp(source, "u"); }
  catch { throw invalidArgument(`${settingId} has an invalid pattern`); }
}

function assertSettingValue(setting, value) {
  assertJsonValue(value, "setting value");
  const options = new Set((setting.options ?? []).map((option) => option.value));
  switch (setting.control) {
    case "switch":
      if (typeof value !== "boolean") throw invalidArgument(`${setting.id} must be a boolean`);
      break;
    case "radio": case "select":
      if (typeof value !== "string" || (options.size && !options.has(value))) {
        throw invalidArgument(`${setting.id} must use a declared option`);
      }
      break;
    case "multiselect":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (options.size && !options.has(item)))
        || new Set(value).size !== value.length) {
        throw invalidArgument(`${setting.id} must be a unique list of declared options`);
      }
      break;
    case "number": case "slider":
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalidArgument(`${setting.id} must be finite`);
      if (setting.minimum != null && value < setting.minimum) throw invalidArgument(`${setting.id} is below its minimum`);
      if (setting.maximum != null && value > setting.maximum) throw invalidArgument(`${setting.id} is above its maximum`);
      if (setting.step != null) {
        const steps = (value - (setting.minimum ?? 0)) / setting.step;
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 16;
        if (Math.abs(steps - Math.round(steps)) > tolerance) {
          throw invalidArgument(`${setting.id} does not align to its step`);
        }
      }
      break;
    case "list": case "table":
      if (!Array.isArray(value)) throw invalidArgument(`${setting.id} must be an array`);
      try { compileRestrictedJsonSchema(setting.valueSchema, { rootType: "array" })(value); }
      catch (error) { throw invalidArgument(`${setting.id} ${error?.message ?? error}`); }
      break;
    default:
      if (typeof value !== "string") throw invalidArgument(`${setting.id} must be a string`);
      if (setting.pattern) {
        if (value.length > MAX_PATTERN_VALUE_LENGTH) {
          throw invalidArgument(`${setting.id} exceeds the patterned text limit`);
        }
        const pattern = compileSettingPattern(setting.pattern, setting.id);
        if (!pattern.test(value)) throw invalidArgument(`${setting.id} does not match its pattern`);
      }
  }
  return value;
}

function secretSettingKey(settingId, scope, scopeId) {
  const digest = createHash("sha256").update(`${scope}\0${scopeId}`).digest("hex").slice(0, 32);
  return `setting:${settingId}:${digest}`;
}

function activationEvents(manifest) {
  return new Set(manifest?.activationEvents ?? []);
}

function shouldActivateOnStartup(manifest) {
  return activationEvents(manifest).has("onStartupFinished");
}

function resolvePlatformKeybinding(keybinding, platform = process.platform) {
  if (!keybinding) return undefined;
  if (platform === "darwin") return keybinding.mac ?? keybinding.key;
  if (platform === "win32") return keybinding.windows ?? keybinding.key;
  if (platform === "linux") return keybinding.linux ?? keybinding.key;
  return keybinding.key;
}

function isContributionAvailable(plugin) {
  return plugin?.enabled === true
    && plugin.manifest != null
    && plugin.runtime?.quarantinedAt == null;
}

class PluginContributionService {
  constructor(options) {
    this.database = options.database;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.onCommandFinished = options.onCommandFinished;
    this.activeCommandCalls = new Map();
    this.secretStore = options.secretStore;
    this.getLocale = options.getLocale ?? (() => "en");
    this.contextKeys = new Map();
    this.contextKeyOwners = new Map();
    this.listeners = new Set();
    this.viewMessageListeners = new Set();
    this.environment = null;
    this.environmentRevision = 0;
    this.runtimeEnvironmentState = new Map();
    this.initialized = false;
  }

  registerRpcCapabilities(registry) {
    registry.registerRequest("settings.get", (params, context) => this.#runtimeGetSetting(params, context), {
      metadata: { capability: "settings", mutating: false, permission: "settings.read" },
      authorization: { permission: "settings.read", resources: ["*"], reason: "Read plugin settings" },
    });
    registry.registerRequest("settings.update", (params, context) => this.#runtimeUpdateSetting(params, context), {
      metadata: { capability: "settings", mutating: true, permission: "settings.write" },
      authorization: { permission: "settings.write", resources: ["*"], reason: "Update plugin settings" },
    });
    registry.registerRequest("commands.execute", (params, context) => this.executeCommand(params?.command, params?.args, {
      source: "plugin",
      callerPluginId: context.pluginId,
    }), {
      metadata: { capability: "commands", mutating: true, permission: "commands" },
      authorization: { permission: "commands", resources: ["*"], reason: "Execute a plugin command" },
    });
    registry.registerRequest("contextKeys.set", (params, context) => {
      const key = assertPluginContextKey(context.pluginId, params?.key);
      assertJsonValue(params?.value, "Context Key value");
      const owner = this.contextKeyOwners.get(key);
      if (owner != null && owner !== context.pluginId) {
        throw invalidArgument("Plugin Context Key is owned by another plugin");
      }
      this.contextKeys.set(key, freezeJson(params.value));
      this.contextKeyOwners.set(key, context.pluginId);
      this.#emitChange("context-key", context.pluginId);
      return null;
    }, {
      metadata: { capability: "contextKeys", mutating: true, public: true },
    });
    registry.registerRequest("views.getState", (params, context) => {
      const view = this.#assertOwnedContribution(context.manifest, "views", params?.viewId, context.pluginId);
      const scopeId = normalizeScopeId("session", params?.scopeId);
      return { state: this.database.getViewState(context.pluginId, view.id, scopeId) };
    }, {
      metadata: { capability: "views", mutating: false, permission: "views" },
      authorization: { permission: "views", resources: ["*"], reason: "Restore plugin view state" },
    });
    registry.registerRequest("views.setState", (params, context) => {
      const view = this.#assertOwnedContribution(context.manifest, "views", params?.viewId, context.pluginId);
      const scopeId = normalizeScopeId("session", params?.scopeId);
      assertJsonValue(params?.state, "view state");
      this.database.setViewState(context.pluginId, view.id, scopeId, params.state);
      return null;
    }, {
      metadata: { capability: "views", mutating: true, permission: "views" },
      authorization: { permission: "views", resources: ["*"], reason: "Persist plugin view state" },
    });
    registry.registerNotification("views.postMessage", (params, context) => {
      const view = this.#assertOwnedContribution(context.manifest, "views", params?.viewId, context.pluginId);
      assertJsonValue(params?.message, "view message");
      const event = freezeJson({ pluginId: context.pluginId, viewId: view.id, message: params.message });
      for (const listener of [...this.viewMessageListeners]) {
        try { listener(event); } catch {}
      }
    }, {
      metadata: { capability: "views", mutating: true, permission: "views" },
      authorization: { permission: "views", resources: ["*"], reason: "Message a plugin view" },
    });
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.enabled || plugin.runtime.quarantinedAt != null || !shouldActivateOnStartup(plugin.manifest)) continue;
      try { await this.#startPlugin(plugin.id); } catch {}
    }
    this.#emitChange("initialized");
  }

  onDidChange(listener) {
    if (typeof listener !== "function") throw new TypeError("Plugin contribution listener must be a function");
    this.listeners.add(listener);
    return Object.freeze({ dispose: () => this.listeners.delete(listener) });
  }

  onDidPostViewMessage(listener) {
    if (typeof listener !== "function") throw new TypeError("Plugin view listener must be a function");
    this.viewMessageListeners.add(listener);
    return Object.freeze({ dispose: () => this.viewMessageListeners.delete(listener) });
  }

  #emitChange(reason, pluginId = null) {
    const event = Object.freeze({ reason, pluginId, revision: Date.now() });
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch {}
    }
  }

  async onPluginEnabled(pluginId) {
    const plugin = this.database.getActivePlugin(pluginId);
    if (!plugin?.enabled) throw notFound(`Plugin is not enabled: ${pluginId}`);
    if (shouldActivateOnStartup(plugin.manifest)) await this.#startPlugin(pluginId);
    this.#emitChange("plugin-enabled", pluginId);
    return plugin;
  }

  onPluginDisabled(pluginId) {
    this.#clearRuntimeOwnedState(pluginId);
    this.#emitChange("plugin-disabled", pluginId);
  }

  onRuntimeStateChanged(event) {
    if (!["stopped", "error", "quarantined"].includes(event?.status) || typeof event.pluginId !== "string") return;
    this.#clearRuntimeOwnedState(event.pluginId);
    this.#emitChange(`runtime-${event.status}`, event.pluginId);
  }

  getEnvironment() {
    return this.environment;
  }

  #clearRuntimeOwnedState(pluginId) {
    this.runtimeEnvironmentState.delete(pluginId);
    for (const [key, owner] of [...this.contextKeyOwners.entries()]) {
      if (owner !== pluginId) continue;
      this.contextKeyOwners.delete(key);
      this.contextKeys.delete(key);
    }
  }

  #findContribution(kind, id) {
    if (typeof id !== "string") throw invalidArgument(`Plugin ${kind} ID is required`);
    for (const plugin of this.database.listPlugins()) {
      if (!isContributionAvailable(plugin)) continue;
      const contribution = getContribution(plugin.manifest, kind, id);
      if (contribution) return { plugin, contribution };
    }
    throw notFound(`Plugin ${kind} contribution was not found: ${id}`);
  }

  #assertOwnedContribution(manifest, kind, id, pluginId) {
    if (typeof id !== "string" || !id.startsWith(`${pluginId}.`)) throw invalidArgument(`Plugin ${kind} ID is invalid`);
    const contribution = getContribution(manifest, kind, id);
    if (!contribution) throw notFound(`Plugin ${kind} contribution was not found: ${id}`);
    return contribution;
  }

  async #ensureActivated(plugin, event) {
    const events = activationEvents(plugin.manifest);
    const isContributionEvent = /^(?:onCommand|onView|onProvider):/u.test(event);
    if (!events.has(event) && !events.has("onStartupFinished") && !isContributionEvent) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, `Plugin activation event is not declared: ${event}`);
    }
    // Declared UI contributions are implicit lazy activation points. This keeps
    // manifest activationEvents backward compatible while avoiding eager start.
    return this.#startPlugin(plugin.id);
  }

  async #startPlugin(pluginId) {
    const identity = await this.runtimeSupervisor.start(pluginId);
    if (this.environment == null) return identity;
    const runtimeId = identity?.runtimeId ?? null;
    const seeded = this.runtimeEnvironmentState.get(pluginId);
    if (runtimeId != null && seeded?.runtimeId === runtimeId && seeded.revision === this.environmentRevision) {
      return identity;
    }
    await this.runtimeSupervisor.notify(pluginId, "plugin.environment.changed", this.environment);
    if (runtimeId != null) {
      this.runtimeEnvironmentState.set(pluginId, { runtimeId, revision: this.environmentRevision });
    }
    return identity;
  }

  async executeCommand(commandId, args, invocation = {}) {
    const { plugin, contribution } = this.#findContribution("commands", commandId);
    if (invocation.callerPluginId && invocation.callerPluginId !== plugin.id) {
      throw new PluginRpcError(RPC_ERRORS.permissionDenied, "Plugins may execute only their own declared commands");
    }
    const keys = this.#context(invocation.context);
    if (!evaluateContextKeyExpression(contribution.enablement, keys)) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, `Plugin command is disabled: ${commandId}`);
    }
    assertJsonValue(args ?? null, "command arguments");
    if (contribution.interactive && !plugin.manifest.features?.required?.includes(InteractiveCommandFeature.const)) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Interactive command feature is required");
    }
    const identity = await this.#ensureActivated(plugin, `onCommand:${commandId}`);
    const runtimeId = identity?.runtimeId;
    if (runtimeId) this.activeCommandCalls.set(runtimeId, (this.activeCommandCalls.get(runtimeId) ?? 0) + 1);
    let failed = true;
    try {
      const result = await this.runtimeSupervisor.request(plugin.id, "plugin.command.execute", {
        command: commandId,
        ...(args === undefined ? {} : { args }),
        invocation: freezeJson({ source: invocation.source ?? "host", context: invocation.context ?? {} }),
      }, { expectedIdentity: identity, ...(contribution.interactive ? { timeoutMs: InteractiveCommandLimits.const.timeoutMs } : {}) });
      failed = false;
      return result;
    } finally {
      if (runtimeId) {
        const remaining = Math.max(0, (this.activeCommandCalls.get(runtimeId) ?? 1) - 1);
        if (remaining) this.activeCommandCalls.set(runtimeId, remaining);
        else this.activeCommandCalls.delete(runtimeId);
        // A failed command must not leave a live native consent prompt. On
        // success wait for other concurrent commands before closing orphans.
        if (failed || remaining === 0) this.onCommandFinished?.(runtimeId);
      }
    }
  }

  async activateView(viewId, params = {}) {
    const { plugin, contribution } = this.#findContribution("views", viewId);
    const keys = this.#context(params.context);
    if (!evaluateContextKeyExpression(contribution.when, keys)) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, `Plugin view is unavailable: ${viewId}`);
    }
    const identity = await this.#ensureActivated(plugin, `onView:${viewId}`);
    return { plugin, view: contribution, identity: identity ?? null };
  }

  assertViewActivationCurrent(expected, params = {}) {
    if (!expected || typeof expected !== "object") throw invalidArgument("Plugin view activation identity is invalid");
    const { plugin, contribution } = this.#findContribution("views", expected.viewId);
    if (plugin.id !== expected.pluginId || plugin.activeVersion !== expected.pluginVersion) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Plugin view ownership changed while opening");
    }
    const keys = this.#context(params.context);
    if (!evaluateContextKeyExpression(contribution.when, keys)) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, `Plugin view is unavailable: ${expected.viewId}`);
    }
    const identity = this.runtimeSupervisor.getRuntimeIdentity?.(plugin.id) ?? null;
    if (!identity?.runtimeId || identity.runtimeId !== expected.runtimeId
      || identity.pluginVersion !== expected.pluginVersion) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Plugin view runtime ownership changed while opening");
    }
    return { plugin, view: contribution, identity };
  }

  async activateProvider(providerId) {
    const { plugin, contribution } = this.#findContribution("providers", providerId);
    const identity = await this.#ensureActivated(plugin, `onProvider:${providerId}`);
    return Object.freeze({ plugin, provider: contribution, identity: identity ?? null });
  }

  listProviders(options = {}) {
    if (options.kind != null && (typeof options.kind !== "string" || options.kind.length < 1)) {
      throw invalidArgument("Plugin Provider kind is invalid");
    }
    const locale = options.locale ?? this.getLocale();
    const providers = [];
    for (const plugin of this.database.listPlugins()) {
      if (!isContributionAvailable(plugin)) continue;
      for (const provider of plugin.manifest.contributes?.providers ?? []) {
        if (options.kind != null && provider.kind !== options.kind) continue;
        providers.push({
          pluginId: plugin.id,
          pluginVersion: plugin.activeVersion,
          pluginDisplayName: resolveLocalizedText(
            plugin.manifest.displayName ?? plugin.manifest.name,
            locale,
          ),
          provider: {
            ...provider,
            label: resolveLocalizedText(provider.label, locale),
            description: provider.description == null
              ? undefined
              : resolveLocalizedText(provider.description, locale),
          },
        });
      }
    }
    return freezeJson(providers);
  }

  #settingRecord(pluginId, settingId) {
    const plugin = this.database.getActivePlugin(pluginId);
    if (!isContributionAvailable(plugin)) throw notFound(`Plugin is not enabled: ${pluginId}`);
    const setting = this.#assertOwnedContribution(plugin.manifest, "settings", settingId, pluginId);
    return { plugin, setting };
  }

  async getSetting(pluginId, settingId, scopeId) {
    const { setting } = this.#settingRecord(pluginId, settingId);
    const normalizedScopeId = normalizeScopeId(setting.scope, scopeId);
    if (setting.secret) {
      return this.secretStore.getReference(pluginId, secretSettingKey(setting.id, setting.scope, normalizedScopeId)) ?? undefined;
    }
    const stored = this.database.getSetting(pluginId, setting.id, setting.scope, normalizedScopeId);
    return stored === undefined ? freezeJson(setting.default) : stored;
  }

  async updateSetting(pluginId, settingId, value, scopeId, options = {}) {
    const { setting } = this.#settingRecord(pluginId, settingId);
    const normalizedScopeId = normalizeScopeId(setting.scope, scopeId);
    assertSettingValue(setting, value);
    if (setting.secret) {
      this.secretStore.set(pluginId, secretSettingKey(setting.id, setting.scope, normalizedScopeId), value);
    } else {
      this.database.setSetting(pluginId, setting.id, setting.scope, normalizedScopeId, value);
    }
    this.#emitChange("setting-updated", pluginId);
    try {
      await this.runtimeSupervisor.notify(pluginId, "plugin.settings.changed", {
        settingId: setting.id,
        scope: setting.scope,
        scopeId: normalizedScopeId,
        source: options.source ?? "host",
      });
    } catch {}
    return { restartRequired: setting.restartRequired === true };
  }

  async resetSetting(pluginId, settingId, scopeId) {
    const { setting } = this.#settingRecord(pluginId, settingId);
    if (setting.required && setting.default === undefined) throw invalidArgument(`${setting.id} is required`);
    const normalizedScopeId = normalizeScopeId(setting.scope, scopeId);
    if (setting.secret) this.secretStore.delete(pluginId, secretSettingKey(setting.id, setting.scope, normalizedScopeId));
    else this.database.deleteSetting(pluginId, setting.id, setting.scope, normalizedScopeId);
    // Clear the matching cloud-sync sidecar so collect does not rehydrate the
    // retained remote value after an intentional local reset.
    if (typeof this.database.deleteSyncSidecar === "function" && !setting.secret) {
      const sidecarKey = `${setting.id}\0${setting.scope}\0${normalizedScopeId}`;
      try {
        this.database.deleteSyncSidecar(pluginId, "settings", sidecarKey);
      } catch {}
    }
    this.#emitChange("setting-reset", pluginId);
    try {
      await this.runtimeSupervisor.notify(pluginId, "plugin.settings.changed", {
        settingId: setting.id,
        scope: setting.scope,
        scopeId: normalizedScopeId,
        source: "host",
      });
    } catch {}
    return { restartRequired: setting.restartRequired === true };
  }

  #runtimeGetSetting(params, context) {
    return this.getSetting(context.pluginId, params?.settingId, params?.scopeId).then((value) => ({
      found: value !== undefined,
      ...(value === undefined ? {} : { value }),
    }));
  }

  #runtimeUpdateSetting(params, context) {
    return this.updateSetting(context.pluginId, params?.settingId, params?.value, params?.scopeId, { source: "plugin" });
  }

  #context(extra) {
    return Object.assign(Object.create(null), extra ?? {}, Object.fromEntries(this.contextKeys));
  }

  snapshot(options = {}) {
    const locale = options.locale ?? this.getLocale();
    const context = this.#context(options.context);
    const plugins = [];
    for (const plugin of this.database.listPlugins()) {
      if (!isContributionAvailable(plugin)) continue;
      const contributes = plugin.manifest.contributes ?? {};
      const localize = (value) => resolveLocalizedText(value, locale);
      const commands = (contributes.commands ?? []).map((command) => ({
        ...command,
        title: localize(command.title),
        category: command.category == null ? undefined : localize(command.category),
        description: command.description == null ? undefined : localize(command.description),
        enabled: evaluateContextKeyExpression(command.enablement, context),
      }));
      const commandById = new Map(commands.map((command) => [command.id, command]));
      const keybindings = (contributes.keybindings ?? []).map((keybinding) => ({
        ...keybinding,
        enabled: evaluateContextKeyExpression(keybinding.when, context)
          && commandById.get(keybinding.command)?.enabled !== false,
      }));
      const keybindingByCommand = new Map();
      for (const keybinding of keybindings) {
        if (keybinding.enabled && !keybindingByCommand.has(keybinding.command)) {
          keybindingByCommand.set(keybinding.command, keybinding);
        }
      }
      const menus = (contributes.menus ?? []).map((menu, index) => {
        const menuContext = this.#context(options.menuContexts?.[menu.location] ?? options.context);
        const command = commandById.get(menu.command);
        return {
          ...menu,
          id: `${plugin.id}:menu:${index}`,
          title: menu.title == null ? command?.title ?? menu.command : localize(menu.title),
          visible: evaluateContextKeyExpression(menu.when, menuContext),
          enabled: evaluateContextKeyExpression(menu.enablement, menuContext)
            && evaluateContextKeyExpression(command?.enablement, menuContext),
          checked: menu.checked == null ? undefined : evaluateContextKeyExpression(menu.checked, menuContext),
          shortcut: menu.showKeybinding === false
            ? undefined
            : resolvePlatformKeybinding(keybindingByCommand.get(menu.command), options.platform),
        };
      });
      const settings = (contributes.settings ?? []).map((setting) => {
        const requestedScopeId = options.scopeIds?.[setting.scope];
        const scopeId = setting.scope === "application"
          ? "application"
          : setting.scope === "device"
            ? (requestedScopeId ?? "device")
            : (requestedScopeId ?? null);
        const stored = scopeId == null
          ? undefined
          : setting.secret
            ? this.secretStore.getReference(plugin.id, secretSettingKey(setting.id, setting.scope, scopeId))
            : this.database.getSetting(plugin.id, setting.id, setting.scope, scopeId);
        return {
          ...setting,
          label: localize(setting.label),
          group: setting.group == null ? undefined : localize(setting.group),
          description: setting.description == null ? undefined : localize(setting.description),
          placeholder: setting.placeholder == null ? undefined : localize(setting.placeholder),
          options: setting.options?.map((option) => ({
            ...option,
            label: localize(option.label),
            description: option.description == null ? undefined : localize(option.description),
          })),
          visible: evaluateContextKeyExpression(setting.when, context),
          configured: stored !== undefined && stored !== null,
          value: setting.secret ? undefined : freezeJson(stored === undefined ? setting.default : stored),
          scopeId,
        };
      });
      const views = (contributes.views ?? []).map((view) => ({
        ...view,
        title: localize(view.title),
        visible: evaluateContextKeyExpression(view.when, context),
      }));
      plugins.push({
        id: plugin.id,
        version: plugin.activeVersion,
        displayName: localize(plugin.manifest.displayName ?? plugin.manifest.name),
        description: localize(plugin.manifest.description ?? ""),
        commands,
        keybindings,
        menus,
        settings,
        views,
      });
    }
    return freezeJson({ locale, plugins });
  }

  async setEnvironment(environment) {
    assertJsonValue(environment, "environment");
    this.environment = freezeJson(environment);
    this.environmentRevision += 1;
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.enabled || plugin.runtime.status !== "running") continue;
      try {
        await this.runtimeSupervisor.notify(plugin.id, "plugin.environment.changed", this.environment);
        const identity = this.runtimeSupervisor.getRuntimeIdentity?.(plugin.id);
        if (identity?.runtimeId) {
          this.runtimeEnvironmentState.set(plugin.id, {
            runtimeId: identity.runtimeId,
            revision: this.environmentRevision,
          });
        }
      } catch {}
    }
    this.#emitChange("environment");
  }
}

module.exports = {
  MAX_SETTING_BYTES,
  MAX_PATTERN_VALUE_LENGTH,
  PluginContributionService,
  assertJsonValue,
  assertSettingValue,
  compileSettingPattern,
  normalizeScopeId,
  resolveLocalizedText,
  resolvePlatformKeybinding,
  secretSettingKey,
  isContributionAvailable,
  shouldActivateOnStartup,
};
