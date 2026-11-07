import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(
  rootDir,
  "packages/plugin-contract/schema/plugin-contract.schema.json",
);
const generatedTypesPath = path.join(
  rootDir,
  "packages/plugin-contract/src/generated/plugin-contract.ts",
);
const generatedLimitsPath = path.join(
  rootDir,
  "packages/plugin-contract/src/generated/plugin-contract-limits.ts",
);
const electronBundlePath = path.join(
  rootDir,
  "electron/plugins/generated/plugin-contract.schema.json",
);
const checkOnly = process.argv.includes("--check");
const typescriptTypeOverrides = new Map([
  ["PermissionDeclaration", 'Exclude<PluginPermission, "network.stream"> | PermissionResourceDeclaration'],
  [
    "ActivationEvent",
    '"onStartupFinished" | `onCommand:${ContributionId}` | `onView:${ContributionId}` | `onProvider:${ContributionId}`',
  ],
  [
    "PluginHostProtocol",
    "`plugin:${ContributionId}`",
  ],
  [
    "ImporterGroupDraft",
    "string | { path: string; label?: string } | { path?: string; label: string }",
  ],
  [
    "ImporterHostDraft",
    `({
  id?: string;
  label?: string;
  username?: string;
  group?: string;
  tags?: Array<string>;
  os?: "linux" | "windows" | "macos";
  deviceType?: "general" | "network";
  identityId?: string;
  identityFileId?: string;
  telnetIdentityId?: string;
  notes?: string;
  theme?: string;
  sftpEncoding?: string;
  sftpFileProtocol?: "auto" | "sftp" | "scp";
  moshEnabled?: boolean;
  etEnabled?: boolean;
  telnetEnabled?: boolean;
  sftpSudo?: boolean;
  requiresMfa?: boolean;
  useSshAgent?: boolean;
  identitiesOnly?: boolean;
  agentForwarding?: boolean;
  x11Forwarding?: boolean;
  showLineTimestamps?: boolean;
  disableDynamicTabTitle?: boolean;
  pinned?: boolean;
  autoOpenSftpPanel?: boolean;
  sftpFollowTerminalCwd?: boolean;
  port?: number;
  telnetPort?: number;
  etPort?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
} & ({
  hostname: string;
  protocol?: "ssh" | "telnet" | "mosh" | "et" | "local" | "serial";
  pluginConnection?: never;
} | {
  hostname?: string;
  protocol: PluginHostProtocol;
  pluginConnection: ImporterPluginConnectionDraft;
}))`,
  ],
  [
    "ImporterKeyDraft",
    `({
  id?: string;
  label: string;
  type: "RSA" | "ECDSA" | "ED25519";
  publicKey?: string;
  certificate?: string;
  passphrase?: string;
  category?: "key" | "certificate" | "identity";
} & ({
  privateKey: string;
  filePath?: never;
} | {
  privateKey?: never;
  filePath: string;
}))`,
  ],
]);

const schemaText = await readFile(schemaPath, "utf8");
const schema = JSON.parse(schemaText);

