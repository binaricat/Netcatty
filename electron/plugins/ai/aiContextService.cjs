"use strict";

const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");
const { createDefinitionValidator } = require("../contractValidator.cjs");
const { ModelInvocationBroker } = require("./modelInvocationBroker.cjs");
const { SelectedContextAuthority } = require("../context/selectedContextAuthority.cjs");
const { PluginAISourceBinding } = require("./sourceBinding.cjs");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const FEATURES = Object.freeze(["ai.model-invocation", "context.selected-read"]);
const ROUTES = Object.freeze([
  ["ai.openChat", "PluginAIEmptyParams", "PluginAIChatResult", "ai.invoke", "open"],
  ["ai.startTurn", "PluginAIStartTurnParams", "PluginAITurnResult", "ai.invoke", "start"],
  ["ai.readTurn", "PluginAITurnRef", "PluginAIStreamEvent", "ai.invoke", "read"],
  ["ai.stopTurn", "PluginAITurnRef", "PluginAIBooleanResult", "ai.invoke", "stop"],
  ["ai.closeChat", "PluginAIChatRef", "PluginAIBooleanResult", "ai.invoke", "close"],
  ["context.selected.list", "PluginAIEmptyParams", "PluginSelectedContextListResult", "context.selected.list", "list"],
  ["context.selected.read", "PluginSelectedContextRef", "PluginSelectedContextContent", "context.selected.read", "readSelected"],
]);

class PluginAIContextService {
  constructor(options) {
    this.host = options.hostAdapter;
    for (const method of ["selectModel", "listSelected", "reviewText", "assertActive"]) {
      if (typeof this.host?.[method] !== "function") throw new TypeError(`AI host adapter ${method} required`);
    }
    this.source = new PluginAISourceBinding(options);
    this.permissionEngine = options.permissionEngine;
    this.resolveOwner = (context) => this.source.resolve(context);
    this.selected = new SelectedContextAuthority({ resolveDataOwner: this.resolveOwner });
    this.runtimeContexts = new Map();
    this.registrations = [];
    this.broker = new ModelInvocationBroker({ resolveDataOwner: this.resolveOwner,
      resolveBudgetOwner: (binding) => JSON.stringify([binding.sourceKey, binding.privateOwner]),
      selectModel: async (context) => {
        await this.#guard(context);
        const model = await this.host.selectModel(context);
        await this.#guard(context);
        return model;
      },
      contexts: {
        read: (reference, context) => this.readSelected(reference, context),
        assertCurrent: (reference, context) => this.selected.assertCurrent(reference, context),
        onDidInvalidate: (listener) => this.selected.onDidInvalidate(listener),
        releaseRuntime: (runtimeId) => this.selected.releaseRuntime(runtimeId),
        releaseOwner: (owner) => this.selected.releaseOwner(owner),
      },
    });
    this.revocation = this.permissionEngine.onDidRevoke((event) => this.releasePlugin(event.pluginId));
    this.unsubscribeHost = this.host.onDidInvalidate?.(() => this.releaseAll());
  }

