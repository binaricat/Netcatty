"use strict";

const path = require("node:path");

const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const {
  PLUGIN_RPC_MAX_JSON_BYTES,
  PLUGIN_STREAM_MAX_FRAME_JSON_BYTES,
} = require("./constants.cjs");

let contractAjv = null;
let cachedSchema = null;
const compiledDefinitions = new Map();

function getContractSchema() {
  if (!cachedSchema) {
    cachedSchema = require("./generated/plugin-contract.schema.json");
  }
  return cachedSchema;
}

/**
 * One Ajv instance per process with the generated plugin contract registered
 * once. Loading Ajv + schema is deferred until the first validation call so
 * zero-plugin startups do not pay ~5 MiB of Ajv/schema compilation overhead.
 */
function getContractAjv() {
  if (!contractAjv) {
    const Ajv2020 = require("ajv/dist/2020").default;
    const addFormats = require("ajv-formats").default;
    contractAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(contractAjv);
    contractAjv.addSchema(getContractSchema());
  }
  return contractAjv;
}

function compileDefinition(definitionName) {
  let compiled = compiledDefinitions.get(definitionName);
  if (!compiled) {
    const schema = getContractSchema();
    if (!schema.$defs?.[definitionName]) {
      throw new Error(`Unknown plugin contract definition: ${definitionName}`);
    }
    compiled = getContractAjv().getSchema(`${schema.$id}#/$defs/${definitionName}`);
    if (typeof compiled !== "function") throw new Error(`Unable to compile plugin contract definition: ${definitionName}`);
    compiledDefinitions.set(definitionName, compiled);
  }
  return compiled;
}

/**
 * Returns a validator for one contract definition. Schema loading and
 * compilation are deferred to the first call and shared by every validator of
 * the same definition; each returned function still exposes its own `.errors`
 * from its latest call.
 */
function createDefinitionValidator(definitionName) {
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
