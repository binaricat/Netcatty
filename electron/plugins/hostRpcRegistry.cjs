"use strict";

const RESERVED_METHODS = new Set([
  "plugin.initialize",
  "plugin.activate",
  "plugin.deactivate",
  "$/cancelRequest",
  "$/progress",
]);

function assertHostMethod(method) {
  if (
    typeof method !== "string"
    || method.length < 1
    || method.length > 256
    || method.startsWith("$/")
    || RESERVED_METHODS.has(method)
  ) {
    throw new TypeError(`Invalid or reserved plugin host RPC method: ${String(method)}`);
  }
  return method;
}

function assertHandler(handler, label) {
  if (typeof handler !== "function") throw new TypeError(`${label} must be a function`);
  return handler;
}

function cloneAndFreezeMetadata(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Plugin host RPC metadata numbers must be finite");
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new TypeError("Plugin host RPC metadata must be an acyclic JSON-like value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("Plugin host RPC metadata must use plain objects and arrays");
  }
  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((item) => cloneAndFreezeMetadata(item, seen));
  } else {
    clone = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("Plugin host RPC metadata keys must be strings");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Plugin host RPC metadata must contain enumerable data properties");
      }
      Object.defineProperty(clone, key, {
        value: cloneAndFreezeMetadata(descriptor.value, seen),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }
  seen.delete(value);
  return Object.freeze(clone);
}

function normalizeRuntimeIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("Plugin runtime identity must be an object");
  }
  for (const key of ["pluginId", "pluginVersion", "runtimeId", "runtimeKind"]) {
    if (typeof identity[key] !== "string" || identity[key].length < 1) {
      throw new TypeError(`Plugin runtime identity ${key} is required`);
    }
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    ...(identity.manifest === undefined ? {} : { manifest: identity.manifest }),
    ...(identity.securityPrincipal === undefined ? {} : { securityPrincipal: identity.securityPrincipal }),
    ...(identity.sourceOwner === undefined ? {} : { sourceOwner: identity.sourceOwner, sourceId: identity.sourceId }),
    ...(identity.packageRoot === undefined ? {} : { packageRoot: identity.packageRoot }),
    ...(identity.logger === undefined ? {} : { logger: identity.logger }),
  });
}

function createDisposable(dispose) {
  let disposed = false;
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  });
}

class PluginHostRpcRegistry {
  constructor() {
    this.requests = new Map();
    this.notifications = new Map();
    this.middleware = new Set();
    this.incomingStreams = new Set();
    this.revision = 0;
  }