if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
  throw new Error("Plugin contract must use JSON Schema 2020-12");
}
if (!schema.$id?.includes("/0.1.0-internal.1/")) {
  throw new Error("Plugin contract $id must include the internal API version");
}
if (!schema.$defs || typeof schema.$defs !== "object") {
  throw new Error("Plugin contract must define $defs");
}
const jsonValueLimits = schema.$defs.JsonValueLimits?.const;
if (!Number.isSafeInteger(jsonValueLimits?.maxDepth) || jsonValueLimits.maxDepth < 1) {
  throw new Error("JsonValueLimits.maxDepth must be a positive safe integer");
}
if (!Number.isSafeInteger(jsonValueLimits?.maxNodes) || jsonValueLimits.maxNodes < 1) {
  throw new Error("JsonValueLimits.maxNodes must be a positive safe integer");
}
const wireIntegerLimits = schema.$defs.WireIntegerLimits?.const;
if (wireIntegerLimits?.maxSafeInteger !== Number.MAX_SAFE_INTEGER) {
  throw new Error("WireIntegerLimits.maxSafeInteger must equal Number.MAX_SAFE_INTEGER");
}
const rpcLimits = schema.$defs.RpcLimits?.const;
if (!Number.isSafeInteger(rpcLimits?.maxJsonBytes) || rpcLimits.maxJsonBytes < 1) {
  throw new Error("RpcLimits.maxJsonBytes must be a positive safe integer");
}
for (const [definitionName, minimum] of [
  ["SafeUnsignedInteger", 0],
  ["SafePositiveInteger", 1],
]) {
  const definition = schema.$defs[definitionName];
  if (definition?.type !== "integer"
    || definition.minimum !== minimum
    || definition.maximum !== wireIntegerLimits.maxSafeInteger) {
    throw new Error(
      `${definitionName} must be bounded from ${minimum} through WireIntegerLimits.maxSafeInteger`,
    );
  }
}
const rpcErrorCodes = [
  ...(schema.$defs.JsonRpcStandardErrorCode?.enum ?? []),
  ...(schema.$defs.PluginWireErrorCode?.enum ?? []),
];
if (rpcErrorCodes.length === 0
  || rpcErrorCodes.some((code) => !Number.isSafeInteger(code))
  || new Set(rpcErrorCodes).size !== rpcErrorCodes.length) {
  throw new Error("RPC error code definitions must contain unique safe integers");
}
const streamLimits = schema.$defs.StreamLimits?.const;
if (!Number.isSafeInteger(streamLimits?.maxFrameJsonBytes)
  || streamLimits.maxFrameJsonBytes < streamLimits?.maxChunkBytes) {
  throw new Error("StreamLimits.maxFrameJsonBytes must cover one maximum stream chunk");
}
const terminalInterceptorLimits = schema.$defs.TerminalInterceptorLimits?.const;
if (!Number.isSafeInteger(terminalInterceptorLimits?.maxChunkBytes)
  || terminalInterceptorLimits.maxChunkBytes < 1
  || !Number.isSafeInteger(terminalInterceptorLimits?.maxWindowBytes)
  || terminalInterceptorLimits.maxWindowBytes < terminalInterceptorLimits.maxChunkBytes) {
  throw new Error("TerminalInterceptorLimits must define bounded chunk and window sizes");
}
const importerLimits = schema.$defs.ImporterLimits?.const;
if (!Number.isSafeInteger(importerLimits?.maxInputBytes)
  || !Number.isSafeInteger(importerLimits?.maxOutputBytes)
  || !Number.isSafeInteger(importerLimits?.maxRecordBytes)
  || !Number.isSafeInteger(importerLimits?.maxRecords)
  || importerLimits.maxInputBytes < 1
  || importerLimits.maxOutputBytes < 1
  || importerLimits.maxRecordBytes < 1
  || importerLimits.maxRecordBytes > importerLimits.maxOutputBytes
  || importerLimits.maxRecords < 1) {
  throw new Error("ImporterLimits must define positive bounded input, output, record, and count limits");
}
const syncLimits = schema.$defs.SyncLimits?.const;
if (!Number.isSafeInteger(syncLimits?.maxObjectBytes)
  || !Number.isSafeInteger(syncLimits?.maxObjectKeyLength)
  || !Number.isSafeInteger(syncLimits?.maxRevisionLength)
  || !Number.isSafeInteger(syncLimits?.inlineObjectBytes)
  || syncLimits.maxObjectBytes < 1
  || syncLimits.maxObjectKeyLength < 1
  || syncLimits.maxRevisionLength < 1
  || syncLimits.inlineObjectBytes < 1
  || syncLimits.inlineObjectBytes > syncLimits.maxObjectBytes) {
  throw new Error("SyncLimits must define positive bounded object, key, revision, and inline size limits");
}
for (const [name, minimum, maximum] of [
  ["TerminalInterceptorChunkByteLength", 0, terminalInterceptorLimits.maxChunkBytes],
  ["TerminalInterceptorWindowBytes", 1, terminalInterceptorLimits.maxWindowBytes],
  ["TerminalInterceptorCreditBytes", 0, terminalInterceptorLimits.maxWindowBytes],
]) {
  const definition = schema.$defs[name];
  if (definition?.type !== "integer"
    || definition.minimum !== minimum
    || definition.maximum !== maximum) {
    throw new Error(`${name} must match the canonical TerminalInterceptorLimits range`);
  }
}
const streamIdDefinition = schema.$defs.StreamId;
if (!Number.isSafeInteger(streamLimits?.maxStreamIdLength)
  || streamLimits.maxStreamIdLength < 1
  || streamIdDefinition?.type !== "string"
  || streamIdDefinition.minLength !== 1
  || streamIdDefinition.maxLength !== streamLimits.maxStreamIdLength) {
  throw new Error("StreamId must match the canonical StreamLimits.maxStreamIdLength");
}
const streamFrameBranches = schema.$defs.StreamFrame?.oneOf;
if (!Array.isArray(streamFrameBranches)
  || streamFrameBranches.length === 0
  || streamFrameBranches.some(
    (branch) => branch?.properties?.streamId?.$ref !== "#/$defs/StreamId",
  )) {
  throw new Error("Every StreamFrame branch must use the canonical StreamId definition");
}
for (const [name, minimum, maximum] of [
  ["StreamChunkByteLength", 0, streamLimits?.maxChunkBytes],
  ["StreamWindowBytes", streamLimits?.minWindowBytes, streamLimits?.maxWindowBytes],
  ["StreamCreditBytes", 1, streamLimits?.maxCreditBytes],
]) {
  if (!Number.isSafeInteger(minimum)
    || !Number.isSafeInteger(maximum)
    || minimum < 0
    || maximum < minimum) {
    throw new Error(`StreamLimits contains an invalid range for ${name}`);
  }
  const definition = schema.$defs[name];
  if (definition?.type !== "integer"
    || definition.minimum !== minimum
    || definition.maximum !== maximum) {
    throw new Error(`${name} must match the canonical StreamLimits range`);
  }
}

