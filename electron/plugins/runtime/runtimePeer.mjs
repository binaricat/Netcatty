import {
  CancellationTokenSource,
  DisposableStore,
  PluginError,
  PLUGIN_ERROR_WIRE_CODES,
  pluginErrorToRpcError,
} from "@netcatty/plugin-sdk";
import { createMessagePortStreamEnvelope, PLUGIN_HOST_INTERACTION_LIMITS, PLUGIN_FILESYSTEM_DIRECTORY_ENUMERATION_FEATURE } from "@netcatty/plugin-contract";
import { createPluginStreamEndpoint } from "./pluginStreamEndpoint.mjs";
import { connectByteStream } from "./byteStreamClient.mjs";

let terminalInterceptorTransportPromise;

function loadTerminalInterceptorTransport() {
  terminalInterceptorTransportPromise ??= import("../terminalInterceptorTransport.cjs")
    .then((module) => module.default);
  return terminalInterceptorTransportPromise;
}

const RPC_ERRORS = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  cancelled: -32001,
  unsupported: -32012,
};

const PLUGIN_ERROR_NAMES_BY_WIRE_CODE = new Map(
  Object.entries(PLUGIN_ERROR_WIRE_CODES).map(([name, code]) => [code, name]),
);

const PROVIDER_KINDS = new Set([
  "terminal.completion",
  "terminal.decoration",
  "terminal.link",
  "terminal.hover",
  "terminal.matcher",
  "terminal.semantic",
  "terminal.prompt",
  "terminal.background",
  "terminal.theme",
  "terminal.interceptor.input",
  "terminal.interceptor.output",
  "connection",
  "authentication",
  "sync",
  "importer",
]);

const CONNECTION_PROVIDER_OPERATIONS = Object.freeze([
  "validateConfiguration",
  "probe",
  "open",
  "resize",
  "signal",
  "reconnect",
  "close",
  "getStatus",
]);
const IMPORTER_PROVIDER_OPERATIONS = Object.freeze(["detect", "parse"]);
const SYNC_PROVIDER_OPERATIONS = Object.freeze([
  "connect",
  "disconnect",
  "getAccount",
  "getCapabilities",
  "readObject",
  "writeObject",
  "deleteObject",
]);
const OPERATION_MAP_PROVIDER_KINDS = Object.freeze(new Set(["connection", "importer", "sync"]));

function pluginErrorNameFromRpcError(error) {
  if (typeof error?.data?.pluginCode === "string") return error.data.pluginCode;
  if (error?.code === RPC_ERRORS.methodNotFound) return "unsupported";
  if (error?.code === RPC_ERRORS.invalidParams) return "invalid_argument";
  if (error?.code === RPC_ERRORS.internal) return "internal";
  return PLUGIN_ERROR_NAMES_BY_WIRE_CODE.get(error?.code) ?? "unknown";
}

