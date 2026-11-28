"use strict";

const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const {
  assertProviderRequest,
  assertProviderResult,
  createDefinitionValidator,
  formatValidationErrors,
} = require("./contractValidator.cjs");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");
const { invalidArgument, freezeJson } = require("./validationUtils.cjs");
const { compileRestrictedJsonSchema } = require("./restrictedJsonSchema.cjs");

let _pluginContractSchema = null;
function getPluginContractSchema() {
  if (!_pluginContractSchema) {
    _pluginContractSchema = require("./generated/plugin-contract.schema.json");
  }
  return _pluginContractSchema;
}
function getImporterLimits() {
  return getPluginContractSchema().$defs.ImporterLimits.const;
}
function getSyncLimits() {
  return getPluginContractSchema().$defs.SyncLimits.const;
}

const EXTENSION_PROVIDER_KINDS = Object.freeze(["connection", "authentication", "importer", "sync"]);
const PROVIDER_PERMISSIONS = Object.freeze({
  connection: "provider.connection",
  authentication: "provider.authentication",
  importer: "provider.importer",
  sync: "provider.sync",
});
const OPERATIONS = Object.freeze({
  connection: new Set(["validateConfiguration", "probe", "open", "resize", "signal", "reconnect", "close", "getStatus"]),
  authentication: new Set(["begin", "respond", "cancel"]),
  importer: new Set(["detect", "parse"]),
  sync: new Set(["connect", "disconnect", "getAccount", "getCapabilities", "readObject", "writeObject", "deleteObject"]),
});
const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;
const STREAM_WINDOW_BYTES = 256 * 1024;
const MAX_AUTH_CHALLENGES = 32;
const AUTHENTICATION_SECRET_LEASE_TTL_MS = 30_000;
const AUTHENTICATION_CANCEL_DEADLINE_MS = 1_000;
const SYNC_SECRET_CONFIG_KEYS = new Set(["password", "token", "secret", "apiKey", "accessToken"]);

/** Drop known secret / writeOnly field names from required[] so stripped sync configs still validate. */
function schemaWithoutSyncSecretRequirements(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (!Array.isArray(schema.required)) return schema;
  const writeOnlyNames = new Set();
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      if (child && typeof child === "object" && !Array.isArray(child) && child.writeOnly === true) {
        writeOnlyNames.add(name);
      }
    }
  }
  const required = schema.required.filter(
    (name) => !SYNC_SECRET_CONFIG_KEYS.has(name) && !writeOnlyNames.has(name),
  );
  if (required.length === schema.required.length) return schema;
  return { ...schema, required };
}

const DEFINITION_VALIDATOR_NAMES = new Set([
  "AuthenticationResult",
  "ConnectionOpenResult",
  "ConnectionProbeResult",
  "ConnectionStatusResult",
  "ConnectionControlResult",
  "ConnectionValidateResult",
  "ImporterDetectResult",
  "ImporterParseResult",
  "ImporterRecord",
  "SyncConnectResult",
  "SyncDisconnectResult",
  "SyncGetAccountResult",
  "SyncCapabilitiesResult",
  "SyncReadObjectResult",
  "SyncWriteObjectResult",
  "SyncDeleteObjectResult",
]);
const definitionValidators = new Map();
function getDefinitionValidator(name) {
  if (!DEFINITION_VALIDATOR_NAMES.has(name)) {
    throw new TypeError(`Unknown plugin definition validator: ${name}`);
  }
  let validator = definitionValidators.get(name);
  if (!validator) {
    validator = createDefinitionValidator(name);
    definitionValidators.set(name, validator);
  }
  return validator;
}

function assertBoundedJson(value, label, maxBytes = MAX_PROVIDER_JSON_BYTES) {
  try { assertPluginJsonValue(value, { maxBytes }); }
  catch (error) { throw invalidArgument(`${label} must be bounded JSON: ${error?.message ?? error}`); }
  return value;
}

function assertString(value, label, maximum = 256) {
  if (typeof value !== "string"
    || value.length < 1
    || Array.from(value).length > maximum
    || value.includes("\0")) {
    throw invalidArgument(`${label} is invalid`);
  }
  return value;
}

function buildImporterDetectPayload({ bytes, fileName, mediaType }) {
  const metadata = {
    ...(fileName ? { fileName: assertString(fileName, "Import file name", 1_024) } : {}),
    ...(mediaType ? { mediaType: assertString(mediaType, "Import media type", 256) } : {}),
    sample: { encoding: "base64", data: "" },
  };
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
  const encodedBudget = MAX_PROVIDER_JSON_BYTES - metadataBytes;
  if (encodedBudget < 4) throw invalidArgument("Importer sample metadata is too large");
  const rawBudget = Math.floor(encodedBudget / 4) * 3;
  if (rawBudget < 1) throw invalidArgument("Importer sample metadata is too large");
  const sampleBytes = bytes.byteLength > rawBudget ? bytes.subarray(0, rawBudget) : bytes;
  return {
    ...metadata,
    sample: {
      encoding: "base64",
      data: Buffer.from(sampleBytes).toString("base64"),
    },
  };
}

function assertDefinition(name, value, label = name) {
  const validator = getDefinitionValidator(name);
  if (!validator(value)) {
    throw new TypeError(`${label} violates the plugin contract: ${formatValidationErrors(validator.errors)}`);
  }
  return value;
}

function assertKind(kind) {
  if (!EXTENSION_PROVIDER_KINDS.includes(kind)) throw invalidArgument("Extension Provider kind is invalid");
  return kind;
}

function assertOperation(kind, operation) {
  const value = assertString(operation, "Extension Provider operation", 128);
  if (!OPERATIONS[kind].has(value)) throw invalidArgument(`Unsupported ${kind} Provider operation: ${value}`);
  return value;
}

function normalizeDeadlineMs(value) {
  const deadline = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 300_000) {
    throw invalidArgument("Extension Provider deadline is invalid");
  }
  return deadline;
}

function normalizeIdentity(activation) {
  const identity = activation?.identity;
  if (!identity
    || identity.pluginId !== activation.plugin.id
    || identity.pluginVersion !== activation.plugin.activeVersion
    || typeof identity.runtimeId !== "string" || !identity.runtimeId
    || (identity.runtimeKind !== "browser" && identity.runtimeKind !== "utility")
    || typeof identity.securityPrincipal !== "string" || !identity.securityPrincipal) {
    throw new PluginRpcError(RPC_ERRORS.unavailable, "Extension Provider activation identity is unavailable or stale");
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    securityPrincipal: identity.securityPrincipal,
  });
}

