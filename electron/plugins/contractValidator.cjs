"use strict";

const path = require("node:path");

const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const schema = require("./generated/plugin-contract.schema.json");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const {
  PLUGIN_RPC_MAX_JSON_BYTES,
  PLUGIN_STREAM_MAX_FRAME_JSON_BYTES,
} = require("./constants.cjs");

let contractAjv = null;
const compiledDefinitions = new Map();

/**
 * One Ajv instance per process with the generated plugin contract registered
 * once. Compiling the 200 KB contract used to happen in a fresh Ajv for every
 * validator (~17 ms each, ~90 validators across the plugin host at startup).
 */
function getContractAjv() {
  if (!contractAjv) {
    contractAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(contractAjv);
    contractAjv.addSchema(schema);
  }
  return contractAjv;
}

function compileDefinition(definitionName) {
  let compiled = compiledDefinitions.get(definitionName);
  if (!compiled) {
    compiled = getContractAjv().getSchema(`${schema.$id}#/$defs/${definitionName}`);
    if (typeof compiled !== "function") throw new Error(`Unable to compile plugin contract definition: ${definitionName}`);
    compiledDefinitions.set(definitionName, compiled);
  }
  return compiled;
}

/**
 * Returns a validator for one contract definition. Compilation is deferred to
 * the first call and shared by every validator of the same definition; each
 * returned function still exposes its own `.errors` from its latest call.
 */
function createDefinitionValidator(definitionName) {
  if (!schema.$defs?.[definitionName]) throw new Error(`Unknown plugin contract definition: ${definitionName}`);
  let compiled = null;
  const validate = (value) => {
    compiled ??= compileDefinition(definitionName);
    const valid = compiled(value);
    validate.errors = compiled.errors ?? null;
    return valid;
  };
  validate.errors = null;
  return validate;
}

function formatValidationErrors(errors) {
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

const rpcMessageValidator = createDefinitionValidator("RpcMessage");
const initializeResultValidator = createDefinitionValidator("RuntimeInitializeResult");
const terminalInterceptorAttachmentParamsValidator = createDefinitionValidator("TerminalInterceptorAttachmentParams");
const terminalInterceptorAttachmentResultValidator = createDefinitionValidator("TerminalInterceptorAttachmentResult");
const terminalInterceptorFrameValidator = createDefinitionValidator("TerminalInterceptorFrame");
const providerRequestValidator = createDefinitionValidator("ProviderRequest");
const providerResultValidator = createDefinitionValidator("ProviderResult");
const streamFrameValidator = createDefinitionValidator("StreamFrame");

function assertContractValue(validator, value, label) {
  if (!validator(value)) {
    throw new TypeError(`${label} violates the plugin contract: ${formatValidationErrors(validator.errors)}`);
  }
  return value;
}

function assertRpcMessage(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_RPC_MAX_JSON_BYTES });
  return assertContractValue(rpcMessageValidator, value, "RPC message");
}

function assertInitializeResult(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_RPC_MAX_JSON_BYTES });
  return assertContractValue(initializeResultValidator, value, "Initialize result");
}

function assertTerminalInterceptorAttachmentParams(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_RPC_MAX_JSON_BYTES });
  return assertContractValue(
    terminalInterceptorAttachmentParamsValidator,
    value,
    "Terminal interceptor attachment params",
  );
}

function assertTerminalInterceptorAttachmentResult(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_RPC_MAX_JSON_BYTES });
  return assertContractValue(
    terminalInterceptorAttachmentResultValidator,
    value,
    "Terminal interceptor attachment result",
  );
}

function assertTerminalInterceptorFrameSchema(value) {
  return assertContractValue(
    terminalInterceptorFrameValidator,
    value,
    "Terminal interceptor frame",
  );
}

function assertProviderRequest(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_RPC_MAX_JSON_BYTES });
  return assertContractValue(providerRequestValidator, value, "Provider request");
}

function assertProviderResult(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_RPC_MAX_JSON_BYTES });
  return assertContractValue(providerResultValidator, value, "Provider result");
}

function assertStreamFrameSchema(value) {
  assertPluginJsonValue(value, { maxBytes: PLUGIN_STREAM_MAX_FRAME_JSON_BYTES });
  return assertContractValue(streamFrameValidator, value, "Stream frame");
}

function resolveContractRuntimePath(...segments) {
  return path.join(__dirname, "..", "..", "node_modules", "@netcatty", "plugin-contract", "dist", ...segments);
}

module.exports = {
  assertInitializeResult,
  assertTerminalInterceptorAttachmentParams,
  assertTerminalInterceptorAttachmentResult,
  assertTerminalInterceptorFrameSchema,
  assertProviderRequest,
  assertProviderResult,
  assertRpcMessage,
  assertStreamFrameSchema,
  createDefinitionValidator,
  formatValidationErrors,
  getContractAjv,
  resolveContractRuntimePath,
};