function freezeRuntimeJson(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Array.isArray(item) ? item : Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

function messageData(value) {
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

function closeTransferredPorts(ports) {
  for (const port of ports ?? []) port?.close?.();
}

function createTransportAdapter(port) {
  const listeners = new Set();
  const handle = (event) => {
    const value = messageData(event);
    for (const listener of listeners) listener(value, event?.ports ?? []);
  };
  if (typeof port.addEventListener === "function") port.addEventListener("message", handle);
  else port.on("message", handle);
  port.start?.();
  return {
    post(message, transfer = []) {
      port.postMessage(message, transfer);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      port.close?.();
    },
  };
}

function makeRpcFailure(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function cancelUnhandledStream(transport, message) {
  const keys = Reflect.ownKeys(message);
  if (keys.some((key) => typeof key !== "string" || (key !== "frame" && key !== "transfer"))) {
    throw new TypeError("Plugin stream envelope contains unknown properties");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Plugin stream envelope must contain enumerable data properties");
    }
  }
  const envelope = createMessagePortStreamEnvelope(message.frame, message.transfer);
  if (envelope.frame.kind !== "open") {
    throw new Error(`Unknown incoming plugin stream: ${envelope.frame.streamId}`);
  }
  transport.post(createMessagePortStreamEnvelope({
    streamId: envelope.frame.streamId,
    sequence: 1,
    kind: "cancel",
  }));
}

function normalizeError(error) {
  if (error instanceof PluginError) {
    return pluginErrorToRpcError(error);
  }
  return { code: RPC_ERRORS.internal, message: "Plugin operation failed" };
}

function createHostClient(transport) {
  let nextId = 0;
  const pending = new Map();
  function accept(message) {
    if (!message || typeof message !== "object" || !Object.hasOwn(message, "id")) return false;
    if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) return false;
    const request = pending.get(`${typeof message.id}:${String(message.id)}`);
    if (!request) return false;
    pending.delete(`${typeof message.id}:${String(message.id)}`);
    request.cancellation?.dispose();
    if (message.error) {
      request.reject(new PluginError(
        pluginErrorNameFromRpcError(message.error),
        message.error.message,
        message.error.data?.details,
      ));
    } else request.resolve(message.result);
    return true;
  }
  function request(method, params, options = {}) {
    if (options.cancellationToken?.isCancellationRequested) return Promise.reject(new PluginError("cancelled", "Plugin request cancelled"));
    const id = nextId;
    nextId = nextId === Number.MAX_SAFE_INTEGER ? 0 : nextId + 1;
    return new Promise((resolve, reject) => {
      const cancellationId = options.cancellationToken ? `browser-${id}` : undefined;
      const pendingRequest = { resolve, reject };
      pending.set(`${typeof id}:${String(id)}`, pendingRequest);
      transport.post({
        jsonrpc: "2.0",
        id,
        method,
        params,
        ...(cancellationId === undefined ? {} : { cancellationId }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      });
      pendingRequest.cancellation = options.cancellationToken?.onCancellationRequested(() => {
        notify("$/cancelRequest", { cancellationId });
      });
    });
  }
  function notify(method, params) {
    transport.post({ jsonrpc: "2.0", method, params });
  }
  function close() {
    const error = new PluginError("unavailable", "Plugin host disconnected");
    for (const request of pending.values()) { request.cancellation?.dispose(); request.reject(error); }
    pending.clear();
  }
  return { accept, request, notify, close };
}

function assertStorageKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || key.includes("\0")) {
    throw new PluginError("invalid_argument", "Plugin storage key is invalid");
  }
  return key;
}

function assertCredentialRef(credential) {
  if (
    !credential
    || typeof credential !== "object"
    || (credential.kind !== "secret" && credential.kind !== "credential")
    || typeof credential.id !== "string"
    || credential.id.length < 16
    || credential.id.length > 256
  ) throw new PluginError("invalid_argument", "Credential reference is invalid");
  if (
    credential.kind === "secret"
    && (
      typeof credential.key !== "string"
      || credential.key.length < 1
      || credential.key.length > 256
      || credential.key.includes("\0")
    )
  ) throw new PluginError("invalid_argument", "Credential reference is invalid");
  return credential.kind === "secret"
    ? { kind: "secret", id: credential.id, key: credential.key }
    : { kind: "credential", id: credential.id };
}

function forwardedDeadline(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : undefined;
}

function assertCompanionId(companionId) {
  if (typeof companionId !== "string" || companionId.length < 5 || companionId.length > 192) {
    throw new PluginError("invalid_argument", "Companion ID is invalid");
  }
  return companionId;
}

function assertOwnedContributionId(pluginId, id, label) {
  if (typeof id !== "string" || !id.startsWith(`${pluginId}.`) || id.length > 256) {
    throw new PluginError("invalid_argument", `${label} ID is invalid`);
  }
  return id;
}

function assertProviderKind(kind) {
  if (!PROVIDER_KINDS.has(kind)) {
    throw new PluginError("invalid_argument", "Plugin Provider kind is invalid");
  }
  return kind;
}

function operationMapLabel(kind) {
  if (kind === "connection") return "Connection";
  if (kind === "importer") return "Importer";
  if (kind === "sync") return "Sync";
  return kind;
}

function operationsForProviderKind(kind) {
  if (kind === "connection") return CONNECTION_PROVIDER_OPERATIONS;
  if (kind === "importer") return IMPORTER_PROVIDER_OPERATIONS;
  if (kind === "sync") return SYNC_PROVIDER_OPERATIONS;
  return null;
}

function normalizeProviderHandler(kind, handler) {
  if (!OPERATION_MAP_PROVIDER_KINDS.has(kind)) {
    if (typeof handler !== "function") {
      throw new PluginError("invalid_argument", "Plugin Provider handler must be a function");
    }
    return handler;
  }
  const label = operationMapLabel(kind);
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) {
    throw new PluginError("invalid_argument", `${label} Provider handler must be an operation map`);
  }
  const normalized = {};
  const operations = operationsForProviderKind(kind);
  for (const operation of operations) {
    if (typeof handler[operation] !== "function") {
      throw new PluginError("invalid_argument", `${label} Provider handler is missing operation: ${operation}`);
    }
    normalized[operation] = handler[operation].bind(handler);
  }
  return Object.freeze(normalized);
}