function runtimeContext(activation, identity, signal) {
  return Object.freeze({
    pluginId: activation.plugin.id,
    pluginVersion: activation.plugin.activeVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    manifest: activation.plugin.manifest,
    securityPrincipal: identity.securityPrincipal,
    signal,
  });
}

function identityKey(identity, streamId) {
  return `${identity.pluginId}\0${identity.pluginVersion}\0${identity.runtimeId}\0${streamId}`;
}

function waitForStreamOrRequestFailure(streamPromise, requestPromise) {
  return Promise.race([
    streamPromise,
    requestPromise.then(
      () => new Promise(() => {}),
      (error) => Promise.reject(error),
    ),
  ]);
}

function waitUntilDeadline(promise, deadlineAt, signal, message) {
  const operation = signal ? raceWithAbort(Promise.resolve(promise), signal) : Promise.resolve(promise);
  const remainingMs = Math.max(0, Math.ceil(deadlineAt - performance.now()));
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PluginRpcError(RPC_ERRORS.deadlineExceeded, message));
    }, remainingMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function validateProviderResult(rawResult, requestId) {
  try {
    assertProviderResult(rawResult);
    assertBoundedJson(rawResult, "Extension Provider result");
  } catch (error) {
    throw new PluginRpcError(RPC_ERRORS.dataLoss, `Extension Provider returned an invalid result: ${error?.message ?? error}`);
  }
  if (rawResult.requestId !== requestId) {
    throw new PluginRpcError(RPC_ERRORS.dataLoss, "Extension Provider returned a mismatched request ID");
  }
  if (rawResult.status === "failed") {
    throw new PluginRpcError(rawResult.error.code, rawResult.error.message, rawResult.error.data);
  }
  if (rawResult.status === "cancelled") {
    throw new PluginRpcError(RPC_ERRORS.cancelled, "Extension Provider request was cancelled");
  }
  return rawResult.result;
}

function assertConnectionResult(operation, value) {
  if (["resize", "signal", "reconnect", "close"].includes(operation)) {
    assertDefinition("ConnectionControlResult", value, `Connection ${operation} result`);
    if (value !== null) throw new TypeError(`Connection ${operation} result must be null`);
    assertBoundedJson(value, `Connection ${operation} result`);
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Connection ${operation} result must be an object`);
  }
  if (operation === "validateConfiguration") {
    assertDefinition("ConnectionValidateResult", value, "Connection validation result");
    if (typeof value.valid !== "boolean" || !Array.isArray(value.issues)) throw new TypeError("Connection validation result is invalid");
  } else if (operation === "probe") {
    assertDefinition("ConnectionProbeResult", value, "Connection probe result");
    if (typeof value.available !== "boolean") throw new TypeError("Connection probe result is invalid");
  } else if (operation === "open") {
    assertDefinition("ConnectionOpenResult", value, "Connection open result");
    assertString(value.connectionId, "Plugin connection ID");
    if (value.status !== "connecting" && value.status !== "connected") throw new TypeError("Connection open status is invalid");
  } else if (operation === "getStatus") {
    assertDefinition("ConnectionStatusResult", value, "Connection status result");
    if (!["connecting", "connected", "reconnecting", "closed", "error"].includes(value.status)) {
      throw new TypeError("Connection status is invalid");
    }
  }
  assertBoundedJson(value, `Connection ${operation} result`);
  return freezeJson(value);
}

function assertAuthenticationResult(value) {
  assertDefinition("AuthenticationResult", value, "Authentication result");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["challenge", "authenticated", "cancelled", "failed"].includes(value.status)) {
    throw new TypeError("Authentication Provider result is invalid");
  }
  if (value.status === "challenge") {
    const challenge = value.challenge;
    if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
      throw new TypeError("Authentication challenge is missing");
    }
    assertString(challenge.id, "Authentication challenge ID", 128);
    if (!["text", "password", "otp", "choice", "confirmation", "browser", "deviceCode"].includes(challenge.kind)) {
      throw new TypeError("Authentication challenge kind is invalid");
    }
    assertString(challenge.title, "Authentication challenge title", 512);
  }
  assertBoundedJson(value, "Authentication result");
  return freezeJson(value);
}

function assertAuthenticationResponse(challenge, response) {
  if (["text", "password", "otp"].includes(challenge.kind)) {
    if (typeof response !== "string" || response.length < 1 || Array.from(response).length > 8_192) {
      throw invalidArgument("Authentication text response is invalid or too large");
    }
    return response;
  }
  if (challenge.kind === "choice") {
    const allowed = new Set(challenge.choices.map((choice) => choice.id));
    if (challenge.multiple) {
      if (!Array.isArray(response) || response.length < 1 || response.length > 64
        || new Set(response).size !== response.length
        || response.some((choiceId) => typeof choiceId !== "string" || !allowed.has(choiceId))) {
        throw invalidArgument("Authentication choice response is invalid");
      }
      return Object.freeze([...response]);
    }
    if (typeof response !== "string" || !allowed.has(response)) {
      throw invalidArgument("Authentication choice response is invalid");
    }
    return response;
  }
  if (typeof response !== "boolean") throw invalidArgument("Authentication confirmation response is invalid");
  return response;
}

function assertImporterDetectResult(value) {
  assertDefinition("ImporterDetectResult", value, "Importer detection result");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) {
    throw new TypeError("Importer detection result is invalid");
  }
  assertBoundedJson(value, "Importer detection result");
  return freezeJson(value);
}

function normalizeImportRecord(value) {
  assertDefinition("ImporterRecord", value, "Importer record");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Importer record must be an object");
  if (value.type === "draft") {
    if (!value.draft || typeof value.draft !== "object" || Array.isArray(value.draft)
      || !["host", "identity", "key", "snippet", "group"].includes(value.draft.kind)) {
      throw new TypeError("Importer draft is invalid");
    }
  } else if (value.type === "warning" || value.type === "error") {
    assertString(value.message, "Importer diagnostic message", 2_048);
  } else if (value.type === "progress") {
    if (!Number.isSafeInteger(value.completed) || value.completed < 0) throw new TypeError("Importer progress is invalid");
    if (value.total != null && (!Number.isSafeInteger(value.total) || value.total < value.completed)) {
      throw new TypeError("Importer progress total is invalid");
    }
  } else {
    throw new TypeError("Importer record type is invalid");
  }
  assertBoundedJson(value, "Importer record", getImporterLimits().maxRecordBytes);
  return freezeJson(value);
}

function assertSyncObjectKey(value) {
  return assertString(value, "Sync object key", getSyncLimits().maxObjectKeyLength);
}

function assertSyncRevision(value, label = "Sync object revision") {
  if (value == null) return value;
  return assertString(value, label, getSyncLimits().maxRevisionLength);
}

function assertSyncResult(operation, value) {
  if (operation === "disconnect") {
    assertDefinition("SyncDisconnectResult", value, "Sync disconnect result");
    if (value !== null) throw new TypeError("Sync disconnect result must be null");
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Sync ${operation} result must be an object`);
  }
  if (operation === "connect") {
    assertDefinition("SyncConnectResult", value, "Sync connect result");
    assertString(value.account?.id, "Sync account ID", 512);
  } else if (operation === "getAccount") {
    assertDefinition("SyncGetAccountResult", value, "Sync getAccount result");
    if (value.account != null) assertString(value.account.id, "Sync account ID", 512);
  } else if (operation === "getCapabilities") {
    assertDefinition("SyncCapabilitiesResult", value, "Sync capabilities result");
    if (typeof value.revisions !== "boolean"
      || typeof value.conditionalWrites !== "boolean"
      || typeof value.atomicReplacement !== "boolean") {
      throw new TypeError("Sync capabilities result is invalid");
    }
    if (value.maxObjectBytes != null
      && (!Number.isSafeInteger(value.maxObjectBytes)
        || value.maxObjectBytes < 1
        || value.maxObjectBytes > getSyncLimits().maxObjectBytes)) {
      throw new TypeError("Sync maxObjectBytes is invalid");
    }
  } else if (operation === "readObject") {
    assertDefinition("SyncReadObjectResult", value, "Sync readObject result");
    if (value.found === true) {
      if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > getSyncLimits().maxObjectBytes) {
        throw new TypeError("Sync readObject byteLength is invalid");
      }
      if (value.streamed === true) {
        // Host streams the ciphertext separately.
      } else if (value.encoding === "base64") {
        if (typeof value.data !== "string") throw new TypeError("Sync readObject data is invalid");
        const decoded = Buffer.byteLength(value.data, "base64");
        // Use the safe inline cutoff (base64 + envelope must fit control-plane JSON).
        if (value.byteLength > getSyncLimits().inlineObjectBytes) {
          throw new TypeError("Sync readObject inline payload exceeds the inline limit");
        }
        if (decoded < value.byteLength) {
          throw new TypeError("Sync readObject data is shorter than byteLength");
        }
      } else {
        throw new TypeError("Sync readObject result encoding is invalid");
      }
      if (value.revision !== undefined) assertSyncRevision(value.revision);
    } else if (value.found !== false) {
      throw new TypeError("Sync readObject found flag is invalid");
    }
  } else if (operation === "writeObject") {
    assertDefinition("SyncWriteObjectResult", value, "Sync writeObject result");
    if (typeof value.created !== "boolean") throw new TypeError("Sync writeObject created flag is invalid");
    if (value.revision !== undefined) assertSyncRevision(value.revision);
  } else if (operation === "deleteObject") {
    assertDefinition("SyncDeleteObjectResult", value, "Sync deleteObject result");
    if (typeof value.deleted !== "boolean") throw new TypeError("Sync deleteObject deleted flag is invalid");
  } else {
    throw new TypeError(`Unsupported sync operation result: ${operation}`);
  }
  assertBoundedJson(value, `Sync ${operation} result`);
  return freezeJson(value);
}

