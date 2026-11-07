import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

import {
  CancellationError,
  CancellationTokenSource,
  definePlugin,
  DisposableStore,
  PluginError,
  PLUGIN_ERROR_WIRE_CODES,
  pluginErrorToRpcError,
  throwIfCancellationRequested,
} from "./index.ts";
import type { PluginSecretStore, SecretRef } from "./index.ts";

const testSecretRef: SecretRef = {
  kind: "secret",
  id: "secret-reference-1",
  key: "token",
};

test("byte streams and AI/context clients expose only canonical requests", () => {
  assertSdkTypeChecks(`
    import type { PluginContext } from "./index.ts";
    declare const context: PluginContext;
    async function useCapabilities() {
      const connection = await context.network.connect({ endpoint: "tls://example.test:443" });
      await connection.writable.write(new Uint8Array([1]));
      await connection.readable.read();
      await connection.close();
      const chat = await context.ai.openChat({});
      const turn = await context.ai.startTurn({ chatHandle: chat.chatHandle, prompt: "synthetic" });
      await context.ai.readTurn({ turnHandle: turn.turnHandle });
      const selected = await context.selectedContext.list({});
      await context.selectedContext.read({ handle: selected.items[0].handle, version: selected.items[0].version });
      // @ts-expect-error source identity is host-owned
      await context.network.connect({ endpoint: "tcp://example.test:22", sourceOwner: "spoofed" });
      // @ts-expect-error TLS validation cannot be disabled
      await context.network.connect({ endpoint: "tls://example.test:443", rejectUnauthorized: false });
      // @ts-expect-error model selection belongs to the host
      await context.ai.openChat({ model: "plugin-chosen" });
      // @ts-expect-error selected context requires a version
      await context.selectedContext.read({ handle: "opaque" });
    }
    void useCapabilities;
  `);
});

const testSecretStore: PluginSecretStore = {
  async get() {
    return testSecretRef;
  },
  async set() {
    return testSecretRef;
  },
  async delete() {},
};

function assertSdkTypeChecks(source: string) {
  const sdkDirectory = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(sdkDirectory, "__provider-overload-fixture.ts");
  const compilerOptions: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  const fileExists = host.fileExists.bind(host);
  const readCompilerFile = host.readFile.bind(host);
  host.fileExists = (fileName) => fileName === fixturePath || fileExists(fileName);
  host.readFile = (fileName) => fileName === fixturePath ? source : readCompilerFile(fileName);

  const program = ts.createProgram([fixturePath], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(
    diagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) {
        return `TS${diagnostic.code}: ${message}`;
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${diagnostic.file.fileName}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
    }),
    [],
  );
}

test("PluginError maps stable SDK codes to stable JSON-RPC wire errors", () => {
  const error = new PluginError("permission_denied", "Approval required", { scope: "terminal" });
  assert.deepEqual(pluginErrorToRpcError(error), {
    code: -32007,
    message: "Approval required",
    data: {
      pluginCode: "permission_denied",
      details: { scope: "terminal" },
    },
  });
  assert.equal(PLUGIN_ERROR_WIRE_CODES.cancelled, -32001);
  assert.equal(PLUGIN_ERROR_WIRE_CODES.internal, -32013);
  assert.equal(new Set(Object.values(PLUGIN_ERROR_WIRE_CODES)).size, 16);
  for (const code of Object.keys(PLUGIN_ERROR_WIRE_CODES)) {
    const mapped = pluginErrorToRpcError(new PluginError(
      code as keyof typeof PLUGIN_ERROR_WIRE_CODES,
      code,
    ));
    assert.equal(mapped.code, PLUGIN_ERROR_WIRE_CODES[code as keyof typeof PLUGIN_ERROR_WIRE_CODES]);
    assert.deepEqual(mapped.data, { pluginCode: code });
  }
});

test("PluginError wire mapping covers the exact contract schema enums", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../plugin-contract/schema/plugin-contract.schema.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    Object.keys(PLUGIN_ERROR_WIRE_CODES).sort(),
    [...schema.$defs.PluginErrorName.enum].sort(),
  );
  assert.deepEqual(
    Object.values(PLUGIN_ERROR_WIRE_CODES).sort((left, right) => left - right),
    [...schema.$defs.PluginWireErrorCode.enum].sort((left, right) => left - right),
  );
});

test("definePlugin preserves the exact plugin object", () => {
  const plugin = definePlugin({ activate() {} });
  assert.equal(typeof plugin.activate, "function");
});

test("PluginSecretStore exposes opaque references instead of plaintext reads", async () => {
  assert.deepEqual(await testSecretStore.get("token"), testSecretRef);
  assert.deepEqual(await testSecretStore.set("token", "already-known-value"), testSecretRef);
  assert.equal("value" in testSecretRef, false);
  assert.equal(testSecretRef.key, "token");
});