function quoteProperty(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value) {
  return JSON.stringify(value);
}

function referenceName(reference) {
  const prefix = "#/$defs/";
  if (typeof reference !== "string" || !reference.startsWith(prefix)) {
    throw new Error(`Unsupported schema reference: ${String(reference)}`);
  }
  return decodeURIComponent(reference.slice(prefix.length));
}

function schemaTypeToTs(node, level = 0) {
  if (node === true) return "unknown";
  if (node === false) return "never";
  if (!node || typeof node !== "object") return "unknown";
  if ("$ref" in node) return referenceName(node.$ref);
  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ") || "never";

  for (const keyword of ["oneOf", "anyOf"]) {
    if (Array.isArray(node[keyword])) {
      return node[keyword].map((entry) => `(${schemaTypeToTs(entry, level)})`).join(" | ");
    }
  }
  if (Array.isArray(node.allOf)) {
    return node.allOf.map((entry) => `(${schemaTypeToTs(entry, level)})`).join(" & ");
  }
  if (Array.isArray(node.type)) {
    return node.type.map((entry) => schemaTypeToTs({ ...node, type: entry }, level)).join(" | ");
  }

  if (node.type === "null") return "null";
  if (node.type === "string") return "string";
  if (node.type === "number" || node.type === "integer") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "array") {
    return `Array<${schemaTypeToTs(node.items ?? true, level)}>`;
  }
  if (node.type === "object" || node.properties || node.additionalProperties) {
    const properties = node.properties ?? {};
    const entries = Object.entries(properties);
    const required = new Set(node.required ?? []);
    const additional = node.additionalProperties;

    if (entries.length === 0) {
      if (additional && typeof additional === "object") {
        return `{ [key: string]: ${schemaTypeToTs(additional, level)} }`;
      }
      return additional === false ? "Record<string, never>" : "Record<string, unknown>";
    }

    const indent = "  ".repeat(level + 1);
    const closingIndent = "  ".repeat(level);
    const body = entries.map(([name, propertySchema]) => {
      const optional = required.has(name) ? "" : "?";
      return `${indent}${quoteProperty(name)}${optional}: ${schemaTypeToTs(propertySchema, level + 1)};`;
    });
    let objectType = `{\n${body.join("\n")}\n${closingIndent}}`;
    if (additional && typeof additional === "object") {
      objectType = `(${objectType} & Record<string, ${schemaTypeToTs(additional, level)}>)`;
    } else if (additional === true) {
      objectType = `(${objectType} & Record<string, unknown>)`;
    }
    return objectType;
  }
  return "unknown";
}

