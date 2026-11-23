import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { assertStreamFrame } from "./streamTransport.ts";

const schema = JSON.parse(
  await readFile(
    new URL("../schema/plugin-contract.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);

function validator(definition: string) {
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
}

const validManifest = {
  manifestVersion: 1,
  id: "com.example.contract-test",
  name: "contract-test",
  version: "1.2.3-beta.1",
  publisher: "example",
  engines: { netcatty: ">=1.0.0 <2.0.0", api: ">=0.1.0-internal <0.2.0" },
  features: {
    required: ["netcatty.rpc.progress"],
    optional: ["netcatty.stream.binary"],
  },
  main: { browser: "dist/browser.js" },
  permissions: {
    required: ["commands", "menus", "provider.terminal", "terminal.complete"],
    optional: ["network"],
  },
  contributes: {
    commands: [{ id: "com.example.contract-test.run", title: "Run" }],
    menus: [{ command: "com.example.contract-test.run", location: "commandPalette" }],
    providers: [{
      id: "com.example.contract-test.completion",
      label: "Completion",
      kind: "terminal.completion",
    }],
  },
};

test("plugin manifest schema accepts the internal contract", () => {
  const validate = validator("PluginManifest");
  assert.equal(validate(validManifest), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...validManifest, main: { browser: "😀".repeat(128) } }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(validate({ ...validManifest, version: "1.0.0-01" }), false);
});

test("sync provider encrypted-object payloads and results are canonical and bounded", () => {
  const connect = validator("SyncConnectPayload");
  const capabilities = validator("SyncCapabilitiesResult");
  const readResult = validator("SyncReadObjectResult");
  const writePayload = validator("SyncWriteObjectPayload");
  const writeResult = validator("SyncWriteObjectResult");
  const deleteResult = validator("SyncDeleteObjectResult");
  const disconnectResult = validator("SyncDisconnectResult");

  assert.equal(connect({
    configuration: { endpoint: "https://example.test" },
    operationId: "sync:1",
  }), true, JSON.stringify(connect.errors));
  assert.equal(connect({ configuration: {}, operationId: "" }), false);

  assert.equal(capabilities({
    revisions: true,
    conditionalWrites: true,
    atomicReplacement: false,
    maxObjectBytes: 1024,
  }), true, JSON.stringify(capabilities.errors));
  assert.equal(capabilities({
    revisions: true,
    conditionalWrites: true,
    atomicReplacement: false,
    maxObjectBytes: 0,
  }), false);

  assert.equal(readResult({ found: false }), true, JSON.stringify(readResult.errors));
  assert.equal(readResult({
    found: true,
    byteLength: 4,
    encoding: "base64",
    data: "qQECAw==",
    revision: "rev-1",
  }), true, JSON.stringify(readResult.errors));
  assert.equal(readResult({
    found: true,
    byteLength: 4,
    streamed: true,
    revision: "rev-1",
  }), true, JSON.stringify(readResult.errors));
  assert.equal(readResult({ found: true, byteLength: 4 }), false);

  assert.equal(writePayload({
    key: "netcatty-vault.json",
    operationId: "sync:write:1",
    byteLength: 4,
    encoding: "base64",
    data: "qQECAw==",
    expectedRevision: null,
  }), true, JSON.stringify(writePayload.errors));
  assert.equal(writePayload({
    key: "netcatty-vault.json",
    operationId: "sync:write:1",
    byteLength: -1,
  }), false);
  assert.equal(writeResult({ created: true, revision: "rev-2" }), true, JSON.stringify(writeResult.errors));
  assert.equal(deleteResult({ deleted: true }), true, JSON.stringify(deleteResult.errors));
  assert.equal(disconnectResult(null), true, JSON.stringify(disconnectResult.errors));
  assert.equal(disconnectResult({}), false);
});

test("connection authentication and importer provider payloads are canonical and bounded", () => {
  const connectionOpen = validator("ConnectionOpenPayload");
  const authenticationChallenge = validator("AuthenticationChallenge");
  const authenticationResult = validator("AuthenticationResult");
  const importerRecord = validator("ImporterRecord");
  assert.equal(connectionOpen({
    configuration: { endpoint: "example" },
    operationId: "connection:1",
    columns: 120,
    rows: 40,
    inputStreamId: "connection:1:input",
    outputStreamId: "connection:1:output",
    windowBytes: 262_144,
    credential: { kind: "credential", id: "credential-reference-1234" },
  }), true, JSON.stringify(connectionOpen.errors));
  assert.equal(connectionOpen({
    configuration: {},
    operationId: "connection:1",
    columns: 0,
    rows: 40,
    inputStreamId: "input",
    outputStreamId: "output",
    windowBytes: 262_144,
  }), false);
  assert.equal(authenticationChallenge({
    id: "challenge-1",
    kind: "choice",
    title: "Select account",
    choices: [{ id: "primary", label: "Primary" }],
  }), true, JSON.stringify(authenticationChallenge.errors));
  assert.equal(authenticationChallenge({
    id: "challenge-1",
    kind: "password",
    title: "Password",
    choices: [],
  }), false);
  assert.equal(authenticationResult({ status: "challenge" }), false);
  assert.equal(authenticationResult({
    status: "challenge",
    challenge: { id: "challenge-1", kind: "text", title: "Input" },
  }), true, JSON.stringify(authenticationResult.errors));
  assert.equal(authenticationResult({
    status: "authenticated",
    challenge: { id: "challenge-1", kind: "text", title: "Input" },
  }), false);
  assert.equal(authenticationResult({ status: "failed", message: "Denied" }), true);
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "host", value: { hostname: "imported.example", label: "Imported" } },
  }), true, JSON.stringify(importerRecord.errors));
  assert.equal(importerRecord({
    type: "draft",
    draft: {
      kind: "host",
      value: {
        label: "Plugin endpoint",
        protocol: "plugin:com.example.contract-test.connection",
        pluginConnection: {
          providerId: "com.example.contract-test.connection",
          configuration: { endpoint: "opaque" },
        },
      },
    },
  }), true, JSON.stringify(importerRecord.errors));
  assert.equal(importerRecord({
    type: "draft",
    draft: {
      kind: "host",
      value: {
        hostname: "imported.example",
        protocol: "ssh",
        pluginConnection: {
          providerId: "com.example.contract-test.connection",
          configuration: {},
        },
      },
    },
  }), false, "pluginConnection drafts must use a plugin host protocol");
  assert.equal(importerRecord({ type: "draft", draft: { kind: "unknown", value: {} } }), false);
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "host", value: { hostname: "imported.example", startupCommand: "rm -rf /tmp/example" } },
  }), false, "importer host drafts must reject hidden executable startup commands");
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "host", value: { hostname: "imported.example", telnetPassword: "plaintext", savePassword: true } },
  }), false, "importer host drafts must reject hidden plaintext built-in credentials");
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "identity", value: { label: "Deploy", username: "deploy", authMethod: "password", password: "secret" } },
  }), true, JSON.stringify(importerRecord.errors));
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "key", value: { label: "Key", type: "ED25519", privateKey: "private" } },
  }), true, JSON.stringify(importerRecord.errors));
  assert.equal(importerRecord({
    type: "draft",
    draft: {
      kind: "key",
      value: {
        label: "Ambiguous key",
        type: "ED25519",
        privateKey: "private",
        filePath: "/keys/id_ed25519",
      },
    },
  }), false, "importer key drafts must declare exactly one key source");
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "snippet", value: { label: "Check", command: "uptime" } },
  }), true, JSON.stringify(importerRecord.errors));
  assert.equal(importerRecord({
    type: "draft",
    draft: { kind: "group", value: { path: "Imported/Prod" } },
  }), true, JSON.stringify(importerRecord.errors));
  assert.equal(validator("ConnectionControlResult")(null), true);
  assert.equal(validator("ConnectionControlResult")({ unexpected: true }), false);
  assert.equal(validator("ConnectionStatusResult")({
    status: "error",
    message: "Handshake failed",
    diagnostics: [{ severity: "error", message: "Invalid host key" }],
  }), true);
});