test("terminal interceptor typing stays specialized while broad ProviderKind helpers remain compatible", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /kind: Exclude<\s*ProviderKind,\s*TerminalInterceptorKind \| OrdinaryTerminalProviderKind \| "connection" \| "authentication" \| "importer" \| "sync"\s*>,\s*handler: PluginProviderHandler/u,
  );
  assert.match(
    source,
    /type ProviderHandlerForKind<[\s\S]*K extends TerminalInterceptorKind[\s\S]*TerminalInterceptorHandler/u,
  );
  assert.match(
    source,
    /kind: K,\s*handler: ProviderHandlerForKind<NoInfer<K>, TPayload, TResult>/u,
  );
});

test("provider registrations infer typed connection importer and sync stream invocations", () => {
  assertSdkTypeChecks(`
    import { definePlugin } from "./index.ts";
    import type {
      ConnectionProviderHandler,
      ConnectionProviderResultByOperation,
      AuthenticationResult,
      ImporterKeyDraft,
      ImporterProviderHandler,
      SyncProviderHandler,
      SyncProviderResultByOperation,
    } from "./index.ts";

    const resizeAck: ConnectionProviderResultByOperation["resize"] = null;
    void resizeAck;
    // @ts-expect-error connection control operations acknowledge with JSON null, never object payloads.
    const invalidResizeAck: ConnectionProviderResultByOperation["resize"] = { ok: true };
    void invalidResizeAck;

    const invalidConnectionProvider: ConnectionProviderHandler = {
      validateConfiguration: () => ({ valid: true, issues: [] }),
      probe: () => ({ available: true }),
      open: () => ({ connectionId: "connection-1", status: "connected" }),
      // @ts-expect-error resize must return the resize control acknowledgement, not a probe result.
      resize: () => ({ available: true }),
      signal: () => null,
      reconnect: () => null,
      close: () => null,
      getStatus: () => ({ status: "connected" }),
    };
    void invalidConnectionProvider;

    const inlineImporterKey: ImporterKeyDraft = {
      label: "Inline key",
      type: "ED25519",
      privateKey: "private",
    };
    const fileImporterKey: ImporterKeyDraft = {
      label: "File key",
      type: "ED25519",
      filePath: "/keys/id_ed25519",
    };
    void inlineImporterKey;
    void fileImporterKey;
    // @ts-expect-error runtime validation requires exactly one key source.
    const ambiguousImporterKey: ImporterKeyDraft = {
      label: "Ambiguous key",
      type: "ED25519",
      privateKey: "private",
      filePath: "/keys/id_ed25519",
    };
    void ambiguousImporterKey;

    const invalidImporterProvider: ImporterProviderHandler = {
      // @ts-expect-error detect must return a detection result, not parse counters.
      detect: () => ({ parsed: 0, warnings: 0, errors: 0 }),
      parse: () => ({ parsed: 0, warnings: 0, errors: 0 }),
    };
    void invalidImporterProvider;

    const disconnectAck: SyncProviderResultByOperation["disconnect"] = null;
    void disconnectAck;
    // @ts-expect-error disconnect acknowledges with JSON null.
    const invalidDisconnectAck: SyncProviderResultByOperation["disconnect"] = { ok: true };
    void invalidDisconnectAck;

    const invalidSyncProvider: SyncProviderHandler = {
      connect: () => ({ account: { id: "a" } }),
      disconnect: () => null,
      getAccount: () => ({ account: null }),
      getCapabilities: () => ({ revisions: true, conditionalWrites: true, atomicReplacement: true }),
      // @ts-expect-error readObject must return a SyncReadObjectResult, not write result.
      readObject: () => ({ created: true }),
      writeObject: () => ({ created: true }),
      deleteObject: () => ({ deleted: true }),
    };
    void invalidSyncProvider;

    // @ts-expect-error challenge results must include the exact challenge payload.
    const incompleteAuthenticationResult: AuthenticationResult = { status: "challenge" };
    void incompleteAuthenticationResult;

    definePlugin({
      activate(context) {
        context.providers.register("com.example.connection", "connection", {
          async open(invocation) {
            const input = await invocation.input;
            const chunk: Uint8Array | null = await input.read();
            if (chunk) {
              await invocation.output.write(chunk);
            }
            await invocation.output.end();
            return { connectionId: "connection-1", status: "connected" };
          },
          validateConfiguration(invocation) {
            const configuration = invocation.payload.configuration;
            void configuration;
            return { valid: true, issues: [] };
          },
          probe() {
            return { available: true };
          },
          resize() {
            return null;
          },
          signal() {
            return null;
          },
          reconnect() {
            return null;
          },
          close() {
            return null;
          },
          getStatus() {
            return {
              status: "connected",
              diagnostics: [{ severity: "warning", message: "using fallback host key algorithm" }],
            };
          },
        });

        // @ts-expect-error connection Providers use operation-keyed handlers so each operation has its exact result.
        context.providers.register("com.example.connection.invalid", "connection", async () => ({ available: true }));

        context.providers.register("com.example.importer", "importer", {
          async parse(invocation) {
            const input = await invocation.input;
            await invocation.output.write(new Uint8Array([65]));
            await input.read();
            return { parsed: 0, warnings: 0, errors: 0 };
          },
          detect(invocation) {
            const sampleData: string = invocation.payload.sample.data;
            void sampleData;
            return { confidence: 1 };
          },
        });

        context.providers.register("com.example.sync", "sync", {
          connect(invocation) {
            void invocation.payload.configuration;
            return { account: { id: "acct" } };
          },
          disconnect() {
            return null;
          },
          getAccount() {
            return { account: { id: "acct" } };
          },
          getCapabilities() {
            return {
              revisions: true,
              conditionalWrites: true,
              atomicReplacement: true,
              maxObjectBytes: 1024,
            };
          },
          async readObject(invocation) {
            if (invocation.output) {
              await invocation.output.write(new Uint8Array([1, 2, 3]));
              await invocation.output.end();
              return { found: true, byteLength: 3, streamed: true, revision: "r1" };
            }
            return {
              found: true,
              byteLength: 3,
              encoding: "base64",
              data: "AQID",
              revision: "r1",
            };
          },
          async writeObject(invocation) {
            if (invocation.input) {
              const stream = await invocation.input;
              await stream.read();
            }
            return { created: true, revision: "r2" };
          },
          deleteObject() {
            return { deleted: true };
          },
        });

        // @ts-expect-error sync Providers use operation-keyed handlers.
        context.providers.register("com.example.sync.invalid", "sync", async () => ({ account: { id: "x" } }));
      },
    });
  `);
});