function assertOwnedContextKey(pluginId, key) {
  const prefix = `${pluginId}.`;
  const suffix = typeof key === "string" && key.startsWith(prefix)
    ? key.slice(prefix.length)
    : "";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_:-]{0,255}$/u.test(suffix)
    || key.length > 256) {
    throw new PluginError("invalid_argument", "Plugin Context Key ID is invalid");
  }
  return key;
}

function normalizeRuntimeEnvironment(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceTokens = source.themeTokens && typeof source.themeTokens === "object"
    && !Array.isArray(source.themeTokens)
    ? source.themeTokens
    : {};
  const themeTokens = Object.freeze(Object.fromEntries(
    Object.entries(sourceTokens).filter(([key, token]) => key.length > 0 && typeof token === "string"),
  ));
  return Object.freeze({
    locale: typeof source.locale === "string" ? source.locale : "en",
    theme: typeof source.theme === "string" ? source.theme : "system",
    reducedMotion: source.reducedMotion === true,
    highContrast: source.highContrast === true,
    themeTokens,
  });
}

function createEmitter() {
  const listeners = new Set();
  return {
    event(listener) {
      if (typeof listener !== "function") throw new PluginError("invalid_argument", "Plugin event listener must be a function");
      listeners.add(listener);
      return Object.freeze({ dispose: () => listeners.delete(listener) });
    },
    fire(value) {
      for (const listener of [...listeners]) {
        try { listener(value); } catch {}
      }
    },
    clear() { listeners.clear(); },
  };
}