function decodeBase64Bytes(data, expectedLength, label) {
  if (typeof data !== "string") throw invalidArgument(`${label} data is invalid`);
  let bytes;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    throw invalidArgument(`${label} data is not valid base64`);
  }
  if (bytes.byteLength !== expectedLength) {
    throw invalidArgument(`${label} byteLength does not match decoded data`);
  }
  return bytes;
}

class PluginExtensionProviderService {
  constructor(options) {
    if (!options?.contributionService || !options?.permissionEngine || !options?.runtimeSupervisor
      || !options?.rpcRegistry || !options?.leaseStore) {
      throw new TypeError("Extension Provider service requires contribution, permission, runtime, RPC, and secret lease services");
    }
    this.contributionService = options.contributionService;
    this.permissionEngine = options.permissionEngine;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.leaseStore = options.leaseStore;
    if (options.maxImportRecordBytes !== undefined) {
      const maxRecordBytes = getImporterLimits().maxRecordBytes;
      if (!Number.isSafeInteger(options.maxImportRecordBytes)
        || options.maxImportRecordBytes < 1
        || options.maxImportRecordBytes > maxRecordBytes) {
        throw new TypeError("Extension Provider importer record limit is invalid");
      }
      this._maxImportRecordBytes = options.maxImportRecordBytes;
    } else {
      this._maxImportRecordBytes = null;
    }
    this.expectations = new Map();
    this.sessions = new Map();
    this.streamRegistration = options.rpcRegistry.registerIncomingStream((stream, context) => (
      this.acceptIncomingStream(stream, context)
    ));
    this.runtimeRegistration = this.runtimeSupervisor.onDidChangeRuntime?.((event) => {
      if (["running", "starting"].includes(event.status)) return;
      for (const [sessionId, session] of this.sessions) {
        if (session.identity.runtimeId === event.runtimeId || session.identity.pluginId === event.pluginId) {
          this.closeSessionLocal(sessionId, new PluginRpcError(RPC_ERRORS.unavailable, "Plugin connection runtime stopped"));
        }
      }
    });
  }

  listProviders(options = {}) {
    const kind = assertKind(options.kind);
    return freezeJson(this.contributionService.listProviders({ kind, locale: options.locale }));
  }