test("DisposableStore disposes every item once", () => {
  const store = new DisposableStore();
  const calls: string[] = [];
  store.add({ dispose: () => calls.push("first") });
  store.add({ dispose: () => calls.push("second") });

  store.dispose();
  store.dispose();

  assert.deepEqual(calls, ["first", "second"]);
});

test("DisposableStore disposes rejected late additions", () => {
  const store = new DisposableStore();
  store.dispose();
  let disposed = false;

  assert.throws(
    () => store.add({ dispose: () => { disposed = true; } }),
    (error) => error instanceof PluginError && error.code === "unavailable",
  );
  assert.equal(disposed, true);
});

test("CancellationTokenSource notifies listeners once", () => {
  const source = new CancellationTokenSource();
  let count = 0;
  source.token.onCancellationRequested(() => count += 1);

  source.cancel();
  source.cancel();

  assert.equal(count, 1);
  assert.equal(source.token.isCancellationRequested, true);
  assert.throws(
    () => throwIfCancellationRequested(source.token),
    CancellationError,
  );
});

test("CancellationTokenSource notifies every listener before reporting failures", () => {
  const source = new CancellationTokenSource();
  const calls: string[] = [];
  source.token.onCancellationRequested(() => {
    calls.push("failing");
    throw new Error("listener failed");
  });
  source.token.onCancellationRequested(() => calls.push("surviving"));

  assert.throws(
    () => source.cancel(),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] instanceof Error
      && error.errors[0].message === "listener failed",
  );
  assert.deepEqual(calls, ["failing", "surviving"]);
  assert.equal(source.token.isCancellationRequested, true);
  assert.doesNotThrow(() => source.cancel());
});

test("CancellationTokenSource finishes disposal when a cancellation listener fails", () => {
  const source = new CancellationTokenSource();
  source.token.onCancellationRequested(() => {
    throw new Error("listener failed");
  });

  assert.throws(() => source.dispose(true), AggregateError);
  assert.doesNotThrow(() => source.dispose(true));
});

test("network requests expose canonical host-consumed credential leases without plaintext fields", () => {
  assertSdkTypeChecks(`
    import type { PluginNetworkRequest, PluginNetworkClient, SecretLeaseRef } from './index.ts';
    declare const network: PluginNetworkClient;
    declare const lease: SecretLeaseRef;
    const request: PluginNetworkRequest = {
      url: 'https://example.invalid', credentialLease: lease,
      authorization: { scheme: 'Basic', username: 'synthetic' },
    };
    void network.request(request);
    void network.request({ url: 'https://example.invalid' });
    // @ts-expect-error Plaintext credential handoff is not supported.
    void network.request({ url: 'https://example.invalid', authorization: { scheme: 'Bearer', password: 'secret' } });
    // @ts-expect-error Unsupported authentication schemes fail at compile time.
    void network.request({ url: 'https://example.invalid', authorization: { scheme: 'Digest' } });
  `);
});

test("host interaction SDK exposes bounded choice/input and explicit clipboard methods", () => {
  assertSdkTypeChecks(`
    import type { PluginContext } from './index.ts';
    declare const context: PluginContext;
    const choice: Promise<string | undefined> = context.ui.quickPick('Pick', [{ id: 'one', label: 'One' }]);
    const input: Promise<string | undefined> = context.ui.input('Input', 'synthetic');
    const text: Promise<string | undefined> = context.clipboard.readText('Share');
    const copied: Promise<boolean> = context.clipboard.writeText('synthetic', 'Copy');
    void [choice, input, text, copied];
    // @ts-expect-error A plugin boolean cannot grant clipboard authority.
    context.clipboard.readText('Share', { userGesture: true });
    // @ts-expect-error No ambient clipboard watcher exists.
    context.clipboard.watch(() => {});
  `);
});