  #register(collection, kind, method, handler, options = {}) {
    const normalizedMethod = assertHostMethod(method);
    assertHandler(handler, `Plugin host ${kind} handler`);
    if (options.validateParams != null) {
      assertHandler(options.validateParams, `Plugin host ${kind} parameter validator`);
    }
    if (typeof options.authorization === "function") {
      assertHandler(options.authorization, `Plugin host ${kind} authorization resolver`);
    }
    if (this.requests.has(normalizedMethod) || this.notifications.has(normalizedMethod)) {
      throw new Error(`Plugin host RPC method is already registered: ${normalizedMethod}`);
    }
    const registration = Object.freeze({
      handler,
      metadata: cloneAndFreezeMetadata(options.metadata ?? {}),
      validateParams: options.validateParams ?? null,
      authorization: typeof options.authorization === "function"
        ? options.authorization
        : options.authorization == null
          ? null
          : cloneAndFreezeMetadata(options.authorization),
    });
    collection.set(normalizedMethod, registration);
    this.revision += 1;
    return createDisposable(() => {
      if (collection.get(normalizedMethod) !== registration) return;
      collection.delete(normalizedMethod);
      this.revision += 1;
    });
  }

  registerRequest(method, handler, options) {
    return this.#register(this.requests, "request", method, handler, options);
  }

  registerNotification(method, handler, options) {
    return this.#register(this.notifications, "notification", method, handler, options);
  }

  use(middleware) {
    assertHandler(middleware, "Plugin host RPC middleware");
    this.middleware.add(middleware);
    this.revision += 1;
    return createDisposable(() => {
      if (!this.middleware.delete(middleware)) return;
      this.revision += 1;
    });
  }

  registerIncomingStream(handler) {
    assertHandler(handler, "Plugin incoming stream handler");
    this.incomingStreams.add(handler);
    this.revision += 1;
    return createDisposable(() => {
      if (!this.incomingStreams.delete(handler)) return;
      this.revision += 1;
    });
  }

  createRoutes(runtimeIdentity) {
    const assertCurrent = runtimeIdentity?.assertCurrent;
    if (assertCurrent != null) assertHandler(assertCurrent, "Plugin runtime identity guard");
    const identity = normalizeRuntimeIdentity(runtimeIdentity);
    const middleware = [...this.middleware];
    const streamHandlers = [...this.incomingStreams];
    const createHandler = (kind, method, registration) => async (params, transportContext) => {
      const operationController = new AbortController();
      const signal = transportContext.signal ? AbortSignal.any([transportContext.signal, operationController.signal]) : operationController.signal;
      const authorizationGuards = [];
      // Host-only identity shared by internal derived contexts, never a wire
      // field or a plugin-provided token. Every RPC receives a fresh object.
      const permissionOperation = Object.freeze({});
      const assertActive = async () => {
        signal.throwIfAborted();
        for (const guard of authorizationGuards) guard();
        transportContext.signal?.throwIfAborted();
        await assertCurrent?.();
        transportContext.signal?.throwIfAborted();
      };
      const startedAt = Date.now();
      let authorizationOutcome = "not-reached";
      let auditResources;
      let auditResult;
      let auditError;
      const authorizationCleanup = [];
      try {
        await assertActive();
        const validatedParams = registration.validateParams
          ? registration.validateParams(params)
          : params;
        if (validatedParams && typeof validatedParams.then === "function") {
          throw new TypeError("Plugin host RPC parameter validators must be synchronous");
        }
        const authorizationContext = Object.freeze({
          ...transportContext,
          ...identity,
          signal,
          permissionOperation,
          addAuthorizationGuard: (guard) => authorizationGuards.push(guard),
          cancelAuthorization: (reason) => operationController.abort(reason),
          assertActive,
          kind,
          method,
          metadata: registration.metadata,
          recordAuthorization: (outcome) => {
            if (["allowed", "denied", "not-required"].includes(outcome)) authorizationOutcome = outcome;
          },
          params: validatedParams,
        });
        for (const current of middleware) {
          const cleanup = current.prepareAuthorization?.(authorizationContext);
          if (typeof cleanup === "function") authorizationCleanup.push(cleanup);
        }
        const resolvedAuthorization = typeof registration.authorization === "function"
          ? await registration.authorization(validatedParams, authorizationContext)
          : registration.authorization;
        const authorization = resolvedAuthorization == null
          ? null
          : cloneAndFreezeMetadata(resolvedAuthorization);
        auditResources = authorization?.resources;
        await assertActive();
        const context = Object.freeze({
          ...authorizationContext,
          authorization,
        });
        let index = -1;
        const dispatch = async (nextIndex) => {
          if (nextIndex <= index) throw new Error("Plugin host RPC middleware called next() more than once");
          index = nextIndex;
          const current = middleware[nextIndex];
          if (current) return current(context, () => dispatch(nextIndex + 1));
          await assertActive();
          return registration.handler(validatedParams, context);
        };
        const result = await dispatch(0);
        await assertActive();
        auditResult = result;
        return result;
      } catch (error) {
        auditError = error;
        throw error;
      } finally {
        for (const cleanup of authorizationCleanup) cleanup();
        // Never record params, handler results, error messages or plugin text.
        const dataBytes = (value) => {
          if (typeof value === "string") return Buffer.byteLength(value);
          if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
          return null;
        };
        const field = (value, key) => value && typeof value === "object"
          ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
        try { identity.logger?.audit?.({ operation: method, resources: auditResources,
          authorization: authorizationOutcome, result: auditError ? "error" : "ok",
          errorCode: auditError?.code, durationMs: Date.now() - startedAt,
          inputBytes: dataBytes(field(params, "data")), outputBytes: dataBytes(field(auditResult, "data")) }); } catch {}
      }
    };
    const requestHandlers = Object.freeze(Object.fromEntries(
      [...this.requests].map(([method, registration]) => [
        method,
        createHandler("request", method, registration),
      ]),
    ));
    const notificationHandlers = Object.freeze(Object.fromEntries(
      [...this.notifications].map(([method, registration]) => [
        method,
        createHandler("notification", method, registration),
      ]),
    ));
    const onIncomingStream = async (stream) => {
      stream.signal?.throwIfAborted();
      await assertCurrent?.();
      const context = Object.freeze({
        ...identity,
        signal: stream.signal,
        assertActive: async () => {
          stream.signal?.throwIfAborted();
          await assertCurrent?.();
          stream.signal?.throwIfAborted();
        },
        kind: "stream",
      });
      for (const handler of streamHandlers) {
        const accepted = await handler(stream, context);
        if (accepted === true) {
          await context.assertActive();
          return true;
        }
        if (accepted !== false && accepted !== undefined) {
          throw new TypeError("Plugin incoming stream handler must return true, false, or undefined");
        }
      }
      await context.assertActive();
      return false;
    };
    return Object.freeze({
      notificationHandlers,
      onIncomingStream,
      requestHandlers,
      revision: this.revision,
    });
  }
}