const hostInteractionLimits = schema.$defs.HostInteractionLimits?.const;
const byteStreamLimits = schema.$defs.ByteStreamLimits?.const;
if (!byteStreamLimits || Object.values(byteStreamLimits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
  throw new Error("ByteStreamLimits must contain positive bounded integers");
}
if (!hostInteractionLimits || Object.values(hostInteractionLimits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
  throw new Error("HostInteractionLimits must contain positive bounded integers");
}

const definitionNames = Object.keys(schema.$defs).sort((left, right) =>
  left.localeCompare(right, "en"),
);
const generatedTypes = [
  "// This file is generated from schema/plugin-contract.schema.json.",
  "// Run `npm run generate:plugin-contract` after changing the contract.",
  "// Do not edit this file directly.",
  "",
  ...definitionNames.flatMap((name) => [
    `export type ${name} = ${typescriptTypeOverrides.get(name) ?? schemaTypeToTs(schema.$defs[name])};`,
    "",
  ]),
].join("\n");
const generatedLimits = [
  "// This file is generated from schema/plugin-contract.schema.json.",
  "// Run `npm run generate:plugin-contract` after changing the contract.",
  "// Do not edit this file directly.",
  "",
  `export const PLUGIN_JSON_MAX_DEPTH = ${jsonValueLimits.maxDepth} as const;`,
  `export const PLUGIN_JSON_MAX_NODES = ${jsonValueLimits.maxNodes} as const;`,
  `export const PLUGIN_WIRE_MAX_SAFE_INTEGER = ${wireIntegerLimits.maxSafeInteger} as const;`,
  `export const PLUGIN_RPC_MAX_JSON_BYTES = ${rpcLimits.maxJsonBytes} as const;`,
  `export const PLUGIN_HOST_INTERACTION_LIMITS = ${JSON.stringify(hostInteractionLimits)} as const;`,
  `export const PLUGIN_BYTE_STREAM_LIMITS = ${JSON.stringify(byteStreamLimits)} as const;`,
  `export const PLUGIN_RPC_ERROR_CODES = ${JSON.stringify(rpcErrorCodes)} as const;`,
  `export const PLUGIN_STREAM_MAX_ID_LENGTH = ${streamLimits.maxStreamIdLength} as const;`,
  `export const PLUGIN_STREAM_MAX_CHUNK_BYTES = ${streamLimits.maxChunkBytes} as const;`,
  `export const PLUGIN_STREAM_MAX_FRAME_JSON_BYTES = ${streamLimits.maxFrameJsonBytes} as const;`,
  `export const PLUGIN_STREAM_MIN_WINDOW_BYTES = ${streamLimits.minWindowBytes} as const;`,
  `export const PLUGIN_STREAM_MAX_WINDOW_BYTES = ${streamLimits.maxWindowBytes} as const;`,
  `export const PLUGIN_STREAM_MAX_CREDIT_BYTES = ${streamLimits.maxCreditBytes} as const;`,
  `export const PLUGIN_TERMINAL_INTERCEPTOR_MAX_CHUNK_BYTES = ${terminalInterceptorLimits.maxChunkBytes} as const;`,
  `export const PLUGIN_TERMINAL_INTERCEPTOR_MAX_WINDOW_BYTES = ${terminalInterceptorLimits.maxWindowBytes} as const;`,
  `export const PLUGIN_IMPORTER_MAX_INPUT_BYTES = ${importerLimits.maxInputBytes} as const;`,
  `export const PLUGIN_IMPORTER_MAX_OUTPUT_BYTES = ${importerLimits.maxOutputBytes} as const;`,
  `export const PLUGIN_IMPORTER_MAX_RECORD_BYTES = ${importerLimits.maxRecordBytes} as const;`,
  `export const PLUGIN_IMPORTER_MAX_RECORDS = ${importerLimits.maxRecords} as const;`,
  `export const PLUGIN_SYNC_MAX_OBJECT_BYTES = ${syncLimits.maxObjectBytes} as const;`,
  `export const PLUGIN_SYNC_MAX_OBJECT_KEY_LENGTH = ${syncLimits.maxObjectKeyLength} as const;`,
  `export const PLUGIN_SYNC_MAX_REVISION_LENGTH = ${syncLimits.maxRevisionLength} as const;`,
  `export const PLUGIN_SYNC_INLINE_OBJECT_BYTES = ${syncLimits.inlineObjectBytes} as const;`,
  "",
].join("\n");
const normalizedSchema = `${JSON.stringify(schema, null, 2)}\n`;

async function assertCurrent(filePath, expected, label) {
  let actual;
  try {
    actual = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`${label} is missing. Run npm run generate:plugin-contract.`);
  }
  if (actual !== expected) {
    throw new Error(`${label} is out of date. Run npm run generate:plugin-contract.`);
  }
}

if (checkOnly) {
  await assertCurrent(generatedTypesPath, generatedTypes, "Generated plugin TypeScript contract");
  await assertCurrent(generatedLimitsPath, generatedLimits, "Generated plugin JSON limits");
  await assertCurrent(electronBundlePath, normalizedSchema, "Electron plugin schema bundle");
  console.log("Plugin contract generated artifacts are current.");
} else {
  await mkdir(path.dirname(generatedTypesPath), { recursive: true });
  await mkdir(path.dirname(electronBundlePath), { recursive: true });
  await Promise.all([
    writeFile(generatedTypesPath, generatedTypes, "utf8"),
    writeFile(generatedLimitsPath, generatedLimits, "utf8"),
    writeFile(electronBundlePath, normalizedSchema, "utf8"),
  ]);
  console.log("Generated plugin TypeScript contract and Electron schema bundle.");
}
