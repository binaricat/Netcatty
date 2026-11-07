"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const schema = require("../generated/plugin-contract.schema.json");

if (!schema.$defs.PluginAIChatResult) {
  test("assistant installed runtime requires the shared canonical AI/context contract", { skip: "Run on the parent-coordinated integration head" }, () => {});
} else {
  test("installed assistant uses canonical SDK/RPC, independent content grants, reviewed version and revocation", { timeout: 15_000 }, async (t) => {
    const { createPluginHostService } = require("../hostService.cjs");
    const { inProcessBrowserRuntime } = require("../fixtures/inProcessBrowserRuntime.cjs");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-assistant-entry-"));
    let service; let contentAllowed = false; let modelAllowed = true; let reviewed = true; let invoked = 0; let versionCurrent = true;
    const decisions = [];
    let holdDecision = false, decisionOpened, completeDecision;
    t.after(async () => { await service?.manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
    service = createPluginHostService({
      app: { getAppPath: () => path.resolve(__dirname, "../../.."), getPath: () => root, getVersion: () => "0.0.0" }, electron: {}, env: {},
      pluginAIHostAdapter: { assertActive: (context) => context.assertActive(),
        selectModel: async () => ({ label: "Synthetic fixture", isCurrent: () => true, invoke: async () => {
          invoked++; return (async function* () { yield { kind: "text", text: "Synthetic summary" }; yield { kind: "usage", inputTokens: 12, outputTokens: 6, totalTokens: 18 }; })();
        } }),
        listSelected: async () => [{ key: "synthetic-note", scope: "note", title: "Synthetic retry plan", version: "v1",
          readText: () => "Synthetic retry plan: add a retry button", isCurrent: () => versionCurrent }],
        reviewText: async () => reviewed,
      },
      requestPermissionDecision: async (request) => {
        decisions.push(request);
        if (holdDecision) {
          decisionOpened();
          return new Promise((resolve) => { completeDecision = () => resolve({ requestId: request.requestId, decision: "allow", scope: "once" }); });
        }
        if (((request.permission === "context.selected.read" || request.relatedPermissions?.some((item) => item.permission === "context.selected.read")) && !contentAllowed) || (request.permission === "ai.invoke" && !modelAllowed)) return { requestId: request.requestId, decision: "deny" };
        return { requestId: request.requestId, decision: "allow", scope: request.permission === "context.selected.read" ? "once" : "application" };
      },
    });
    service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
    await service.manager.initialize();
    const sample = path.resolve(__dirname, "../../../examples/plugins/assistant");
    // This command-only fixture excludes view assets; UI runs in the Electron suite.
    const staging = path.join(root, "package"); await fs.mkdir(path.join(staging, "dist"), { recursive: true });
    for (const file of ["netcatty.plugin.json", "README.md"]) await fs.copyFile(path.join(sample, file), path.join(staging, file));
    await fs.copyFile(path.join(sample, "src/index.js"), path.join(staging, "dist/index.js"));
    const commandManifest = JSON.parse(await fs.readFile(path.join(staging, 'netcatty.plugin.json'), 'utf8'));
    commandManifest.main.browser = 'dist/index.js';
    await fs.writeFile(path.join(staging, 'netcatty.plugin.json'), JSON.stringify(commandManifest));
    const { buildPluginPackage, validatePluginPackage } = await import("@netcatty/plugin-cli");
    const archive = path.join(root, "assistant.ncpkg"); const built = await buildPluginPackage(staging, archive);
    assert.equal(built.fileCount, 3); assert.equal((await validatePluginPackage(archive)).manifest.id, "com.netcatty.assistant");
    await service.manager.install(archive, { enable: true });
    const id = "com.netcatty.assistant";
    const run = (name, args) => service.contributionService.executeCommand(`${id}.${name}`, args);
    // Normal installed Allow flow has only host model/context selection, with
    // no permission or body-sharing ceremony at any stream stage.
    const defaultChat = await run("open"); const [defaultReference] = await run("contexts");
    const defaultTurn = await run("send", { chatHandle: defaultChat.chatHandle, prompt: "Summarize", contexts: [{ handle: defaultReference.handle, version: defaultReference.version }] });
    await run("read", { turnHandle: defaultTurn.turnHandle }); await run("read", { turnHandle: defaultTurn.turnHandle }); await run("read", { turnHandle: defaultTurn.turnHandle });
    assert.equal(decisions.length, 0); assert.equal(invoked, 1);
    invoked = 0;
    service.permissionEngine.setMode({ id, manifest: service.database.getActivePlugin(id).manifest }, "ai.invoke", "deny");
    await assert.rejects(run("open")); assert.equal(invoked, 0);
    service.permissionEngine.setMode({ id, manifest: service.database.getActivePlugin(id).manifest }, "ai.invoke", "ask");
    const chat = await run("open"); const references = await run("contexts"); assert.equal(references.length, 1);
    assert.equal(references[0].scope, "note"); assert.equal(references[0].text, undefined);
    const input = { chatHandle: chat.chatHandle, prompt: "Summarize", contexts: [{ handle: references[0].handle, version: references[0].version }] };
    service.database.setPermissionMode(id, "context.selected.read", "ask");
    await assert.rejects(run("send", input)); assert.equal(invoked, 0);
    contentAllowed = true; reviewed = false; // No separate body-sharing ceremony.
    const beforeStart = decisions.length;
    const turn = await run("send", input);
    assert.equal(decisions.length, beforeStart + 1, "one registered AI turn must not lose its content receipt in a derived context");
    assert.deepEqual(decisions.at(-1).displayContext, { modelLabel: "Synthetic fixture", selections: [{ title: "Synthetic retry plan", scope: "note", version: "v1" }] });
    const { createDefinitionValidator } = require("../contractValidator.cjs");
    assert.equal(createDefinitionValidator("PermissionRequest")(decisions.at(-1)), true);
    const auditMetadata = JSON.stringify(service.database.listSecurityAudit(id, 1000));
    assert.equal(auditMetadata.includes("Synthetic retry plan"), false);
    assert.equal(auditMetadata.includes("Synthetic fixture"), false);
    assert.deepEqual(await run("read", { turnHandle: turn.turnHandle }), { kind: "text", sequence: 0, text: "Synthetic summary" });
    assert.deepEqual(await run("read", { turnHandle: turn.turnHandle }), { kind: "usage", sequence: 1, inputTokens: 12, outputTokens: 6, totalTokens: 18 });
    assert.deepEqual(await run("read", { turnHandle: turn.turnHandle }), { kind: "end", sequence: 2 });
    await assert.rejects(run("send", { ...input, privateOwner: "spoofed" }));
    await assert.rejects(run("send", { ...input, permissionOperation: {} }));
    await assert.rejects(run("send", { ...input, displayContext: { modelLabel: "Plugin spoof" } }));
    await assert.rejects(run("send", { ...input, contexts: [null] }));
    await assert.rejects(run("read", { turnHandle: turn.turnHandle, source: "spoofed" }));
    const pending = await run("send", input);
    service.permissionEngine.revokeApplication(id, "ai.invoke", "*");
    assert.equal(service.aiContextService.broker.turns.size, 0);
    await assert.rejects(run("read", { turnHandle: pending.turnHandle }));
    assert.ok(decisions.some((decision) => decision.relatedPermissions?.some((item) => item.permission === "context.selected.read" && item.resources[0].startsWith("selected:"))));
    const owned = { id, manifest: service.database.getActivePlugin(id).manifest };
    const queuedChat = await run("open"); const [queuedReference] = await run("contexts");
    holdDecision = true;
    const promptOpened = new Promise((resolve) => { decisionOpened = resolve; });
    const beforeRevocation = invoked;
    const queued = run("send", { chatHandle: queuedChat.chatHandle, prompt: "Do not invoke", contexts: [{ handle: queuedReference.handle, version: queuedReference.version }] });
    const rejected = assert.rejects(queued, /changed|revoked|cancel/);
    await promptOpened;
    service.permissionEngine.setMode(owned, "context.selected.read", "deny");
    completeDecision(); await rejected;
    assert.equal(invoked, beforeRevocation);
    holdDecision = false;
    const deniedChat = await run("open"); const [deniedReference] = await run("contexts");
    const beforeDeny = decisions.length;
    await assert.rejects(run("send", { chatHandle: deniedChat.chatHandle, prompt: "Still denied", contexts: [{ handle: deniedReference.handle, version: deniedReference.version }] }), /disabled/);
    assert.equal(decisions.length, beforeDeny); assert.equal(invoked, beforeRevocation);
    service.permissionEngine.setMode(owned, "context.selected.read", "allow");
    const fresh = await run("open"); const [reference] = await run("contexts");
    versionCurrent = false;
    await assert.rejects(run("send", { chatHandle: fresh.chatHandle, prompt: "Hi", contexts: [{ handle: reference.handle, version: reference.version }] }));
    await service.manager.setEnabled(id, false); assert.equal(service.aiContextService.broker.chats.size, 0);
  });
}