  async activate(providerId, kind, signal) {
    const activationOperation = Promise.resolve(this.contributionService.activateProvider(providerId));
    const activation = signal ? await raceWithAbort(activationOperation, signal) : await activationOperation;
    if (activation.provider.kind !== kind) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Extension Provider kind changed during activation");
    }
    const identity = normalizeIdentity(activation);
    await this.permissionEngine.authorize(runtimeContext(activation, identity, signal), {
      permission: PROVIDER_PERMISSIONS[kind],
      resources: [activation.provider.id],
      reason: `Use ${activation.provider.id} as a ${kind} Provider`,
      operationId: `${kind}:${activation.provider.id}`,
    });
    return { activation, identity };
  }

  async invoke(params, options = {}) {
    const kind = assertKind(params?.kind);
    const operation = assertOperation(kind, params?.operation);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const requestId = params?.requestId ?? `provider-${randomUUID()}`;
    const request = {
      providerId: params?.providerId,
      operation,
      requestId,
      ...(params?.payload === undefined ? {} : { payload: assertBoundedJson(params.payload, "Extension Provider payload") }),
      deadlineMs,
    };
    try { assertProviderRequest(request); }
    catch (error) { throw invalidArgument(error?.message ?? "Extension Provider request is invalid"); }
    const { activation, identity } = options.activation ?? await this.activate(request.providerId, kind, options.signal);
    const configuration = request.payload?.configuration;
    if (activation.provider.configurationSchema !== undefined && configuration !== undefined) {
      try {
        const schema = kind === "sync"
          ? schemaWithoutSyncSecretRequirements(activation.provider.configurationSchema)
          : activation.provider.configurationSchema;
        compileRestrictedJsonSchema(schema)(configuration);
      } catch (error) {
        throw invalidArgument(`Provider configuration failed host schema validation: ${error?.message ?? error}`);
      }
    }
    const rawResult = await this.runtimeSupervisor.request(activation.plugin.id, "provider.invoke", {
      ...request,
      kind,
    }, {
      signal: options.signal,
      timeoutMs: deadlineMs,
      expectedIdentity: identity,
    });
    const result = validateProviderResult(rawResult, requestId);
    try {
      if (kind === "connection") return assertConnectionResult(operation, result);
      if (kind === "authentication") return assertAuthenticationResult(result);
      if (kind === "importer" && operation === "detect") return assertImporterDetectResult(result);
      if (kind === "sync") return assertSyncResult(operation, result);
      return freezeJson(assertBoundedJson(result, "Extension Provider result"));
    } catch (error) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, `Extension Provider result failed validation: ${error?.message ?? error}`);
    }
  }

  expectIncoming(identity, streamId, bind, signal, timeoutMs) {
    assertString(streamId, "Plugin stream ID", 128);
    const key = identityKey(identity, streamId);
    if (this.expectations.has(key)) throw new PluginRpcError(RPC_ERRORS.alreadyExists, "Plugin stream expectation already exists");
    let timer;
    let abortListener;
    const promise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
      };
      const expectation = {
        bind,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      };
      this.expectations.set(key, expectation);
      timer = setTimeout(() => {
        if (this.expectations.get(key) !== expectation) return;
        this.expectations.delete(key);
        expectation.reject(new PluginRpcError(RPC_ERRORS.deadlineExceeded, "Plugin output stream did not open"));
      }, timeoutMs);
      timer.unref?.();
      abortListener = () => {
        if (this.expectations.get(key) !== expectation) return;
        this.expectations.delete(key);
        expectation.reject(signal.reason ?? new PluginRpcError(RPC_ERRORS.cancelled, "Plugin stream was cancelled"));
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    return { key, promise, cancel: (error) => {
      const expectation = this.expectations.get(key);
      if (!expectation) return;
      this.expectations.delete(key);
      expectation.reject(error);
    } };
  }

  async acceptIncomingStream(stream, context) {
    const key = identityKey(context, stream.streamId);
    const expectation = this.expectations.get(key);
    if (!expectation) return false;
    this.expectations.delete(key);
    try {
      const value = await expectation.bind(stream, context);
      expectation.resolve(value);
      return true;
    } catch (error) {
      expectation.reject(error);
      throw error;
    }
  }

  async openConnection(params, options = {}) {
    const providerId = assertString(params?.providerId, "Connection Provider ID");
    const configuration = freezeJson(assertBoundedJson(
      params?.configuration === undefined ? {} : params.configuration,
      "Connection configuration",
    ));
    const columns = params?.columns;
    const rows = params?.rows;
    if (!Number.isInteger(columns) || columns < 1 || columns > 16_384
      || !Number.isInteger(rows) || rows < 1 || rows > 16_384) {
      throw invalidArgument("Plugin connection dimensions are invalid");
    }
    const activation = await this.activate(providerId, "connection", options.signal);
    const sessionId = assertString(params?.sessionId ?? `plugin-session-${randomUUID()}`, "Plugin session ID", 128);
    if (this.sessions.has(sessionId)) throw new PluginRpcError(RPC_ERRORS.alreadyExists, "Plugin session already exists");
    const sessionOwner = options.sessionOwner ?? Symbol(`plugin-connection:${sessionId}`);
    const operationId = `connection:${randomUUID()}`;
    const inputStreamId = `${operationId}:input`;
    const outputStreamId = `${operationId}:output`;
    let outputClosed = null;
    const expected = this.expectIncoming(activation.identity, outputStreamId, async (stream) => {
      stream.bind({
        onChunk: async (chunk, release) => {
          if (chunk.encoding !== "binary") throw new Error("Plugin connection output must be binary");
          await options.onData?.(chunk.bytes);
          release();
        },
        onClose: (reason) => {
          outputClosed = reason ?? "closed";
          this.closeSessionLocal(sessionId, undefined, sessionOwner);
          return options.onOutputClose?.(reason);
        },
      });
      return stream;
    }, options.signal, normalizeDeadlineMs(params?.deadlineMs));
    const request = this.invoke({
      providerId,
      kind: "connection",
      operation: "open",
      payload: {
        operationId,
        configuration,
        columns,
        rows,
        inputStreamId,
        outputStreamId,
        windowBytes: STREAM_WINDOW_BYTES,
        ...(params.credential === undefined ? {} : { credential: params.credential }),
        ...(params.authenticationProviderId === undefined ? {} : { authenticationProviderId: params.authenticationProviderId }),
      },
      deadlineMs: params?.deadlineMs,
    }, { ...options, activation });
    let output;
    let input;
    try {
      output = await waitForStreamOrRequestFailure(expected.promise, request);
      input = await this.runtimeSupervisor.openStream(activation.activation.plugin.id, inputStreamId, STREAM_WINDOW_BYTES, {
        expectedIdentity: activation.identity,
      });
      const result = await request;
      if (outputClosed != null) throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin connection output closed during startup");
      const session = Object.freeze({
        sessionId,
        providerId,
        pluginConnectionId: result.connectionId,
        activation: activation.activation,
        identity: activation.identity,
        input,
        output,
        configuration,
        sessionOwner,
      });
      this.sessions.set(sessionId, session);
      return freezeJson({ sessionId, providerId, status: result.status, diagnostics: result.diagnostics ?? [] });
    } catch (error) {
      expected.cancel(error);
      try { input?.cancel?.(); } catch {}
      try { output?.cancel?.(); } catch {}
      throw error;
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  getSession(sessionId, sessionOwner) {
    const session = this.sessions.get(assertString(sessionId, "Plugin session ID", 128));
    if (!session) throw new PluginRpcError(RPC_ERRORS.notFound, "Plugin connection session was not found");
    if (sessionOwner !== undefined && session.sessionOwner !== sessionOwner) {
      throw new PluginRpcError(RPC_ERRORS.notFound, "Plugin connection session was replaced");
    }
    return session;
  }

  async write(sessionId, data, sessionOwner) {
    const session = this.getSession(sessionId, sessionOwner);
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
    if (bytes.byteLength === 0) {
      await session.input.write(bytes);
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += STREAM_WINDOW_BYTES) {
      await session.input.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + STREAM_WINDOW_BYTES)));
    }
  }

  async control(sessionId, operation, payload = {}, options = {}) {
    const session = this.getSession(sessionId, options.sessionOwner);
    const operationId = `connection:${operation}:${randomUUID()}`;
    const isClose = operation === "close";
    if (isClose && this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
    try {
      const result = await this.invoke({
        providerId: session.providerId,
        kind: "connection",
        operation,
        payload: { ...payload, connectionId: session.pluginConnectionId, operationId },
        deadlineMs: options.deadlineMs,
      }, { ...options, activation: { activation: session.activation, identity: session.identity } });
      return result;
    } finally {
      this.leaseStore.revokeOperation(session.identity.pluginId, operationId);
      if (isClose) this.disposeSession(session);
    }
  }

  disposeSession(session, error) {
    try { session.input.cancel?.(); } catch {}
    try { session.output.cancel?.(error); } catch {}
  }

  closeSessionLocal(sessionId, error, sessionOwner) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (sessionOwner !== undefined && session.sessionOwner !== sessionOwner) return false;
    this.sessions.delete(sessionId);
    this.disposeSession(session, error);
    return true;
  }

  async authenticate(params, requestChallenge, options = {}) {
    if (typeof requestChallenge !== "function") throw invalidArgument("Authentication challenge renderer is unavailable");
    const providerId = assertString(params?.providerId, "Authentication Provider ID");
    const operationId = `authentication:${randomUUID()}`;
    const activation = await this.activate(providerId, "authentication", options.signal);
    const connectionProviderId = assertString(params?.connectionProviderId, "Connection Provider ID");
    const connectionProvider = this.contributionService.listProviders({ kind: "connection" })
      .find((entry) => entry.provider.id === connectionProviderId);
    if (!connectionProvider) throw new PluginRpcError(RPC_ERRORS.notFound, "Connection Provider was not found");
    let completed = false;
    try {
      let result = await this.invoke({
        providerId,
        kind: "authentication",
        operation: "begin",
        payload: {
          operationId,
          connectionProviderId,
          configuration: freezeJson(assertBoundedJson(
            params?.configuration === undefined ? {} : params.configuration,
            "Authentication configuration",
          )),
          ...(params.credential === undefined ? {} : { credential: params.credential }),
        },
      }, { ...options, activation });
      for (let index = 0; result.status === "challenge"; index += 1) {
        if (index >= MAX_AUTH_CHALLENGES) throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Authentication challenge limit exceeded");
        let response = assertAuthenticationResponse(
          result.challenge,
          await requestChallenge(result.challenge, { signal: options.signal }),
        );
        if (result.challenge.kind === "password" || result.challenge.kind === "otp") {
          const secretValue = response;
          response = this.leaseStore.issue({
            pluginId: activation.identity.pluginId,
            runtimeId: activation.identity.runtimeId,
            credential: Object.freeze({
              kind: "authentication-challenge",
              challengeId: result.challenge.id,
            }),
            operationId,
            purpose: `Respond to ${result.challenge.kind} challenge ${result.challenge.id}`,
            ttlMs: AUTHENTICATION_SECRET_LEASE_TTL_MS,
            signal: options.signal,
            resolveSecret: () => secretValue,
          });
        }
        result = await this.invoke({
          providerId,
          kind: "authentication",
          operation: "respond",
          payload: { operationId, challengeId: result.challenge.id, response },
        }, { ...options, activation });
      }
      if (result.status === "authenticated" && result.credential?.kind === "secret"
        && connectionProvider.pluginId !== activation.identity.pluginId) {
        throw new PluginRpcError(
          RPC_ERRORS.failedPrecondition,
          "Cross-plugin authentication must return a host-owned CredentialRef",
        );
      }
      completed = true;
      return result;
    } catch (error) {
      if (!completed) {
        const cleanupController = new AbortController();
        const cleanupTimer = setTimeout(() => {
          cleanupController.abort(new DOMException("Authentication cancellation timed out", "TimeoutError"));
        }, AUTHENTICATION_CANCEL_DEADLINE_MS);
        cleanupTimer.unref?.();
        try {
          await this.invoke({
            providerId,
            kind: "authentication",
            operation: "cancel",
            payload: { operationId },
            deadlineMs: AUTHENTICATION_CANCEL_DEADLINE_MS,
          }, { activation, signal: cleanupController.signal });
        } catch {
          // Cancellation is best-effort, but it must use a fresh signal so the
          // runtime has a bounded chance to release operation-owned resources.
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
      throw error;
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  get maxImportRecordBytes() {
    return this._maxImportRecordBytes ?? getImporterLimits().maxRecordBytes;
  }

  async detectImporter(params, options = {}) {
    const bytes = params?.sample instanceof Uint8Array ? params.sample : new Uint8Array(params?.sample ?? []);
    if (bytes.byteLength < 1 || bytes.byteLength > getImporterLimits().maxInputBytes) throw invalidArgument("Importer sample size is invalid");
    return this.invoke({
      providerId: params.providerId,
      kind: "importer",
      operation: "detect",
      payload: buildImporterDetectPayload({
        bytes,
        fileName: params.fileName,
        mediaType: params.mediaType,
      }),
      deadlineMs: params.deadlineMs,
    }, options);
  }

  async parseImporter(params, options = {}) {
    const providerId = assertString(params?.providerId, "Importer Provider ID");
    const {
      maxInputBytes: maxImportBytes,
      maxOutputBytes: maxImportOutputBytes,
      maxRecords: maxImportRecords,
    } = getImporterLimits();
    const maxImportRecordBytes = this.maxImportRecordBytes;
    const bufferedSource = params?.data === undefined
      ? null
      : params.data instanceof Uint8Array ? params.data : new Uint8Array(params.data ?? []);
    const sourceByteLength = bufferedSource?.byteLength ?? params?.sourceByteLength;
    if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 1 || sourceByteLength > maxImportBytes) {
      throw invalidArgument("Importer input size is invalid");
    }
    const source = bufferedSource ? [bufferedSource] : params?.source;
    if (!source || (typeof source[Symbol.asyncIterator] !== "function"
      && typeof source[Symbol.iterator] !== "function")) {
      throw invalidArgument("Importer input stream is unavailable");
    }
    const activation = await this.activate(providerId, "importer", options.signal);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const deadlineAt = performance.now() + deadlineMs;
    const operationId = `importer:${randomUUID()}`;
    const inputStreamId = `${operationId}:input`;
    const outputStreamId = `${operationId}:output`;
    const records = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let outputBytes = 0;
    let resolveOutputDone;
    let rejectOutputDone;
    const outputDone = new Promise((resolve, reject) => {
      resolveOutputDone = resolve;
      rejectOutputDone = reject;
    });
    void outputDone.catch(() => {});
    const assertPendingLineWithinLimit = () => {
      const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      if (Buffer.byteLength(line, "utf8") > maxImportRecordBytes) {
        throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Importer output exceeds its record limits");
      }
    };
    const consumeLines = (final = false) => {
      const lines = pending.split("\n");
      pending = final ? "" : lines.pop();
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line) continue;
        if (Buffer.byteLength(line, "utf8") > maxImportRecordBytes || records.length >= maxImportRecords) {
          throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Importer output exceeds its record limits");
        }
        const record = normalizeImportRecord(JSON.parse(line));
        records.push(record);
        if (record.type === "progress") options.onProgress?.(record);
      }
    };
    const expected = this.expectIncoming(activation.identity, outputStreamId, async (stream) => {
      stream.bind({
        onChunk: (chunk, release) => {
          try {
            if (chunk.encoding !== "binary") throw new Error("Importer output must be UTF-8 JSONL bytes");
            outputBytes += chunk.bytes.byteLength;
            if (outputBytes > maxImportOutputBytes) throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Importer output is too large");
            pending += decoder.decode(chunk.bytes, { stream: true });
            consumeLines(false);
            assertPendingLineWithinLimit();
            release();
          } catch (error) {
            rejectOutputDone(error);
            throw error;
          }
        },
        onClose: (reason) => {
          try {
            if (reason !== "end") throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer output stream did not end normally");
            pending += decoder.decode();
            if (pending) pending += "\n";
            consumeLines(true);
            resolveOutputDone();
          } catch (error) {
            rejectOutputDone(error);
          }
        },
      });
      return stream;
    }, options.signal, deadlineMs);
    const request = this.invoke({
      providerId,
      kind: "importer",
      operation: "parse",
      payload: {
        operationId,
        ...(params.fileName ? { fileName: assertString(params.fileName, "Import file name", 1_024) } : {}),
        ...(params.mediaType ? { mediaType: assertString(params.mediaType, "Import media type", 256) } : {}),
        inputStreamId,
        outputStreamId,
        windowBytes: STREAM_WINDOW_BYTES,
        ...(params.options === undefined ? {} : { options: assertBoundedJson(params.options, "Importer options") }),
      },
      deadlineMs,
    }, { ...options, activation });
    const waitForImporterIo = (promise, message) => waitUntilDeadline(
      waitForStreamOrRequestFailure(promise, request),
      deadlineAt,
      options.signal,
      message,
    );
    let output;
    let input;
    let sourceIterator;
    let sourceCompleted = false;
    try {
      sourceIterator = typeof source[Symbol.asyncIterator] === "function"
        ? source[Symbol.asyncIterator]()
        : source[Symbol.iterator]();
      output = await waitUntilDeadline(
        waitForStreamOrRequestFailure(expected.promise, request),
        deadlineAt,
        options.signal,
        "Importer output stream exceeded its deadline",
      );
      input = await waitForImporterIo(
        this.runtimeSupervisor.openStream(activation.activation.plugin.id, inputStreamId, STREAM_WINDOW_BYTES, {
          expectedIdentity: activation.identity,
        }),
        "Importer input stream exceeded its deadline",
      );
      let inputBytes = 0;
      while (true) {
        const next = await waitForImporterIo(
          Promise.resolve(sourceIterator.next()),
          "Importer input source exceeded its deadline",
        );
        if (next.done) {
          sourceCompleted = true;
          break;
        }
        const rawChunk = next.value;
        const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
        inputBytes += chunk.byteLength;
        if (chunk.byteLength < 1 || inputBytes > sourceByteLength) {
          throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer input stream changed while it was being read");
        }
        for (let offset = 0; offset < chunk.byteLength; offset += STREAM_WINDOW_BYTES) {
          await waitForImporterIo(
            input.write(chunk.subarray(offset, Math.min(chunk.byteLength, offset + STREAM_WINDOW_BYTES))),
            "Importer input stream exceeded its deadline",
          );
        }
      }
      if (inputBytes !== sourceByteLength) {
        throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer input stream ended at an unexpected size");
      }
      await waitForImporterIo(input.end(), "Importer input stream exceeded its deadline");
      const result = await waitUntilDeadline(
        request,
        deadlineAt,
        options.signal,
        "Importer Provider exceeded its deadline",
      );
      await waitUntilDeadline(
        outputDone,
        deadlineAt,
        options.signal,
        "Importer output stream exceeded its deadline",
      );
      assertDefinition("ImporterParseResult", result, "Importer completion result");
      if (!result || typeof result !== "object" || Array.isArray(result)
        || !Number.isSafeInteger(result.parsed) || result.parsed < 0
        || !Number.isSafeInteger(result.warnings) || result.warnings < 0
        || !Number.isSafeInteger(result.errors) || result.errors < 0) {
        throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer completion result is invalid");
      }
      const observed = records.reduce((counts, record) => {
        if (record.type === "draft") counts.parsed += 1;
        else if (record.type === "warning") counts.warnings += 1;
        else if (record.type === "error") counts.errors += 1;
        return counts;
      }, { parsed: 0, warnings: 0, errors: 0 });
      if (result.parsed !== observed.parsed
        || result.warnings !== observed.warnings
        || result.errors !== observed.errors) {
        throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer completion counts do not match its streamed records");
      }
      return freezeJson({ providerId, result, records });
    } catch (error) {
      expected.cancel(error);
      if (!sourceCompleted && typeof sourceIterator?.return === "function") {
        try { void Promise.resolve(sourceIterator.return()).catch(() => {}); } catch {}
      }
      try { input?.cancel?.(); } catch {}
      try { output?.cancel?.(); } catch {}
      throw error;
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  async connectSync(params, options = {}) {
    const providerId = assertString(params?.providerId, "Sync Provider ID");
    const operationId = `sync:connect:${randomUUID()}`;
    const activation = options.activation ?? await this.activate(providerId, "sync", options.signal);
    try {
      return await this.invoke({
        providerId,
        kind: "sync",
        operation: "connect",
        payload: {
          operationId,
          configuration: freezeJson(assertBoundedJson(
            params?.configuration === undefined ? {} : params.configuration,
            "Sync configuration",
          )),
          ...(params.credential === undefined ? {} : { credential: params.credential }),
        },
        deadlineMs: params?.deadlineMs,
      }, { ...options, activation });
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  async disconnectSync(params, options = {}) {
    return this.invoke({
      providerId: assertString(params?.providerId, "Sync Provider ID"),
      kind: "sync",
      operation: "disconnect",
      payload: {
        operationId: `sync:disconnect:${randomUUID()}`,
      },
      deadlineMs: params?.deadlineMs,
    }, options);
  }

  async getSyncAccount(params, options = {}) {
    return this.invoke({
      providerId: assertString(params?.providerId, "Sync Provider ID"),
      kind: "sync",
      operation: "getAccount",
      payload: {
        operationId: `sync:getAccount:${randomUUID()}`,
      },
      deadlineMs: params?.deadlineMs,
    }, options);
  }

  async getSyncCapabilities(params, options = {}) {
    return this.invoke({
      providerId: assertString(params?.providerId, "Sync Provider ID"),
      kind: "sync",
      operation: "getCapabilities",
      payload: {
        operationId: `sync:getCapabilities:${randomUUID()}`,
      },
      deadlineMs: params?.deadlineMs,
    }, options);
  }

  async readSyncObject(params, options = {}) {
    const providerId = assertString(params?.providerId, "Sync Provider ID");
    const key = assertSyncObjectKey(params?.key);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const deadlineAt = performance.now() + deadlineMs;
    const activation = options.activation ?? await this.activate(providerId, "sync", options.signal);
    const operationId = `sync:read:${randomUUID()}`;
    // Always offer an output stream so large encrypted objects can leave the
    // JSON control plane; small objects may still return inline base64.
    const outputStreamId = `${operationId}:output`;
    const chunks = [];
    let totalBytes = 0;
    let resolveOutputDone;
    let rejectOutputDone;
    let outputSettled = false;
    const outputDone = new Promise((resolve, reject) => {
      resolveOutputDone = (value) => {
        if (outputSettled) return;
        outputSettled = true;
        resolve(value);
      };
      rejectOutputDone = (error) => {
        if (outputSettled) return;
        outputSettled = true;
        reject(error);
      };
    });
    void outputDone.catch(() => {});

    let acceptedStream = null;
    const expected = this.expectIncoming(activation.identity, outputStreamId, async (stream) => {
      acceptedStream = stream;
      stream.bind({
        onChunk: (chunk, release) => {
          try {
            if (chunk.encoding !== "binary") throw new Error("Sync object stream must be binary");
            totalBytes += chunk.bytes.byteLength;
            if (totalBytes > getSyncLimits().maxObjectBytes) {
              throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Sync object exceeds its size limit");
            }
            chunks.push(Buffer.from(chunk.bytes));
            release();
          } catch (error) {
            rejectOutputDone(error);
            throw error;
          }
        },
        onClose: (reason) => {
          try {
            if (reason !== "end") {
              throw new PluginRpcError(RPC_ERRORS.dataLoss, "Sync object stream did not end normally");
            }
            resolveOutputDone(Buffer.concat(chunks));
          } catch (error) {
            rejectOutputDone(error);
          }
        },
      });
      return stream;
    }, options.signal, deadlineMs);

    const request = this.invoke({
      providerId,
      kind: "sync",
      operation: "readObject",
      payload: {
        key,
        operationId,
        outputStreamId,
        windowBytes: STREAM_WINDOW_BYTES,
      },
      deadlineMs,
    }, { ...options, activation });

    const cancelAcceptedStream = (error) => {
      try {
        if (acceptedStream && typeof acceptedStream.cancel === "function") {
          acceptedStream.cancel(error);
        }
      } catch {
        // Best-effort containment after timeout/failure.
      }
    };

    try {
      const result = await waitUntilDeadline(
        request,
        deadlineAt,
        options.signal,
        "Sync readObject exceeded its deadline",
      );
      if (result.found !== true) {
        // Swallow the cancelled expectation; inline/not-found paths intentionally
        // do not consume the pre-opened output stream.
        void expected.promise.catch(() => {});
        expected.cancel(new PluginRpcError(RPC_ERRORS.cancelled, "Sync object not found"));
        cancelAcceptedStream(new PluginRpcError(RPC_ERRORS.cancelled, "Sync object not found"));
        return Object.freeze({ found: false, key, bytes: null, revision: undefined });
      }
      if (result.streamed === true) {
        await waitUntilDeadline(
          waitForStreamOrRequestFailure(expected.promise, request),
          deadlineAt,
          options.signal,
          "Sync readObject stream exceeded its deadline",
        );
        const bytes = await waitUntilDeadline(
          outputDone,
          deadlineAt,
          options.signal,
          "Sync readObject stream exceeded its deadline",
        );
        if (bytes.byteLength !== result.byteLength) {
          throw new PluginRpcError(RPC_ERRORS.dataLoss, "Sync readObject stream size does not match byteLength");
        }
        // Bytes are mutable buffers; freeze only the metadata envelope.
        return Object.freeze({
          found: true,
          key,
          bytes: new Uint8Array(bytes),
          revision: result.revision,
          contentType: result.contentType,
        });
      }
      // Inline base64 path — cancel unused stream expectation.
      void expected.promise.catch(() => {});
      expected.cancel(new PluginRpcError(RPC_ERRORS.cancelled, "Sync object returned inline"));
      cancelAcceptedStream(new PluginRpcError(RPC_ERRORS.cancelled, "Sync object returned inline"));
      const bytes = decodeBase64Bytes(result.data, result.byteLength, "Sync readObject");
      return Object.freeze({
        found: true,
        key,
        bytes: new Uint8Array(bytes),
        revision: result.revision,
        contentType: result.contentType,
      });
    } catch (error) {
      void expected?.promise?.catch?.(() => {});
      expected?.cancel?.(error);
      cancelAcceptedStream(error);
      throw error;
    }
  }

  async writeSyncObject(params, options = {}) {
    const providerId = assertString(params?.providerId, "Sync Provider ID");
    const key = assertSyncObjectKey(params?.key);
    const rawBytes = params?.bytes instanceof Uint8Array
      ? params.bytes
      : params?.bytes == null
        ? null
        : new Uint8Array(params.bytes);
    if (!rawBytes) throw invalidArgument("Sync writeObject bytes are required");
    if (rawBytes.byteLength > getSyncLimits().maxObjectBytes) {
      throw invalidArgument("Sync writeObject payload exceeds the size limit");
    }
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const deadlineAt = performance.now() + deadlineMs;
    const activation = options.activation ?? await this.activate(providerId, "sync", options.signal);
    const operationId = `sync:write:${randomUUID()}`;
    const useStream = rawBytes.byteLength > getSyncLimits().inlineObjectBytes || params?.preferStream === true;
    const inputStreamId = useStream ? `${operationId}:input` : undefined;
    const expectedRevision = params?.expectedRevision === undefined
      ? undefined
      : params.expectedRevision === null
        ? null
        : assertSyncRevision(params.expectedRevision, "Sync expectedRevision");

    const request = this.invoke({
      providerId,
      kind: "sync",
      operation: "writeObject",
      payload: {
        key,
        operationId,
        byteLength: rawBytes.byteLength,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(useStream
          ? { inputStreamId, windowBytes: STREAM_WINDOW_BYTES }
          : {
            encoding: "base64",
            data: Buffer.from(rawBytes).toString("base64"),
          }),
      },
      deadlineMs,
    }, { ...options, activation });

    let input;
    try {
      if (useStream) {
        input = await waitUntilDeadline(
          waitForStreamOrRequestFailure(
            this.runtimeSupervisor.openStream(activation.activation.plugin.id, inputStreamId, STREAM_WINDOW_BYTES, {
              expectedIdentity: activation.identity,
            }),
            request,
          ),
          deadlineAt,
          options.signal,
          "Sync writeObject input stream exceeded its deadline",
        );
        for (let offset = 0; offset < rawBytes.byteLength; offset += STREAM_WINDOW_BYTES) {
          await waitUntilDeadline(
            input.write(rawBytes.subarray(offset, Math.min(rawBytes.byteLength, offset + STREAM_WINDOW_BYTES))),
            deadlineAt,
            options.signal,
            "Sync writeObject input stream exceeded its deadline",
          );
        }
        await waitUntilDeadline(
          input.end(),
          deadlineAt,
          options.signal,
          "Sync writeObject input stream exceeded its deadline",
        );
      }
      return await waitUntilDeadline(
        request,
        deadlineAt,
        options.signal,
        "Sync writeObject exceeded its deadline",
      );
    } catch (error) {
      try { input?.cancel?.(); } catch {}
      throw error;
    }
  }

  async deleteSyncObject(params, options = {}) {
    return this.invoke({
      providerId: assertString(params?.providerId, "Sync Provider ID"),
      kind: "sync",
      operation: "deleteObject",
      payload: {
        key: assertSyncObjectKey(params?.key),
        operationId: `sync:delete:${randomUUID()}`,
        ...(params?.expectedRevision === undefined
          ? {}
          : { expectedRevision: assertSyncRevision(params.expectedRevision, "Sync expectedRevision") }),
      },
      deadlineMs: params?.deadlineMs,
    }, options);
  }

  shutdown() {
    this.streamRegistration?.dispose();
    this.runtimeRegistration?.dispose();
    for (const sessionId of [...this.sessions.keys()]) this.closeSessionLocal(sessionId);
    const error = new PluginRpcError(RPC_ERRORS.unavailable, "Extension Provider service stopped");
    for (const expectation of this.expectations.values()) expectation.reject(error);
    this.expectations.clear();
  }
}

module.exports = {
  DEFAULT_DEADLINE_MS,
  EXTENSION_PROVIDER_KINDS,
  get INLINE_SYNC_OBJECT_BYTES() { return getSyncLimits().inlineObjectBytes; },
  get INLINE_SYNC_OBJECT_SAFE_BYTES() { return getSyncLimits().inlineObjectBytes; },
  get MAX_IMPORT_BYTES() { return getImporterLimits().maxInputBytes; },
  get MAX_IMPORT_RECORDS() { return getImporterLimits().maxRecords; },
  get MAX_SYNC_OBJECT_BYTES() { return getSyncLimits().maxObjectBytes; },
  PluginExtensionProviderService,
  STREAM_WINDOW_BYTES,
  assertSyncResult,
  normalizeImportRecord,
};