test("Provider configuration schemas use only the host restricted JSON subset", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const connectionProvider = {
    ...validManifest.contributes.providers[0],
    kind: "connection",
    configurationSchema: {
      type: "object",
      properties: { endpoint: { type: "string" } },
      required: ["endpoint"],
      additionalProperties: false,
    },
  };
  const manifest = {
    ...validManifest,
    permissions: { required: ["provider.connection"], optional: [] },
    contributes: { providers: [connectionProvider] },
  };
  assert.equal(validateManifestValue(manifest).valid, true);
  const unsafe = validateManifestValue({
    ...manifest,
    contributes: {
      providers: [{
        ...connectionProvider,
        configurationSchema: {
          ...connectionProvider.configurationSchema,
          $ref: "https://attacker.invalid/schema.json",
        },
      }],
    },
  });
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.errors.join("\n"), /configurationSchema.*keyword is not allowed.*\$ref/i);
});

test("terminal interceptor fast-path frames are owned by the canonical schema", () => {
  const validate = validator("TerminalInterceptorFrame");
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:ready",
    sessionId: "session-1",
    direction: "input",
    windowBytes: 65_536,
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:chunk",
    sequence: 1,
    direction: "output",
    creditBytes: 262_144,
    byteLength: 65_536,
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:result",
    sequence: 1,
    status: "ok",
    creditBytes: 65_536,
    byteLength: 0,
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:result",
    sequence: 1,
    status: "failed",
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:chunk",
    sequence: 0,
    direction: "input",
    creditBytes: 1,
    byteLength: 1,
  }), false);
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:chunk",
    sequence: 1,
    direction: "input",
    creditBytes: 1,
    byteLength: 65_537,
  }), false);
  assert.equal(validate({
    type: "netcatty:terminal-interceptor:result",
    sequence: 1,
    status: "failed",
    byteLength: 0,
  }), false);
});