  async #guard(context) {
    try {
      const owner = await this.resolveOwner(context);
      await this.host.assertActive(context);
      if (await this.resolveOwner(context) !== owner) throw fail("permissionDenied", "Plugin source changed");
      return owner;
    } catch (error) {
      const binding = this.source.bindings.get(context.runtimeId);
      if (!context.signal?.aborted && binding?.pluginId === context.pluginId && binding.pluginVersion === context.pluginVersion) this.releaseRuntime(context.runtimeId);
      throw error;
    }
  }

  #authorization(permission, params) {
    const resource = permission === "context.selected.read" ? `selected:${params.handle}:${params.version}` : "*";
    return { permission, resources: [resource],
      reason: permission === "ai.invoke" ? "Use the model selected in Netcatty without tools"
        : permission === "context.selected.list" ? "List summaries of the current selected context"
          : "Review and share this selected context version",
      ...(permission === "context.selected.read" ? { allowedScopes: ["once"] } : {}),
    };
  }

  registerRpcCapabilities(registry) {
    if (this.registrations.length) throw new Error("AI/context routes are already registered");
    // Canonical validators are created only when transport integration registers
    // this service. There is no second plugin wire schema in these modules.
    const prepared = ROUTES.map(([method, paramsType, resultType, permission, operation]) => ({
      method, permission, operation,
      validateParams: createDefinitionValidator(paramsType),
      validateResult: createDefinitionValidator(resultType),
    }));
    for (const route of prepared) {
      this.registrations.push(registry.registerRequest(route.method, async (params, context) => {
        await this.#guard(context);
        const result = await this[route.operation](params, context);
        await this.#guard(context);
        if (!route.validateResult(result)) throw fail("internal", "AI/context response is invalid");
        return result;
      }, {
        metadata: { capability: "plugin-ai-context", mutating: false, permission: route.permission },
        validateParams: (params) => {
          if (!route.validateParams(params)) throw fail("invalidArgument", "AI/context request is invalid");
          return Object.freeze(structuredClone(params));
        },
        authorization: async (params, context) => {
          await this.#guard(context);
          const references = route.operation === "readSelected" ? [params] : route.operation === "start" ? params.contexts ?? [] : [];
          let displayContext;
          if (route.operation === "start" || references.length) {
            for (const reference of references) await this.selected.assertCurrent(reference, context);
            const summaries = references.length ? await this.selected.summaries(context) : [];
            const selections = references.map((reference) => {
              const summary = summaries.find((item) => item.handle === reference.handle && item.version === reference.version);
              if (!summary) throw fail("permissionDenied", "Selected context changed");
              return { title: summary.title, scope: summary.scope, version: summary.version };
            });
            displayContext = { ...(route.operation === "start" ? await this.broker.describeChat(params.chatHandle, context) : {}), selections };
          }
          return { ...this.#authorization(route.permission, params),
            ...(displayContext ? { displayContext } : {}),
            ...(route.operation === "start" && params.contexts?.length ? { relatedPermissions: params.contexts.map((reference) => (
              this.#authorization("context.selected.read", reference)
            )) } : {}),
            // Open selects a model; start is the meaningful invocation. The
            // broker's source-bound handles authorize subsequent stream work.
            ...(["open", "list", "read", "stop", "close"].includes(route.operation) ? { deferDecision: true } : {}),
          };
        },
      }));
    }
  }

  open(_params, context) { return this.broker.open(context); }
  start(params, context) { return this.broker.start(params, context); }
  read({ turnHandle }, context) { return this.broker.read(turnHandle, context); }
  async stop({ turnHandle }, context) { return { ok: await this.broker.stop(turnHandle, context) }; }
  async close({ chatHandle }, context) { return { ok: await this.broker.close(chatHandle, context) }; }

  async list(_params, context) {
    const owner = await this.#guard(context);
    const selections = await this.host.listSelected(context);
    await this.#guard(context);
    if (!Array.isArray(selections) || selections.length > 5 || new Set(selections.map((item) => item.scope)).size !== selections.length) {
      throw fail("resourceExhausted", "Selected scope limit reached");
    }
    const previous = this.runtimeContexts.get(context.runtimeId);
    if (previous?.owner === owner && previous.keys === JSON.stringify(selections.map(({ key, version }) => [key, version]))) {
      const items = await this.selected.summaries(context);
      if (items.length === selections.length) return { items };
      // The host has just explicitly selected these resources again. Expired
      // or revoked handles stay invalid; issue fresh handles for this selection.
    }
    this.selected.releaseRuntime(context.runtimeId);
    const created = [];
    try {
      for (const { key, scope, title, version, readText, isCurrent } of selections) {
        if (typeof key !== "string" || !key || key.length > 256) throw fail("invalidArgument", "Host selection key is invalid");
        const summary = await this.selected.share({ scope, title, version, readText, isCurrent }, context);
        created.push(summary.handle);
      }
      await this.#guard(context);
      this.runtimeContexts.set(context.runtimeId, { owner, keys: JSON.stringify(selections.map(({ key, version }) => [key, version])) });
      return { items: await this.selected.summaries(context) };
    } catch (error) { for (const handle of created) this.selected.release(handle); throw error; }
  }

  async readSelected(reference, context) {
    await this.#guard(context);
    await this.selected.assertCurrent(reference, context);
    const authorization = this.#authorization("context.selected.read", reference);
    // Direct RPC reads have already passed the registry permission middleware.
    // A model turn must obtain its separate content grant here.
    if (context.method !== "context.selected.read" || context.authorization?.permission !== authorization.permission
      || context.authorization.resources?.[0] !== authorization.resources[0]) {
      await this.permissionEngine.authorize(context, authorization);
    }
    await this.#guard(context);
    const selected = await this.selected.read(reference, context);
    await this.#guard(context);
    // The selected handle and version are checked on both sides of the read.
    // Permission middleware (or the model-turn content check above) owns Ask.
    await this.#guard(context);
    await this.selected.assertCurrent(reference, context);
    return selected;
  }

  releaseRuntime(runtimeId) {
    this.broker.releaseRuntime(runtimeId);
    this.runtimeContexts.delete(runtimeId);
    this.source.releaseRuntime(runtimeId);
    this.host.releaseRuntime?.(runtimeId);
  }
  releasePlugin(pluginId) {
    for (const [runtimeId, { owner }] of [...this.runtimeContexts]) if (owner.pluginId === pluginId) this.releaseRuntime(runtimeId);
    for (const binding of [...this.source.bindings.values()]) if (binding.pluginId === pluginId) this.releaseRuntime(binding.runtimeId);
    this.source.releasePlugin(pluginId);
  }
  releaseAll() { for (const binding of [...this.source.bindings.values()]) this.releaseRuntime(binding.runtimeId); }
  shutdown() {
    for (const registration of this.registrations.splice(0)) registration.dispose();
    this.releaseAll(); this.broker.shutdown(); this.selected.shutdown(); this.source.shutdown();
    this.revocation.dispose(); this.unsubscribeHost?.(); this.host.shutdown?.();
  }
}

module.exports = { PluginAIContextService, PLUGIN_AI_CONTEXT_FEATURES: FEATURES, AI_CONTEXT_ROUTES: ROUTES };