function createDefaultPluginHostRpcRegistry(options) {
  const registry = new PluginHostRpcRegistry();
  registry.registerRequest("storage.get", async ({ key }, context) => {
    const value = options.database.getValue(context.pluginId, key);
    return value === undefined ? { found: false } : { found: true, value };
  }, {
    metadata: { capability: "storage", mutating: false, permission: "storage" },
    authorization: { permission: "storage", resources: ["*"], reason: "Access plugin storage" },
    validateParams: (params) => options.assertStorageParams(params),
  });
  registry.registerRequest("storage.set", async ({ key, value }, context) => {
    options.database.setValue(context.pluginId, key, value);
    return null;
  }, {
    metadata: { capability: "storage", mutating: true, permission: "storage" },
    authorization: { permission: "storage", resources: ["*"], reason: "Modify plugin storage" },
    validateParams: (params) => options.assertStorageParams(params, { value: true }),
  });
  registry.registerRequest("storage.delete", async ({ key }, context) => {
    options.database.deleteValue(context.pluginId, key);
    return null;
  }, {
    metadata: { capability: "storage", mutating: true, permission: "storage" },
    authorization: { permission: "storage", resources: ["*"], reason: "Modify plugin storage" },
    validateParams: (params) => options.assertStorageParams(params),
  });
  registry.registerRequest("storage.keys", async (params, context) => {
    return { keys: options.database.listKeys(context.pluginId) };
  }, {
    metadata: { capability: "storage", mutating: false, permission: "storage" },
    authorization: { permission: "storage", resources: ["*"], reason: "List plugin storage keys" },
    validateParams: (params) => {
      if (params && (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 0)) {
        throw new TypeError("storage.keys does not accept parameters");
      }
      return params;
    },
  });
  registry.registerNotification("log.write", async (params, context) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    await context.logger.write(params.level, params.message, params.fields);
  }, { metadata: { capability: "logging", mutating: false, public: true } });
  return registry;
}

module.exports = {
  PluginHostRpcRegistry,
  assertHostMethod,
  cloneAndFreezeMetadata,
  createDefaultPluginHostRpcRegistry,
  normalizeRuntimeIdentity,
};