test("required resource-scoped permissions declare activation-time bounds", () => {
  const validate = validator("PluginManifest");
  const resourceScoped = [
    ["network", "https://example.com"],
    ["network.stream", "tls://example.com:443"],
    ["filesystem.read", "/tmp/plugin-read"],
    ["filesystem.write", "/tmp/plugin-write"],
    ["companion.execute", "com.example.contract-test.helper"],
  ] as const;
  assert.deepEqual(
    schema.$defs.ResourceScopedPermission.enum,
    resourceScoped.map(([permission]) => permission),
    "the resource-scoped permission catalog must track every bounded permission",
  );
  assert.deepEqual(
    schema.$defs.NonResourceScopedPermission.enum,
    schema.$defs.PluginPermission.enum.filter(
      (permission: string) => !resourceScoped.some(([scoped]) => scoped === permission),
    ),
    "the required-permission shorthand catalog must track every non-resource permission",
  );
  for (const [permission, resource] of resourceScoped) {
    assert.equal(validate({
      ...validManifest,
      permissions: { required: [permission] },
    }), false, `${permission} must not be an unbounded required declaration`);
    assert.equal(validate({
      ...validManifest,
      permissions: { required: [{ permission, resources: [resource] }] },
    }), true, JSON.stringify(validate.errors));
    assert.equal(validate({
      ...validManifest,
      permissions: { required: [{ permission, resources: ["*"] }] },
    }), false, `${permission} must not accept a wildcard activation bound`);
    assert.equal(validate({
      ...validManifest,
      permissions: { optional: [permission] },
    }), permission !== "network.stream", `${permission}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({
      ...validManifest,
      permissions: { optional: [{ permission, resources: [resource] }] },
    }), true, JSON.stringify(validate.errors));
  }
});

test("manifest header remains forward-readable before version-specific validation", () => {
  const validateHeader = validator("PluginManifestHeader");
  assert.equal(validateHeader({
    manifestVersion: 2,
    id: "com.example.future-plugin",
    version: "2.0.0",
    engines: {
      netcatty: ">=2.0.0",
      api: ">=2.0.0 <3.0.0",
      futureRuntime: ">=1.0.0",
    },
    futureContractField: { unknownToThisHost: true },
  }), true, JSON.stringify(validateHeader.errors));
});

test("generated manifest header type preserves forward fields", async () => {
  const generated = await readFile(
    new URL("./generated/plugin-contract.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    generated,
    /export type PluginManifestHeader = \([\s\S]*& Record<string, unknown>\);/,
  );
});

test("generated activation-event type preserves compile-time event prefixes", async () => {
  const generated = await readFile(
    new URL("./generated/plugin-contract.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    generated,
    /export type ActivationEvent = "onStartupFinished" \| `onCommand:\$\{ContributionId\}` \| `onView:\$\{ContributionId\}` \| `onProvider:\$\{ContributionId\}`;/,
  );
});

test("plugin manifest schema rejects unknown properties and traversal", () => {
  const validate = validator("PluginManifest");
  assert.equal(validate({ ...validManifest, unexpected: true }), false);
  assert.equal(validate({
    ...validManifest,
    contributes: { commands: [{ id: "contract.run", title: "Run" }] },
  }), false);
  for (const browser of [
    "../outside.js",
    "dist//chunk.js",
    "CON",
    "assets/PRN.txt",
    "file.",
    "folder/file ",
    "folder/file?.js",
    "😀".repeat(129),
  ]) {
    assert.equal(validate({ ...validManifest, main: { browser } }), false, browser);
  }
});

test("RPC, stream, permission, and provider schemas validate independently", () => {
  const rpc = validator("RpcRequest");
  const rpcId = validator("RpcId");
  const rpcMessage = validator("RpcMessage");
  const failure = validator("RpcFailure");
  const progress = validator("RpcProgressNotification");
  const stream = validator("StreamFrame");
  const initialize = validator("RuntimeInitializeParams");
  const initializeRequest = validator("RuntimeInitializeRequest");
  const initializeSuccess = validator("RuntimeInitializeSuccess");
  const interceptorAttachmentParams = validator("TerminalInterceptorAttachmentParams");
  const interceptorAttachmentResult = validator("TerminalInterceptorAttachmentResult");
  const interceptorAttachmentRequest = validator("TerminalInterceptorAttachmentRequest");
  const interceptorAttachmentSuccess = validator("TerminalInterceptorAttachmentSuccess");
  const permission = validator("PermissionRequest");
  const permissionDecision = validator("PermissionDecision");
  const secretRef = validator("SecretRef");
  const credentialRef = validator("CredentialRef");
  const provider = validator("ProviderRequest");
  const providerResult = validator("ProviderResult");

  assert.equal(rpc({ jsonrpc: "2.0", id: "1", method: "settings.get", deadlineMs: 1000 }), true);
  assert.equal(rpcId(Number.MAX_SAFE_INTEGER), true, JSON.stringify(rpcId.errors));
  assert.equal(rpcId(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(rpcId("9007199254740993"), true, JSON.stringify(rpcId.errors));
  assert.equal(rpcMessage({
    jsonrpc: "2.0",
    id: "init-1",
    method: "plugin.initialize",
    params: {
      netcattyVersion: "1.0.0",
      apiVersion: "0.1.0-internal",
      supportedFeatures: [],
    },
  }), true, JSON.stringify(rpcMessage.errors));
  for (const malformedReservedMessage of [
    {
      jsonrpc: "2.0",
      id: "init-1",
      method: "plugin.initialize",
      params: { unsupportedShape: true },
    },
    {
      jsonrpc: "2.0",
      method: "$/progress",
      params: { unsupportedShape: true },
    },
    {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { unsupportedShape: true },
    },
    {
      jsonrpc: "2.0",
      method: "plugin.initialize",
      params: {
        netcattyVersion: "1.0.0",
        apiVersion: "0.1.0-internal",
        supportedFeatures: [],
      },
    },
    {
      jsonrpc: "2.0",
      id: "progress-as-request",
      method: "$/progress",
      params: { token: "build", value: { kind: "end" } },
    },
  ]) {
    assert.equal(
      rpcMessage(malformedReservedMessage),
      false,
      `reserved RPC method bypassed its exact schema: ${JSON.stringify(malformedReservedMessage)}`,
    );
  }
  assert.equal(initializeSuccess({
    jsonrpc: "2.0",
    id: "init-1",
    result: {
      pluginId: "com.example.contract-test",
      pluginVersion: "1.2.3",
      apiVersion: "0.1.0-internal",
      enabledFeatures: [],
    },
  }), true, JSON.stringify(initializeSuccess.errors));
  assert.equal(initializeSuccess({
    jsonrpc: "2.0",
    id: "init-1",
    result: { unsupportedShape: true },
  }), false);
  const attachmentParams = {
    descriptor: {
      providerId: "com.example.contract-test.interceptor",
      direction: "input",
      session: {
        sessionId: "terminal-session-1",
        protocol: "ssh",
        status: "connected",
        cols: 120,
        rows: 40,
      },
    },
  };
  assert.equal(interceptorAttachmentParams(attachmentParams), true, JSON.stringify(interceptorAttachmentParams.errors));
  assert.equal(interceptorAttachmentParams({
    descriptor: { ...attachmentParams.descriptor, session: { sessionId: "terminal-session-1" } },
  }), false);
  assert.equal(interceptorAttachmentParams({
    descriptor: { ...attachmentParams.descriptor, unexpected: true },
  }), false);
  assert.equal(interceptorAttachmentResult({ accepted: true }), true, JSON.stringify(interceptorAttachmentResult.errors));
  assert.equal(interceptorAttachmentResult({ accepted: false }), false);
  assert.equal(interceptorAttachmentResult({ accepted: true, unexpected: true }), false);
  assert.equal(interceptorAttachmentRequest({
    jsonrpc: "2.0",
    id: "attach-1",
    method: "plugin.terminal.interceptor.attach",
    params: attachmentParams,
  }), true, JSON.stringify(interceptorAttachmentRequest.errors));
  assert.equal(rpcMessage({
    jsonrpc: "2.0",
    id: "attach-1",
    method: "plugin.terminal.interceptor.attach",
    params: attachmentParams,
  }), true, JSON.stringify(rpcMessage.errors));
  assert.equal(rpcMessage({
    jsonrpc: "2.0",
    id: "attach-1",
    method: "plugin.terminal.interceptor.attach",
    params: { descriptor: { providerId: "com.example.contract-test.interceptor" } },
  }), false);
  assert.equal(interceptorAttachmentSuccess({
    jsonrpc: "2.0",
    id: "attach-1",
    result: { accepted: true },
  }), true, JSON.stringify(interceptorAttachmentSuccess.errors));
  assert.equal(interceptorAttachmentSuccess({
    jsonrpc: "2.0",
    id: "attach-1",
    result: { accepted: false },
  }), false);
  assert.equal(failure({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  }), true, JSON.stringify(failure.errors));
  assert.equal(progress({
    jsonrpc: "2.0",
    method: "$/progress",
    params: { token: "build", value: { kind: "report", percentage: 50 } },
  }), true, JSON.stringify(progress.errors));
  assert.equal(progress({
    jsonrpc: "2.0",
    method: "$/progress",
    params: {
      token: "build",
      value: { kind: "report", percentage: 50, increment: 10 },
    },
  }), false);
  assert.equal(stream({ streamId: "s1", sequence: 0, kind: "open", windowBytes: 65536 }), true);
  assert.equal(stream({ streamId: "s1", sequence: 0, kind: "open", windowBytes: 1024 }), true);
  assert.equal(stream({ streamId: "s1", sequence: 0, kind: "open", windowBytes: 1023 }), false);
  assert.equal(stream({
    streamId: "s1",
    sequence: 0,
    kind: "open",
    windowBytes: 16_777_217,
  }), false);
  assert.equal(stream({ streamId: "s1", sequence: 0, kind: "open" }), false);
  assert.equal(stream({
    streamId: "s1",
    sequence: 0,
    kind: "chunk",
    data: { encoding: "base64", value: "", byteLength: 0 },
  }), false);
  assert.equal(stream({
    streamId: "s1",
    sequence: 1,
    kind: "chunk",
    data: { encoding: "transfer", byteLength: 4096 },
  }), true, JSON.stringify(stream.errors));
  assert.equal(stream({
    streamId: "s1",
    sequence: 0,
    kind: "windowUpdate",
    creditBytes: 4096,
  }), true, JSON.stringify(stream.errors));
  assert.equal(stream({
    streamId: "s1",
    sequence: 0,
    kind: "windowUpdate",
    creditBytes: 0,
  }), false);
  assert.equal(stream({
    streamId: "s1",
    sequence: 0,
    kind: "windowUpdate",
    creditBytes: 16_777_217,
  }), false);
  assert.equal(stream({
    streamId: "s1",
    sequence: 0,
    kind: "windowUpdate",
    windowBytes: 4096,
  }), false);
  assert.equal(stream({
    streamId: "s1",
    sequence: 2,
    kind: "chunk",
    data: { encoding: "base64", value: "AQID", byteLength: 3 },
  }), true, JSON.stringify(stream.errors));
  assert.equal(stream({
    streamId: "s1",
    sequence: Number.MAX_SAFE_INTEGER,
    kind: "chunk",
    data: { encoding: "base64", value: "AQID", byteLength: 3 },
  }), true, JSON.stringify(stream.errors));
  for (const frame of [
    {
      streamId: "s1",
      sequence: Number.MAX_SAFE_INTEGER + 1,
      kind: "chunk",
      data: { encoding: "base64", value: "AQID", byteLength: 3 },
    },
    { streamId: "s1", sequence: Number.MAX_SAFE_INTEGER + 1, kind: "end" },
    {
      streamId: "s1",
      sequence: Number.MAX_SAFE_INTEGER + 1,
      kind: "error",
      error: { code: -32002, message: "unsafe sequence" },
    },
    {
      streamId: "s1",
      sequence: Number.MAX_SAFE_INTEGER + 1,
      kind: "windowUpdate",
      creditBytes: 4096,
    },
  ]) {
    assert.equal(stream(frame), false, `unsafe stream sequence accepted: ${frame.kind}`);
  }
  assert.equal(initialize({
    netcattyVersion: "1.2.3",
    apiVersion: "0.1.0-internal",
    supportedFeatures: ["netcatty.rpc.progress", "netcatty.stream.binary"],
  }), true, JSON.stringify(initialize.errors));
  assert.equal(initialize({
    netcattyVersion: "1.2.3-01",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
  }), false);
  assert.equal(initializeRequest({
    jsonrpc: "2.0",
    id: "initialize-1",
    method: "plugin.initialize",
    params: {
      netcattyVersion: "1.2.3",
      apiVersion: "0.1.0-internal",
      supportedFeatures: ["netcatty.rpc.progress"],
    },
  }), true, JSON.stringify(initializeRequest.errors));
  assert.equal(permission({
    requestId: "p1",
    pluginId: "com.example.contract-test",
    pluginVersion: "1.2.3",
    pluginName: "Contract test",
    publisher: "example",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    permission: "network",
    reason: "Fetch completion metadata",
    resources: ["https://api.example.com"],
    resourceKinds: ["exact"],
    operationId: "network:https://api.example.com",
    sessionId: "terminal-session-1",
  }), true);
  assert.equal(permission({
    requestId: "p2",
    pluginId: "com.example.contract-test",
    permission: "filesystem.read",
    reason: "Read a long absolute path",
    resources: [`/${"a".repeat(4_096)}`],
    resourceKinds: ["directory"],
  }), true, JSON.stringify(permission.errors));
  assert.equal(permission({
    requestId: "p2-invalid",
    pluginId: "com.example.contract-test",
    permission: "filesystem.read",
    reason: "Reject an unknown resource kind",
    resources: ["/tmp"],
    resourceKinds: ["subtree"],
  }), false);
  assert.equal(permission({
    requestId: "p3",
    pluginId: "com.example.contract-test",
    permission: "network",
    reason: "Reject unknown runtime placement",
    runtimeKind: "renderer",
  }), false);
  assert.equal(permissionDecision({ requestId: "p1", decision: "allow", scope: "once" }), true);
  assert.equal(permissionDecision({ requestId: "p1", decision: "allow" }), false);
  assert.equal(permissionDecision({ requestId: "p1", decision: "deny", scope: "always" }), false);
  assert.equal(secretRef({ kind: "secret", id: "secret-reference-1", key: "api-key" }), true);
  assert.equal(secretRef({ kind: "secret", id: "secret-reference-1" }), false);
  assert.equal(secretRef({ kind: "secret", id: "short", key: "api-key" }), false);
  assert.equal(secretRef({
    kind: "secret",
    id: "secret-reference-1",
    key: "api-key",
    value: "plaintext",
  }), false);
  assert.equal(secretRef({ kind: "credential", id: "secret-reference-1" }), false);
  assert.equal(credentialRef({ kind: "credential", id: "credential-ref-1" }), true);
  assert.equal(credentialRef({ kind: "secret", id: "credential-ref-1", key: "api-key" }), false);
  assert.equal(provider({
    providerId: "com.example.contract-test.completion",
    operation: "provideCompletions",
    requestId: "r1",
    deadlineMs: 500,
  }), true);
  assert.equal(providerResult({ requestId: "r1", status: "ok", result: null }), true);
  assert.equal(providerResult({
    requestId: "r1",
    status: "failed",
    error: { code: -32014, message: "Unavailable" },
  }), true);
  assert.equal(providerResult({ requestId: "r1", status: "failed" }), false);
});

test("runtime stream-frame validation stays aligned with the canonical schema", () => {
  const validate = validator("StreamFrame");
  const candidates: unknown[] = [
    { streamId: "stream-1", sequence: 0, kind: "open", windowBytes: 1024 },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "chunk",
      data: { encoding: "json", value: { text: "hello" }, byteLength: 16 },
    },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "chunk",
      data: { encoding: "base64", value: "AQID", byteLength: 3 },
    },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "chunk",
      data: { encoding: "transfer", byteLength: 3 },
    },
    { streamId: "stream-1", sequence: 1, kind: "end" },
    { streamId: "stream-1", sequence: 1, kind: "cancel" },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "error",
      error: { code: -32700, message: "Parse error" },
    },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "error",
      error: { code: -32016, message: "Unauthenticated", data: null },
    },
    { streamId: "stream-1", sequence: 0, kind: "windowUpdate", creditBytes: 1 },
    { streamId: "😀".repeat(128), sequence: 1, kind: "end" },
    { streamId: "😀".repeat(129), sequence: 1, kind: "end" },
    { streamId: "stream-1", sequence: 1, kind: "bogus" },
    { streamId: "stream-1", sequence: 0, kind: "open" },
    { streamId: "stream-1", sequence: 0, kind: "open", windowBytes: 1024, extra: true },
    {
      streamId: "stream-1",
      sequence: 0,
      kind: "chunk",
      data: { encoding: "transfer", byteLength: 0 },
    },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "error",
      error: { code: -1, message: "Unknown code" },
    },
    {
      streamId: "stream-1",
      sequence: 1,
      kind: "error",
      error: { code: -32001, message: "😀".repeat(2049) },
    },
    {
      streamId: "stream-1",
      sequence: Number.MAX_SAFE_INTEGER + 1,
      kind: "windowUpdate",
      creditBytes: 1,
    },
  ];

  for (const candidate of candidates) {
    const schemaAccepts = Boolean(validate(candidate));
    let runtimeAccepts = true;
    try {
      assertStreamFrame(candidate);
    } catch {
      runtimeAccepts = false;
    }
    assert.equal(
      runtimeAccepts,
      schemaAccepts,
      `runtime/schema stream validation drifted for ${JSON.stringify(candidate)}`,
    );
  }
});

test("permission and setting-control catalogs cover planned public surfaces", () => {
  const permission = validator("PluginPermission");
  const control = validator("SettingControl");
  for (const value of [
    "clipboard.read",
    "terminal.output",
    "terminal.intercept.input",
    "vault.credentials",
    "sftp.write",
    "filesystem.write",
    "runtime.advanced",
    "provider.connection",
    "provider.sync",
  ]) {
    assert.equal(permission(value), true, value);
  }
  for (const value of ["radio", "slider", "font", "file", "directory", "list", "table"]) {
    assert.equal(control(value), true, value);
  }
  assert.equal(permission("terminal.read"), false);
  assert.equal(control("path"), false);
});

test("UI contribution shapes cover conditional menus, icons, and platform keybindings", () => {
  const icon = validator("IconReference");
  const command = validator("CommandContribution");
  const keybinding = validator("KeybindingContribution");
  const menu = validator("MenuContribution");
  const view = validator("ViewContribution");

  assert.equal(icon({ kind: "theme", name: "terminal" }), true);
  assert.equal(icon({
    kind: "package",
    light: "assets/icon-light.svg",
    dark: "assets/icon-dark.svg",
  }), true);
  assert.equal(icon({ kind: "package", light: "../icon.svg" }), false);
  assert.equal(command({
    id: "com.example.contract-test.run",
    title: "Run",
    icon: { kind: "theme", name: "play" },
    enablement: "terminal.connected && !terminal.readOnly",
  }), true, JSON.stringify(command.errors));
  assert.equal(keybinding({
    command: "com.example.contract-test.run",
    key: "ctrl+enter",
    mac: "cmd+enter",
    when: "terminal.focused",
  }), true, JSON.stringify(keybinding.errors));
  assert.equal(menu({
    command: "com.example.contract-test.run",
    alt: "com.example.contract-test.runAlternate",
    location: "terminal/context",
    title: "Run here",
    icon: { kind: "theme", name: "play" },
    when: "terminal.focused",
    enablement: "terminal.connected",
    checked: "plugin.com.example.enabled",
    showKeybinding: true,
  }), true, JSON.stringify(menu.errors));
  assert.equal(view({
    id: "com.example.contract-test.panel",
    title: "Panel",
    location: "panel",

    icon: { kind: "package", light: "assets/panel.svg" },
    order: 20,
  }), true, JSON.stringify(view.errors));
});

test("activation events use one canonical registry and declared contribution targets", async () => {
  const event = validator("ActivationEvent");
  assert.equal(event("onStartupFinished"), true);
  assert.equal(event("onCommand:com.example.contract-test.run"), true);
  assert.equal(event("onUnknown:com.example.contract-test.run"), false);

  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const result = validateManifestValue({
    ...validManifest,
    activationEvents: ["onCommand:com.example.contract-test.missing"],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /undeclared command/);
});

test("menu alternates and keybindings resolve only to declared commands", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const result = validateManifestValue({
    ...validManifest,
    permissions: {
      required: ["commands", "menus", "provider.terminal", "terminal.complete"],
    },
    contributes: {
      commands: [{ id: "com.example.contract-test.run", title: "Run" }],
      keybindings: [{
        command: "com.example.contract-test.missingKeybinding",
        key: "ctrl+enter",
      }],
      menus: [{
        command: "com.example.contract-test.run",
        alt: "com.example.contract-test.missingAlternate",
        location: "commandPalette",
      }],
      providers: validManifest.contributes.providers,
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /undeclared alternate command/);
  assert.match(result.errors.join("\n"), /Keybinding references an undeclared command/);
});

test("secret setting defaults are excluded by the semantic CLI validator", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const result = validateManifestValue({
    ...validManifest,
    contributes: {
      settings: [{
        id: "com.example.contract-test.token",
        label: "Token",
        control: "password",
        scope: "application",
        secret: true,
        default: "must-not-ship",
      }],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /must not declare a default/);
});

test("setting control semantics fail closed for secrets, sync, and structured values", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const base = {
    ...validManifest,
    permissions: { required: ["settings.read"], optional: [] },
  };
  for (const [setting, expected] of [
    [{
      id: "com.example.contract-test.password",
      label: "Password",
      control: "password",
      scope: "application",
      secret: false,
    }, /must be marked secret/],
    [{
      id: "com.example.contract-test.device",
      label: "Device",
      control: "text",
      scope: "device",
      sync: true,
    }, /must not be cloud-synced/],
    [{
      id: "com.example.contract-test.file",
      label: "File",
      control: "file",
      scope: "application",
      sync: true,
    }, /paths must not be cloud-synced/],
    [{
      id: "com.example.contract-test.table",
      label: "Table",
      control: "table",
      scope: "application",
    }, /requires valueSchema/],
    [{
      id: "com.example.contract-test.slider",
      label: "Slider",
      control: "slider",
      scope: "application",
    }, /requires minimum and maximum/],
    [{
      id: "com.example.contract-test.switch",
      label: "Switch",
      control: "switch",
      scope: "application",
      default: "yes",
    }, /default must be boolean/],
    [{
      id: "com.example.contract-test.select",
      label: "Select",
      control: "select",
      scope: "application",
      options: [{ value: "one", label: "One" }],
      default: "missing",
    }, /default uses an undeclared option/],
    [{
      id: "com.example.contract-test.range",
      label: "Range",
      control: "slider",
      scope: "application",
      minimum: 0,
      maximum: 10,
      step: 2,
      default: 3,
    }, /default does not align to step/],
    [{
      id: "com.example.contract-test.options",
      label: "Options",
      control: "multiselect",
      scope: "application",
      options: [
        { value: "same", label: "Same one" },
        { value: "same", label: "Same two" },
      ],
      default: ["same", "same"],
    }, /duplicate option value/],
    [{
      id: "com.example.contract-test.pattern",
      label: "Pattern",
      control: "text",
      scope: "application",
      pattern: "^(a+)+$",
    }, /unsafe regular-expression feature/],
    [{
      id: "com.example.contract-test.structured-pattern",
      label: "Structured pattern",
      control: "table",
      scope: "application",
      valueSchema: {
        type: "array",
        items: { type: "string", pattern: "^ok$" },
      },
    }, /valueSchema keyword is not allowed: pattern/],
    [{
      id: "com.example.contract-test.structured-default",
      label: "Structured default",
      control: "table",
      scope: "application",
      valueSchema: {
        type: "array",
        items: { type: "integer", minimum: 1 },
      },
      default: [0],
    }, /default does not match valueSchema/],
    [{
      id: "com.example.contract-test.structured-range",
      label: "Structured range",
      control: "list",
      scope: "application",
      valueSchema: {
        type: "array",
        minItems: 2,
        maxItems: 1,
        items: { type: "string" },
      },
    }, /minItems must not exceed maxItems/],
    [{
      id: "com.example.contract-test.structured-integer-range",
      label: "Structured integer range",
      control: "list",
      scope: "application",
      valueSchema: {
        type: "array",
        items: { type: "integer", minimum: 1.2, maximum: 1.8 },
      },
    }, /integer range must contain a valid integer/],
    [{
      id: "com.example.contract-test.structured-keyword-type",
      label: "Structured keyword type",
      control: "table",
      scope: "application",
      valueSchema: {
        type: "array",
        items: { type: "boolean", minLength: 1 },
      },
    }, /string keywords require type string/],
  ] as const) {
    const result = validateManifestValue({
      ...base,
      contributes: { settings: [setting] },
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), expected);
  }
});

test("semantic validation enforces owning-plugin namespaces and semver ranges", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const result = validateManifestValue({
    ...validManifest,
    engines: { netcatty: "not a range", api: ">=0.1.0-internal <0.2.0" },
    features: {
      required: ["netcatty.rpc.progress"],
      optional: ["netcatty.rpc.progress"],
    },
    contributes: {
      commands: [{ id: "com.other.plugin.run", title: "Run" }],
      menus: [{ command: "com.other.plugin.run", location: "commandPalette" }],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /owning plugin id/);
  assert.match(result.errors.join("\n"), /Invalid netcatty engine semver range/);
  assert.match(result.errors.join("\n"), /both required and optional/);
});

test("semantic namespacing covers every contribution registry and near-prefix collision", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const contributions = {
    settings: [{
      id: "com.example.contract-test.greeting",
      label: "Greeting",
      control: "text",
      scope: "application",
    }],
    commands: [{ id: "com.example.contract-test.run", title: "Run" }],
    menus: [{ command: "com.example.contract-test.run", location: "commandPalette" }],
    views: [{
      id: "com.example.contract-test.panel",
      title: "Panel",
      location: "panel",

    }],
    providers: [{
      id: "com.example.contract-test.completion",
      label: "Completion",
      kind: "terminal.completion",
    }],
  };
  const companions = [{
    id: "com.example.contract-test.helper",
    variants: [{
      path: "bin/helper",
      platforms: ["linux-x64"],
      sha256: "0".repeat(64),
    }],
  }];
  assert.equal(validateManifestValue({
    ...validManifest,
    main: { ...validManifest.main, node: "dist/node.js" },
    contributes: contributions,
    permissions: {
      required: [
        "runtime.advanced",
        "settings.read",
        "commands",
        "menus",
        "views",
        "provider.terminal",
        "terminal.complete",
        {
          permission: "companion.execute",
          resources: ["com.example.contract-test.helper"],
        },
      ],
      optional: [],
    },
    companionExecutables: companions,
  }).valid, true);

  for (const invalidManifest of [
    { ...validManifest, contributes: { ...contributions, settings: [{ ...contributions.settings[0], id: "com.example.contract-testing.greeting" }] } },
    { ...validManifest, contributes: { ...contributions, commands: [{ ...contributions.commands[0], id: "com.example.contract-testing.run" }], menus: [] } },
    { ...validManifest, contributes: { ...contributions, views: [{ ...contributions.views[0], id: "com.example.contract-testing.panel" }] } },
    { ...validManifest, contributes: { ...contributions, providers: [{ ...contributions.providers[0], id: "com.example.contract-testing.completion" }] } },
    { ...validManifest, contributes: contributions, companionExecutables: [{ ...companions[0], id: "com.example.contract-testing.helper" }] },
  ]) {
    const result = validateManifestValue(invalidManifest);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /owning plugin id/);
  }
});

test("contribution IDs are globally unique across registry kinds", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const sharedId = "com.example.contract-test.shared";
  const result = validateManifestValue({
    ...validManifest,
    permissions: {
      required: ["commands", "views", "provider.terminal", "terminal.complete"],
    },
    contributes: {
      commands: [{ id: sharedId, title: "Shared command" }],
      views: [{
        id: sharedId,
        title: "Shared view",
        location: "panel",

      }],
      providers: validManifest.contributes.providers,
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Duplicate contribution id across commands and views/);
});

test("semantic validation requires contribution capabilities to be declared", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const result = validateManifestValue({
    ...validManifest,
    permissions: { required: ["commands", "menus"], optional: [] },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /provider\.terminal/);
  assert.match(result.errors.join("\n"), /terminal\.complete/);
});

test("terminal provider kinds require their least-privilege data capabilities", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const provider = {
    id: "com.example.contract-test.inputInterceptor",
    label: "Input interceptor",
    kind: "terminal.interceptor.input",
  };
  const insufficient = validateManifestValue({
    ...validManifest,
    permissions: { required: ["provider.terminal"] },
    contributes: { providers: [provider] },
  });
  assert.equal(insufficient.valid, false);
  assert.match(insufficient.errors.join("\n"), /terminal\.intercept\.input/);
  assert.match(insufficient.errors.join("\n"), /runtime\.advanced/);
  assert.match(insufficient.errors.join("\n"), /Node utility entrypoint/);

  const sufficient = validateManifestValue({
    ...validManifest,
    main: { ...validManifest.main, node: "dist/node.js" },
    permissions: {
      required: ["runtime.advanced", "provider.terminal", "terminal.intercept.input"],
    },
    contributes: { providers: [provider] },
  });
  assert.equal(sufficient.valid, true, sufficient.errors.join("\n"));
});

test("terminal semantic providers require submitted-command input permission", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const provider = {
    id: "com.example.contract-test.semantic",
    label: "Command semantics",
    kind: "terminal.semantic",
  };
  const insufficient = validateManifestValue({
    ...validManifest,
    permissions: {
      required: ["provider.terminal", "terminal.decorate"],
    },
    contributes: { providers: [provider] },
  });
  assert.equal(insufficient.valid, false);
  assert.match(insufficient.errors.join("\n"), /terminal\.input/);

  const sufficient = validateManifestValue({
    ...validManifest,
    permissions: {
      required: ["provider.terminal", "terminal.input", "terminal.decorate"],
    },
    contributes: { providers: [provider] },
  });
  assert.equal(sufficient.valid, true, sufficient.errors.join("\n"));
});

test("planned phase consumers are representable without private application types", async () => {
  const { validateManifestValue } = await import("../../plugin-cli/src/manifest.ts");
  const manifests = [
    {
      ...validManifest,
      activationEvents: [
        "onCommand:com.example.contract-test.openPanel",
        "onView:com.example.contract-test.panel",
      ],
      permissions: {
        required: ["settings.read", "commands", "menus", "views"],
      },
      contributes: {
        settings: [{
          id: "com.example.contract-test.theme",
          label: "Theme",
          control: "select",
          scope: "application",
          options: [{ value: "system", label: "System" }],
          sync: true,
        }],
        commands: [{
          id: "com.example.contract-test.openPanel",
          title: "Open panel",
          icon: { kind: "theme", name: "layout-panel" },
        }],
        keybindings: [{
          command: "com.example.contract-test.openPanel",
          key: "ctrl+shift+p",
          mac: "cmd+shift+p",
          when: "terminal.focused",
        }],
        menus: [{
          command: "com.example.contract-test.openPanel",
          location: "terminal/toolbar",
          when: "terminal.connected",
        }],
        views: [{
          id: "com.example.contract-test.panel",
          title: "Panel",
          location: "panel",

        }],
      },
    },
    {
      ...validManifest,
      main: { ...validManifest.main, node: "dist/node.js" },
      permissions: {
        required: [
          "runtime.advanced",
          "provider.terminal",
          "terminal.complete",
          "terminal.input",
          "terminal.output",
          "terminal.decorate",
        ],
      },
      contributes: {
        providers: [
          {
            id: "com.example.contract-test.completion",
            label: "Completion",
            kind: "terminal.completion",
          },
          {
            id: "com.example.contract-test.semantic",
            label: "Semantic output",
            kind: "terminal.semantic",
          },
          {
            id: "com.example.contract-test.background",
            label: "Background",
            kind: "terminal.background",
          },
          {
            id: "com.example.contract-test.theme",
            label: "Theme",
            kind: "terminal.theme",
          },
        ],
      },
    },
    {
      ...validManifest,
      main: { ...validManifest.main, node: "dist/node.js" },
      permissions: {
        required: [
          "runtime.advanced",
          "provider.terminal",
          "terminal.intercept.input",
          "terminal.intercept.output",
        ],
      },
      contributes: {
        providers: [
          {
            id: "com.example.contract-test.inputInterceptor",
            label: "Input interceptor",
            kind: "terminal.interceptor.input",
          },
          {
            id: "com.example.contract-test.outputInterceptor",
            label: "Output interceptor",
            kind: "terminal.interceptor.output",
          },
        ],
      },
    },
    {
      ...validManifest,
      main: { ...validManifest.main, node: "dist/node.js" },
      permissions: {
        required: [
          "runtime.advanced",
          "provider.connection",
          "provider.authentication",
          "provider.sync",
          "provider.importer",
          {
            permission: "companion.execute",
            resources: ["com.example.contract-test.helper"],
          },
        ],
      },
      contributes: {
        providers: [
          {
            id: "com.example.contract-test.connection",
            label: "Connection",
            kind: "connection",
            configurationSchema: {
              type: "object",
              properties: { endpoint: { type: "string" } },
              additionalProperties: false,
            },
          },
          {
            id: "com.example.contract-test.authentication",
            label: "Authentication",
            kind: "authentication",
          },
          {
            id: "com.example.contract-test.sync",
            label: "Sync",
            kind: "sync",
          },
          {
            id: "com.example.contract-test.importer",
            label: "Importer",
            kind: "importer",
          },
        ],
      },
      companionExecutables: [{
        id: "com.example.contract-test.helper",
        variants: [
          {
            path: "bin/helper-darwin",
            platforms: ["darwin-arm64", "darwin-x64"],
            sha256: "0".repeat(64),
          },
          {
            path: "bin/helper-linux",
            platforms: ["linux-arm64", "linux-x64"],
            sha256: "1".repeat(64),
          },
          {
            path: "bin/helper.exe",
            platforms: ["win32-arm64", "win32-x64"],
            sha256: "2".repeat(64),
          },
        ],
      }],
    },
  ];

  for (const manifest of manifests) {
    const result = validateManifestValue(manifest);
    assert.equal(result.valid, true, result.errors.join("\n"));
  }
});


test("settings accept host-owned groups but reject custom rendering and settings view placement", () => {
  const validate = validator("SettingContribution");
  const setting = { id: "com.example.contract-test.name", label: "Name", group: { en: "General", "zh-CN": "常规" }, control: "text", scope: "application", default: "" };
  assert.equal(validate(setting), true, JSON.stringify(validate.errors));
  for (const field of ["html", "css", "render", "entry"]) {
    assert.equal(validate({ ...setting, [field]: "plugin controlled" }), false, field);
  }
  const view = validator("ViewContribution");
  assert.equal(view({ id: "com.example.contract-test.view", title: "Custom", location: "settings" }), false);
  for (const location of ["vault-page", "terminal-sidebar", "tab", "aside", "panel", "modal"]) {
    assert.equal(view({ id: "com.example.contract-test.view", title: "Custom", location }), true, JSON.stringify(view.errors));
  }
});