function createPluginContext(config, client, runtimeApi) {
  const subscriptions = new DisposableStore();
  const storage = {
    get: (key) => client.request("storage.get", { key: assertStorageKey(key) })
      .then((result) => result?.found ? result.value : undefined),
    set: (key, value) => client.request("storage.set", { key: assertStorageKey(key), value })
      .then(() => undefined),
    delete: (key) => client.request("storage.delete", { key: assertStorageKey(key) })
      .then(() => undefined),
    keys: () => client.request("storage.keys", {}).then((result) => result?.keys ?? []),
  };
  const secrets = {
    get: (key) => client.request("secrets.get", { key: assertStorageKey(key) })
      .then((result) => result?.found ? result.secret : undefined),
    set: (key, value) => client.request("secrets.set", {
      key: assertStorageKey(key),
      value,
    }).then((result) => result.secret),
    delete: (key) => client.request("secrets.delete", { key: assertStorageKey(key) })
      .then(() => undefined),
  };
  const credentials = {
    createLease: (secret, options) => client.request("credentials.createLease", {
      secret: assertCredentialRef(secret),
      operationId: options?.operationId,
      purpose: options?.purpose,
      ...(options?.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
  };
  const interact = (params) => client.request("ui.interact", params, { deadlineMs: PLUGIN_HOST_INTERACTION_LIMITS.timeoutMs })
    .then((result) => result.cancelled ? undefined : result.value);
  const ui = {
    quickPick: (title, items) => interact({ kind: "quickPick", title, items }),
    input: (title, initialValue) => interact({ kind: "input", title, ...(initialValue === undefined ? {} : { initialValue }) }),
  };
  const vault = Object.fromEntries(["selectHosts", "requestHostDraft", "requestConnect"].map((method) => [
    method, (params) => client.request(`vault.${method}`, params, { deadlineMs: PLUGIN_HOST_INTERACTION_LIMITS.timeoutMs }),
  ]));
  const clipboard = {
    readText: (title) => interact({ kind: "clipboard.read", title }),
    writeText: (text, title) => interact({ kind: "clipboard.write", title, text }).then((value) => value === true),
  };
  const network = {
    connect: (request, cancellationToken) => connectByteStream({ client, streams: runtimeApi.streams, subscriptions,
      enabledFeatures: config.enabledFeatures }, request, cancellationToken),
    request: (request) => client.request("network.request", request, {
      deadlineMs: forwardedDeadline(request?.timeoutMs, 300_000),
    }),
  };
  const ai = Object.fromEntries(["openChat", "startTurn", "readTurn", "stopTurn", "closeChat"].map((operation) => [
    operation, (params) => client.request(`ai.${operation}`, params, operation === "readTurn" ? { deadlineMs: 65_000 } : {}),
  ]));
  const selectedContext = {
    list: (params) => client.request("context.selected.list", params),
    read: (params) => client.request("context.selected.read", params),
  };
  const agent = Object.fromEntries(["listBackends", "selectTargets", "listChats", "openChat", "send", "read", "history", "stop", "closeChat"].map((operation) => [
    operation, (params) => client.request(`agent.${operation}`, params, operation === "read" ? { deadlineMs: 65_000 } : {}),
  ]));
  const filesystem = {
    readFile: (filePath, options = {}) => client.request("filesystem.readFile", {
      path: filePath,
      ...options,
    }).then((result) => result.data),
    writeFile: (filePath, data, options = {}) => client.request("filesystem.writeFile", {
      path: filePath,
      data,
      ...options,
    }).then(() => undefined),
    stat: (filePath) => client.request("filesystem.stat", { path: filePath }),
    readDirectory: async (directoryPath) => {
      if (!config.enabledFeatures?.includes(PLUGIN_FILESYSTEM_DIRECTORY_ENUMERATION_FEATURE)) {
        throw new PluginError("unsupported", "Secure plugin directory enumeration is unavailable on this runtime");
      }
      return (await client.request("filesystem.readDirectory", { path: directoryPath })).entries;
    },
  };
  const companions = {
    start: async (companionId) => {
      const result = await client.request("companion.start", {
        companionId: assertCompanionId(companionId),
      });
      let stopped = false;
      let stopPromise = null;
      const stop = () => {
        if (stopped) return Promise.resolve();
        if (stopPromise) return stopPromise;
        stopPromise = client.request("companion.stop", { handleId: result.handleId })
          .then(() => { stopped = true; })
          .finally(() => { stopPromise = null; });
        return stopPromise;
      };
      return Object.freeze({
        id: result.handleId,
        request: (method, params, options = {}) => client.request(
          "companion.request",
          {
            handleId: result.handleId,
            method,
            ...(params === undefined ? {} : { params }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.credentialLeases === undefined ? {} : {
              credentialLeases: options.credentialLeases,
              operationId: options.operationId,
            }),
          },
          { deadlineMs: forwardedDeadline(options.timeoutMs, 60_000) },
        ),
        stop,
        dispose() { void stop().catch(() => {}); },
      });
    },
  };
  const streams = {
    acceptReadable: (streamId) => runtimeApi.streams.acceptReadable(streamId),
    openWritable: (streamId, options = {}) => runtimeApi.streams.openWritable(
      streamId,
      options.windowBytes,
    ),
  };
  const settings = {
    get: (settingId, options = {}) => client.request("settings.get", {
      settingId: assertOwnedContributionId(config.pluginId, settingId, "Plugin setting"),
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
    }).then((result) => result?.found ? result.value : undefined),
    update: (settingId, value, options = {}) => client.request("settings.update", {
      settingId: assertOwnedContributionId(config.pluginId, settingId, "Plugin setting"),
      value,
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
    }).then((result) => result ?? { restartRequired: false }),
    onDidChange: runtimeApi.settingsChanged.event,
  };
  const commands = {
    registerCommand(commandId, handler) {
      const id = assertOwnedContributionId(config.pluginId, commandId, "Plugin command");
      if (typeof handler !== "function") throw new PluginError("invalid_argument", "Plugin command handler must be a function");
      if (runtimeApi.commandHandlers.has(id)) throw new PluginError("already_exists", `Plugin command is already registered: ${id}`);
      runtimeApi.commandHandlers.set(id, handler);
      return Object.freeze({
        dispose() {
          if (runtimeApi.commandHandlers.get(id) === handler) {
            runtimeApi.commandHandlers.delete(id);
          }
        },
      });
    },
    executeCommand: (commandId, args) => client.request("commands.execute", {
      command: assertOwnedContributionId(config.pluginId, commandId, "Plugin command"),
      ...(args === undefined ? {} : { args }),
    }),
  };
  const contextKeys = {
    set: (key, value) => client.request("contextKeys.set", {
      key: assertOwnedContextKey(config.pluginId, key),
      value,
    }).then(() => undefined),
  };
  const views = {
    onDidReceiveMessage(viewId, listener) {
      const id = assertOwnedContributionId(config.pluginId, viewId, "Plugin view");
      let emitter = runtimeApi.viewMessages.get(id);
      if (!emitter) {
        emitter = createEmitter();
        runtimeApi.viewMessages.set(id, emitter);
      }
      return emitter.event(listener);
    },
    postMessage: (viewId, message) => client.notify("views.postMessage", {
      viewId: assertOwnedContributionId(config.pluginId, viewId, "Plugin view"),
      message,
    }),
    getState: (viewId, scopeId) => client.request("views.getState", {
      viewId: assertOwnedContributionId(config.pluginId, viewId, "Plugin view"),
      scopeId,
    }).then((result) => result?.state),
    setState: (viewId, scopeId, state) => client.request("views.setState", {
      viewId: assertOwnedContributionId(config.pluginId, viewId, "Plugin view"),
      scopeId,
      state,
    }).then(() => undefined),
  };
  const providers = {
    register(providerId, kind, handler) {
      const id = assertOwnedContributionId(config.pluginId, providerId, "Plugin Provider");
      const normalizedKind = assertProviderKind(kind);
      const normalizedHandler = normalizeProviderHandler(normalizedKind, handler);
      if (runtimeApi.providerHandlers.has(id)) {
        throw new PluginError("already_exists", `Plugin Provider is already registered: ${id}`);
      }
      const registration = Object.freeze({ kind: normalizedKind, handler: normalizedHandler });
      runtimeApi.providerHandlers.set(id, registration);
      return Object.freeze({
        dispose() {
          if (runtimeApi.providerHandlers.get(id) === registration) {
            runtimeApi.providerHandlers.delete(id);
          }
        },
      });
    },
  };
  const terminals = {
    shareSelection: (title) => {
      if (!config.enabledFeatures?.includes("terminal.selection-sharing")) return Promise.reject(new Error("Terminal selection sharing is unsupported"));
      return interact({ kind: "terminal.selection.read", title }).then((value) => value === undefined ? undefined : Object.freeze(value));
    },
    proposeInput: (handle, text, title) => {
      if (!config.enabledFeatures?.includes("terminal.input-drafts")) return Promise.reject(new Error("Terminal input drafts are unsupported"));
      return interact({ kind: "terminal.input.propose", handle, text, title }).then((value) => value === true);
    },
    onDidChange: runtimeApi.terminalEvents.event,
  };
  const environment = {
    get locale() { return runtimeApi.environment.locale ?? "en"; },
    get theme() { return runtimeApi.environment.theme ?? "system"; },
    get reducedMotion() { return runtimeApi.environment.reducedMotion === true; },
    get highContrast() { return runtimeApi.environment.highContrast === true; },
    get themeTokens() { return runtimeApi.environment.themeTokens; },
    onDidChange: runtimeApi.environmentChanged.event,
  };
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
    level,
    (message, fields) => client.notify("log.write", {
      level,
      message: String(message).slice(0, 2_048),
      ...(fields === undefined ? {} : { fields }),
    }),
  ]));
  return {
    pluginId: config.pluginId,
    netcattyVersion: config.netcattyVersion,
    apiVersion: config.apiVersion,
    enabledFeatures: new Set(config.enabledFeatures),
    subscriptions,
    storage,
    settings,
    commands,
    contextKeys,
    views,
    providers,
    terminals,
    environment,
    secrets,
    credentials,
    network,
    ai,
    agent,
    selectedContext,
    ui,
    vault,
    clipboard,
    filesystem,
    companions,
    streams,
    logger,
  };
}

export async function startPluginRuntime({
  port,
  config,
  loadPlugin,
  loadTerminalInterceptorTransport: loadTerminalInterceptorTransportForRuntime = loadTerminalInterceptorTransport,
}) {
  const transport = createTransportAdapter(port);
  const client = createHostClient(transport);
  const cancellation = new Map();
  let plugin;
  let context;
  let activated = false;
  let deactivated = false;
  const runtimeApi = {
    commandHandlers: new Map(),
    providerHandlers: new Map(),
    settingsChanged: createEmitter(),
    environmentChanged: createEmitter(),
    terminalEvents: createEmitter(),
    environment: normalizeRuntimeEnvironment(config.environment),
    viewMessages: new Map(),
    terminalInterceptorPorts: new Set(),
    streams: null,
  };
  runtimeApi.streams = createPluginStreamEndpoint(transport);
  const pluginModule = await loadPlugin(config.entryUrl);
  plugin = pluginModule?.default;
  if (!plugin || typeof plugin.activate !== "function") {
    throw new Error("Plugin entrypoint must default-export a plugin with activate(context)");
  }

  async function handleRequest(message, cancellationToken, ports = []) {
    const isTerminalAttachment = message.method === "plugin.terminal.interceptor.attach";
    if (!isTerminalAttachment) closeTransferredPorts(ports);
    if (message.method === "plugin.initialize") {
      if (context) throw new PluginError("failed_precondition", "Plugin is already initialized");
      context = createPluginContext(config, client, runtimeApi);
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: [...config.enabledFeatures],
      };
    }
    if (message.method === "plugin.activate") {
      if (!context) throw new PluginError("failed_precondition", "Plugin must be initialized first");
      if (!activated) {
        if (message.params?.environment && typeof message.params.environment === "object"
          && !Array.isArray(message.params.environment)) {
          runtimeApi.environment = normalizeRuntimeEnvironment(message.params.environment);
        }
        const disposable = await plugin.activate(context);
        if (disposable && typeof disposable.dispose === "function") context.subscriptions.add(disposable);
        activated = true;
      }
      return null;
    }
    if (message.method === "plugin.deactivate") {
      if (!deactivated) {
        deactivated = true;
        await plugin.deactivate?.();
        context?.subscriptions.dispose();
      }
      return null;
    }
    if (message.method === "plugin.terminal.interceptor.attach") {
      if (ports.length !== 1) {
        closeTransferredPorts(ports);
        throw new PluginError("invalid_argument", "Terminal interceptor attachment requires exactly one port");
      }
      try {
        await attachTerminalInterceptor(message.params, ports, cancellationToken);
        return { accepted: true };
      } catch (error) {
        closeTransferredPorts(ports);
        throw error;
      }
    }
    if (message.method === "plugin.command.execute") {
      if (!activated || !context) throw new PluginError("failed_precondition", "Plugin is not activated");
      const command = assertOwnedContributionId(config.pluginId, message.params?.command, "Plugin command");
      const handler = runtimeApi.commandHandlers.get(command);
      if (!handler) throw new PluginError("failed_precondition", `Plugin command has no registered handler: ${command}`);
      return await handler(message.params?.args, message.params?.invocation);
    }
    if (message.method === "provider.invoke") {
      if (!activated || !context) throw new PluginError("failed_precondition", "Plugin is not activated");
      const providerId = assertOwnedContributionId(config.pluginId, message.params?.providerId, "Plugin Provider");
      const kind = assertProviderKind(message.params?.kind);
      const registration = runtimeApi.providerHandlers.get(providerId);
      if (!registration) {
        throw new PluginError("failed_precondition", `Plugin Provider has no registered handler: ${providerId}`);
      }
      if (registration.kind !== kind) {
        throw new PluginError("failed_precondition", `Plugin Provider kind changed: ${providerId}`);
      }
      const requestId = message.params?.requestId;
      if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) {
        throw new PluginError("invalid_argument", "Plugin Provider request ID is invalid");
      }
      const operation = message.params?.operation;
      if (typeof operation !== "string" || operation.length < 1 || operation.length > 128) {
        throw new PluginError("invalid_argument", "Plugin Provider operation is invalid");
      }
      const deadlineMs = message.params?.deadlineMs;
      if (deadlineMs != null && (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000)) {
        throw new PluginError("invalid_argument", "Plugin Provider deadline is invalid");
      }
      const payload = message.params?.payload === undefined
        ? undefined
        : freezeRuntimeJson(message.params.payload);
      const connectionOpen = kind === "connection" && operation === "open";
      const importerParse = kind === "importer" && operation === "parse";
      const syncReadStream = kind === "sync" && operation === "readObject" && typeof payload?.outputStreamId === "string";
      const syncWriteStream = kind === "sync" && operation === "writeObject" && typeof payload?.inputStreamId === "string";
      const streamed = connectionOpen || importerParse || syncReadStream || syncWriteStream;
      let input;
      let output;
      let cancelStreams;
      if (streamed) {
        const inputStreamId = payload?.inputStreamId;
        const outputStreamId = payload?.outputStreamId;
        const windowBytes = payload?.windowBytes;
        if (connectionOpen || importerParse) {
          if (typeof inputStreamId !== "string" || typeof outputStreamId !== "string") {
            throw new PluginError("invalid_argument", "Streamed Provider invocation requires input and output stream IDs");
          }
        } else if (syncReadStream && typeof outputStreamId !== "string") {
          throw new PluginError("invalid_argument", "Sync readObject stream requires an output stream ID");
        } else if (syncWriteStream && typeof inputStreamId !== "string") {
          throw new PluginError("invalid_argument", "Sync writeObject stream requires an input stream ID");
        }
        if (typeof inputStreamId === "string") {
          input = runtimeApi.streams.acceptReadable(inputStreamId);
          // Prevent a cancelled request from creating an unhandled rejected
          // promise when the Provider never awaited its input stream.
          void input.catch(() => {});
        }
        if (typeof outputStreamId === "string") {
          try {
            output = await runtimeApi.streams.openWritable(outputStreamId, windowBytes);
          } catch (error) {
            if (typeof inputStreamId === "string") {
              runtimeApi.streams.rejectReadable(inputStreamId, error);
            }
            throw error;
          }
        }
        cancelStreams = () => {
          const error = new PluginError("cancelled", "Streamed Provider invocation was cancelled");
          if (typeof inputStreamId === "string") {
            runtimeApi.streams.rejectReadable(inputStreamId, error);
            void input?.then((stream) => stream.cancel(), () => {});
          }
          output?.cancel?.();
        };
      }
      const cancellationDisposable = cancelStreams
        ? cancellationToken.onCancellationRequested(cancelStreams)
        : null;
      const invocation = Object.freeze({
        providerId,
        kind,
        operation,
        requestId,
        payload,
        deadlineMs,
        cancellationToken,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
      });
      try {
        const handler = OPERATION_MAP_PROVIDER_KINDS.has(registration.kind)
          ? registration.handler[operation]
          : registration.handler;
        if (typeof handler !== "function") {
          throw new PluginError("invalid_argument", `${kind} Provider operation is not implemented: ${operation}`);
        }
        const result = await handler(invocation);
        if (cancellationToken.isCancellationRequested) {
          return { requestId, status: "cancelled" };
        }
        // Sync readObject may return inline base64 or found:false while the host
        // still opened an output stream for large-object fallback — release it.
        if (syncReadStream && output && !(result && result.streamed === true)) {
          try { output.cancel?.(); } catch { /* best-effort */ }
        }
        return { requestId, status: "ok", result: result === undefined ? null : result };
      } catch (error) {
        cancelStreams?.();
        if (cancellationToken.isCancellationRequested) {
          return { requestId, status: "cancelled" };
        }
        const rpcError = normalizeError(error);
        return {
          requestId,
          status: "failed",
          error: { code: rpcError.code, message: rpcError.message, ...(rpcError.data === undefined ? {} : { data: rpcError.data }) },
        };
      } finally {
        cancellationDisposable?.dispose();
        if (streamed && cancellationToken.isCancellationRequested) cancelStreams();
      }
    }
    throw new PluginError("unsupported", `Unsupported host method: ${message.method}`);
  }

  function handleNotification(message) {
    if (message.method === "plugin.settings.changed") {
      runtimeApi.settingsChanged.fire(message.params);
      return true;
    }
    if (message.method === "plugin.environment.changed") {
      runtimeApi.environment = normalizeRuntimeEnvironment(message.params);
      runtimeApi.environmentChanged.fire(runtimeApi.environment);
      return true;
    }
    if (message.method === "plugin.view.message") {
      const viewId = assertOwnedContributionId(config.pluginId, message.params?.viewId, "Plugin view");
      runtimeApi.viewMessages.get(viewId)?.fire(message.params?.message);
      return true;
    }
    if (message.method === "plugin.terminal.event") {
      runtimeApi.terminalEvents.fire(freezeRuntimeJson(message.params));
      return true;
    }
    return false;
  }

  const attachTerminalInterceptor = async (message, ports, cancellationToken) => {
    const descriptor = message?.descriptor;
    const providerId = assertOwnedContributionId(config.pluginId, descriptor?.providerId, "Terminal interceptor");
    const direction = descriptor?.direction;
    const kind = direction === "input" ? "terminal.interceptor.input"
      : direction === "output" ? "terminal.interceptor.output" : null;
    const sessionId = descriptor?.session?.sessionId;
    if (!kind || typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 256) {
      throw new PluginError("invalid_argument", "Terminal interceptor descriptor is invalid");
    }
    const registration = runtimeApi.providerHandlers.get(providerId);
    const interceptorPort = ports?.[0];
    if (!activated || registration?.kind !== kind || !interceptorPort?.postMessage) {
      interceptorPort?.close?.();
      throw new PluginError("failed_precondition", "Terminal interceptor provider is not registered");
    }
    runtimeApi.terminalInterceptorPorts.add(interceptorPort);
    let attached = false;
    try {
      const {
        TERMINAL_INTERCEPTOR_MAX_CHUNK_BYTES,
        createTerminalInterceptorEnvelope,
      } = await loadTerminalInterceptorTransportForRuntime();
      if (cancellationToken?.isCancellationRequested
        || deactivated
        || !activated
        || !runtimeApi.terminalInterceptorPorts.has(interceptorPort)
        || runtimeApi.providerHandlers.get(providerId) !== registration) {
        throw new PluginError("failed_precondition", "Terminal interceptor attachment was cancelled or became stale");
      }
      const handleChunk = (event) => {
        let envelope;
        try {
          const message = messageData(event);
          envelope = createTerminalInterceptorEnvelope(message?.frame, message?.transfer);
        } catch {
          interceptorPort.close?.();
          return;
        }
        const chunk = envelope.frame;
        if (chunk?.type === "netcatty:terminal-interceptor:ready") return;
        if (chunk.type !== "netcatty:terminal-interceptor:chunk"
          || chunk.direction !== direction) {
          interceptorPort.close?.();
          return;
        }
        const invocation = Object.freeze({
          providerId,
          kind,
          direction,
          sequence: chunk.sequence,
          session: freezeRuntimeJson(descriptor.session),
          data: new Uint8Array(envelope.transfer),
        });
        // Resolve the registration for every chunk so disposal/re-registration
        // cannot keep a captured stale handler alive. Starting from a resolved
        // promise also converts synchronous handler throws into the ordinary
        // failed response path instead of tearing down the utility runtime.
        void Promise.resolve().then(() => {
          const currentRegistration = runtimeApi.providerHandlers.get(providerId);
          if (currentRegistration?.kind !== kind) {
            throw new PluginError("failed_precondition", "Terminal interceptor provider is no longer registered");
          }
          return currentRegistration.handler(invocation);
        }).then(
          (result) => {
            let bytes;
            if (result instanceof Uint8Array) bytes = result;
            else if (result instanceof ArrayBuffer) bytes = new Uint8Array(result);
            else throw new PluginError("data_loss", "Terminal interceptor must return Uint8Array or ArrayBuffer");
            if (bytes.byteLength > TERMINAL_INTERCEPTOR_MAX_CHUNK_BYTES) {
              throw new PluginError("resource_exhausted", "Terminal interceptor result is too large");
            }
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            const resultEnvelope = createTerminalInterceptorEnvelope({
              type: "netcatty:terminal-interceptor:result",
              sequence: chunk.sequence,
              status: "ok",
              creditBytes: chunk.byteLength,
              byteLength: copy.byteLength,
            }, copy.buffer);
            interceptorPort.postMessage(resultEnvelope, [copy.buffer]);
          },
          () => interceptorPort.postMessage(createTerminalInterceptorEnvelope({
            type: "netcatty:terminal-interceptor:result",
            sequence: chunk.sequence,
            status: "failed",
          })),
        ).catch(() => interceptorPort.close?.());
      };
      if (typeof interceptorPort.addEventListener === "function") {
        interceptorPort.addEventListener("message", handleChunk);
      } else {
        interceptorPort.on("message", handleChunk);
      }
      interceptorPort.start?.();
      interceptorPort.on?.("close", () => runtimeApi.terminalInterceptorPorts.delete(interceptorPort));
      attached = true;
    } finally {
      if (!attached) {
        runtimeApi.terminalInterceptorPorts.delete(interceptorPort);
        interceptorPort.close?.();
      }
    }
  };

  const dispose = transport.onMessage((message, ports) => {
    if (message && typeof message === "object" && Object.hasOwn(message, "frame")) {
      for (const port of ports) port?.close?.();
      try {
        if (!runtimeApi.streams.accept(message)) cancelUnhandledStream(transport, message);
      }
      catch { transport.close(); }
      return;
    }
    if (client.accept(message)) {
      for (const port of ports) port?.close?.();
      return;
    }
    if (!message || message.jsonrpc !== "2.0") {
      for (const port of ports) port?.close?.();
      return;
    }
    if (message.method === "$/cancelRequest") {
      for (const port of ports) port?.close?.();
      cancellation.get(message.params?.cancellationId)?.cancel();
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      for (const port of ports) port?.close?.();
      try { handleNotification(message); } catch { transport.close(); }
      return;
    }
    const cancellationId = message.cancellationId;
    const source = new CancellationTokenSource();
    if (cancellationId) cancellation.set(cancellationId, source);
    void handleRequest(message, source.token, ports).then(
      (result) => transport.post({
        jsonrpc: "2.0",
        id: message.id,
        result: result === undefined ? null : result,
      }),
      (error) => {
        const rpcError = normalizeError(error);
        transport.post(makeRpcFailure(message.id, rpcError.code, rpcError.message, rpcError.data));
      },
    ).finally(() => {
      if (cancellationId) cancellation.delete(cancellationId);
      source.dispose();
    });
  });

  return {
    async dispose() {
      dispose();
      client.close();
      for (const source of cancellation.values()) source.cancel();
      runtimeApi.commandHandlers.clear();
      runtimeApi.providerHandlers.clear();
      runtimeApi.settingsChanged.clear();
      runtimeApi.environmentChanged.clear();
      runtimeApi.terminalEvents.clear();
      for (const interceptorPort of runtimeApi.terminalInterceptorPorts) interceptorPort.close?.();
      runtimeApi.terminalInterceptorPorts.clear();
      runtimeApi.streams.close();
      for (const emitter of runtimeApi.viewMessages.values()) emitter.clear();
      cancellation.clear();
      if (!deactivated) {
        await plugin.deactivate?.();
        context?.subscriptions.dispose();
      }
      transport.close();
    },
  };
}
