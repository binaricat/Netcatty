"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createPluginHostService } = require("./hostService.cjs");
const { inProcessBrowserRuntime } = require("./fixtures/inProcessBrowserRuntime.cjs");
const { createTerminalWorkerManager } = require("../bridges/terminalWorkerManager.cjs");
const { createTerminalWorkerRuntime } = require("../terminalWorker/runtime.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'netcatty-terminal-entry-'));
  const writes = [], prompts = [], decisions = [], responses = [];
  let service, mode = 'share', selection = 'synthetic owned selection\nsecond line', allow = true, nextSession = 'terminal-a';
  let listen;
  const child = Object.assign(new EventEmitter(), {
    postMessage(message) { queueMicrotask(() => listen?.(message)); }, kill() {},
  });
  const runtime = createTerminalWorkerRuntime({
    parentPort: { on(_event, fn) { listen = fn; }, postMessage(message) { queueMicrotask(() => child.emit('message', message)); } },
    registerBridges(ipc) {
      ipc.handle('netcatty:local:start', () => ({ sessionId: nextSession }));
      ipc.handle('netcatty:local:reconnect', (_event, payload) => ({ sessionId: payload.sessionId }));
      ipc.on('netcatty:write', (_event, payload) => writes.push(payload));
      ipc.on('netcatty:close', () => {});
    },
  });
  runtime.start();
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send(_channel, prompt) {
    prompts.push(prompt);
    if (prompt.closed) return;
    sender.emit('prompt', prompt);
    if (mode === 'pending') return;
    queueMicrotask(() => {
      const action = mode === 'cancel' ? 'cancel' : prompt.request.kind === 'terminal.selection.read' && prompt.phase === 'request' ? 'preview' : 'submit';
      responses.push(service.interactionService.respond(sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action,
        ...(action === 'preview' ? { value: selection } : {}),
      }).catch(async () => {
        await service.interactionService.respond(sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action: 'cancel' }).catch(() => false);
        return false;
      }));
    });
  } });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const manager = createTerminalWorkerManager({ utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
  });
  service = createPluginHostService({ app: { getAppPath: () => process.cwd(), getPath: () => root, getVersion: () => '0.0.0' }, electron: {}, env: {},
    getInteractionWindow: () => window, isAppLocked: () => false, getTerminalWorkerManager: () => manager,
    requestPermissionDecision: async (request) => {
      decisions.push(request);
      return { requestId: request.requestId, decision: allow ? 'allow' : 'deny', ...(allow ? { scope: request.allowedScopes?.includes('once') ? 'once' : 'application' } : {}) };
    },
  });
  service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
  await service.manager.initialize();
  service.interactionService.setReady(sender, true);
  await manager.request('netcatty:local:start', {}, { webContentsId: 7 });
  const select = (sessionId = 'terminal-a', rendererId = 'renderer-a') => service.interactionService.setTerminalTarget(sender, { sessionId, rendererId, label: `Synthetic ${sessionId}` });
  select();
  t.after(async () => {
    await service.manager.shutdown();
    manager.stop();
    runtime.closeUrgentInputPortsForTest();
    await fs.rm(root, { recursive: true, force: true });
  });
  const install = async (source, manifest) => {
    const sourceRoot = path.join(root, 'source');
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'browser.js'), source);
    await fs.writeFile(path.join(sourceRoot, 'netcatty.plugin.json'), JSON.stringify(manifest));
    const { buildPluginPackage } = await import('@netcatty/plugin-cli');
    const archive = path.join(root, 'fixture.ncpkg');
    await buildPluginPackage(sourceRoot, archive);
    await service.manager.install(archive, { enable: true });
    service.database.setPermissionMode(manifest.id, "terminal.selection.read", "ask");
    service.database.setPermissionMode(manifest.id, "terminal.input.propose", "ask");
  };
  return { root, service, sender, window, manager, runtime, select, install, writes, prompts, decisions, responses,
    mode(value) { mode = value; }, selection(value) { selection = value; }, allow(value) { allow = value; service.permissionEngine.setMode({ id, manifest }, "terminal.selection.read", value ? "ask" : "deny"); },
    async startB() { nextSession = 'terminal-b'; await manager.request('netcatty:local:start', {}, { webContentsId: 7 }); select('terminal-b', 'renderer-b'); },
  };
}

const id = 'com.netcatty.terminal-entry-test';
const names = ['share', 'draftFirst', 'draftLast', 'spoof'];
const manifest = { manifestVersion: 1, id, name: 'terminal-entry-test', version: '0.1.0', publisher: 'netcatty',
  engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal.1 <0.2.0' }, main: { browser: 'browser.js' },
  features: { required: ['terminal.selection-sharing', 'terminal.input-drafts', 'commands.interactive'] },
  activationEvents: [`onCommand:${id}.share`], permissions: { required: ['commands'], optional: ['terminal.selection.read', 'terminal.input.propose'] },
  contributes: { commands: names.map((name) => ({ id: `${id}.${name}`, title: name, interactive: true })) },
};
const source = `export default { activate(context) {
  const references = [];
  for (const name of ${JSON.stringify(names)}) context.subscriptions.add(context.commands.registerCommand(${JSON.stringify(id)} + '.' + name, async () => {
    if (name === 'share') {
      const value = await context.terminals.shareSelection('Synthetic selected text');
      if (value === undefined) return { cancelled: true };
      references.push(value);
      return { ...value, frozen: Object.isFrozen(value) };
    }
    if (name === 'spoof') return context.terminals.proposeInput('x'.repeat(76), 'synthetic', 'Invalid handle');
    const reference = name === 'draftFirst' ? references[0] : references.at(-1);
    return context.terminals.proposeInput(reference.handle, "synthetic first\\nsecond\\r\\u0003\\u001b[31m\\u0000", 'Synthetic input review');
  }));
} };`;

test('installed entrypoint keeps consent, exact snapshots, separate references and drafts without PTY writes', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await f.install(source, manifest);
  const run = (name) => f.service.contributionService.executeCommand(`${id}.${name}`);
  f.allow(false);
  await assert.rejects(run('share'), /disabled/);
  assert.equal(f.prompts.filter((p) => !p.closed).length, 0);
  f.allow(true); f.mode('cancel');
  assert.deepEqual(await run('share'), { cancelled: true });
  assert.equal(f.service.interactionService.terminalSelection.handles.size, 0);
  f.mode('share');
  const a = await run('share');
  assert.equal(a.text, 'synthetic owned selection\nsecond line'); assert.equal(a.frozen, true);
  assert.deepEqual(Object.keys(a).sort(), ['expiresAt', 'frozen', 'handle', 'text']);
  f.selection('changed after sharing');
  assert.equal(await run('draftFirst'), true);
  const proposal = f.prompts.find((p) => p.request?.kind === 'terminal.input.propose');
  assert.equal(proposal.request.text, 'synthetic first\nsecond\r\u0003\u001b[31m\u0000');
  assert.equal(proposal.terminalSessionId, 'terminal-a');
  assert.deepEqual(f.writes, []);
  f.selection('');
  await assert.rejects(run('share'), /Select terminal text/);
  f.selection('x'.repeat(4097));
  assert.deepEqual(await run('share'), { cancelled: true });
  f.selection('synthetic B'); await f.startB();
  const b = await run('share'); assert.equal(b.text, 'synthetic B'); assert.notEqual(b.handle, a.handle);
  await assert.rejects(run('draftFirst'), /unavailable/);
  assert.equal(await run('draftLast'), true);
  assert.equal(f.prompts.filter((p) => p.request?.kind === 'terminal.input.propose').at(-1).terminalSessionId, 'terminal-b');
  await assert.rejects(run('spoof'), /unavailable/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.decisions.length, 0, 'Ask is integrated into host sharing and draft UI');
  assert.ok(f.prompts.some((p) => p.permissionMode === 'ask'));
  assert.match(f.prompts.find((p) => p.request?.kind === 'terminal.selection.read').terminalSessionId, /terminal-a/);
  f.service.interactionService.rates.clear();
  f.service.permissionEngine.revokeApplication(id, 'terminal.input.propose');
  await assert.rejects(run('draftLast'), /unavailable/);
  const audit = JSON.stringify(f.service.database.listSecurityAudit?.(id) ?? []);
  assert.equal(audit.includes('synthetic owned selection'), false);
});

test('installed references revoke across worker reconnect, attached owner, hidden target and disable', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.install(source, manifest);
  const run = (name) => f.service.contributionService.executeCommand(`${id}.${name}`);
  await run('share');
  const first = f.manager.getPluginSessionBinding('terminal-a', 7); assert.ok(first);
  f.runtime.createSender(7).send('netcatty:exit', { sessionId: 'terminal-a', reason: 'error' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.manager.getPluginSessionBinding('terminal-a', 7), null);
  await f.manager.request('netcatty:local:reconnect', { sessionId: 'terminal-a' }, { webContentsId: 7 });
  assert.notEqual(f.manager.getPluginSessionBinding('terminal-a', 7).generation, first.generation);
  await assert.rejects(run('draftFirst'), /unavailable/);
  await run('share'); f.select('terminal-a', 'replacement-renderer');
  await assert.rejects(run('draftLast'), /unavailable/);
  await run('share');
  assert.equal((await f.manager.rebindOutputSession('terminal-a', 9)).success, true);
  assert.equal(f.manager.getPluginSessionBinding('terminal-a', 7), null);
  await assert.rejects(run('draftLast'), /unavailable/);
  assert.equal((await f.manager.rebindOutputSession('terminal-a', 7)).success, true);
  await run('share');
  f.service.interactionService.setTerminalTarget(f.sender, { sessionId: null });
  await assert.rejects(run('share'), /Select a live terminal/);
  await assert.rejects(run('draftLast'), /unavailable/);
  assert.deepEqual(f.writes, []);
});

test('disable cancels an installed pending draft and rejects its late token', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.install(source, manifest);
  const run = (name) => f.service.contributionService.executeCommand(`${id}.${name}`);
  await run('share');
  f.mode('cancel');
  assert.equal(await run('draftLast'), false);
  assert.deepEqual(f.writes, []);
  f.mode('pending');
  const shown = new Promise((resolve) => f.sender.once('prompt', resolve));
  const pending = run('draftLast'); void pending.catch(() => {});
  await Promise.race([shown, pending.then(() => { throw new Error("Draft completed without a host prompt"); })]);
  assert.equal(f.service.interactionService.pending.size, 1);
  const prompt = f.prompts.filter((p) => !p.closed).at(-1);
  await f.service.manager.setEnabled(id, false);
  await assert.rejects(pending, /stopped|closed|cancel|inactive|unavailable/);
  assert.equal(f.service.interactionService.terminalSelection.handles.size, 0);
  assert.equal(await f.service.interactionService.respond(f.sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action: 'submit' }), false);
  assert.deepEqual(f.writes, []);
});

test('tiny bundled sandbox sample runs its registered command through the installed host', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const { prepareTerminalDraftExample } = await import('../../examples/plugins/terminal-selection-draft/prepare.mjs');
  const archive = path.join(f.root, 'sample.ncpkg');
  await prepareTerminalDraftExample(archive);
  await f.service.manager.install(archive, { enable: true });
  assert.deepEqual(await f.service.contributionService.executeCommand('com.netcatty.terminal-selection-draft.share'), { sharedCharacters: 'synthetic owned selection\nsecond line'.length });
  assert.deepEqual(await f.service.contributionService.executeCommand('com.netcatty.terminal-selection-draft.review'), { reviewed: true });
  f.mode('cancel');
  assert.deepEqual(await f.service.contributionService.executeCommand('com.netcatty.terminal-selection-draft.share'), { cancelled: true });
  const promptCount = f.prompts.length;
  await assert.rejects(f.service.contributionService.executeCommand('com.netcatty.terminal-selection-draft.review'), /Plugin operation failed/);
  assert.equal(f.prompts.length, promptCount, 'a cancelled share cannot reuse an old handle or silently reread');
  assert.deepEqual(f.writes, []);
});

test('changing the selected renderer cancels an installed preview and rejects late sharing', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.install(source, manifest);
  f.mode('pending');
  const shown = new Promise((resolve) => f.sender.once('prompt', resolve));
  const pending = f.service.contributionService.executeCommand(`${id}.share`); void pending.catch(() => {});
  const first = await Promise.race([shown, pending.then(() => { throw new Error('Share completed without a prompt'); })]);
  assert.equal(await f.service.interactionService.respond(f.sender, { requestId: first.requestId, actionToken: first.actionToken, action: 'preview', value: 'synthetic snapshot' }), true);
  const preview = f.prompts.filter((p) => !p.closed).at(-1);
  assert.equal(preview.phase, 'preview');
  f.select('terminal-a', 'new-renderer');
  await assert.rejects(pending, /cancel|changed/);
  assert.equal(await f.service.interactionService.respond(f.sender, { requestId: preview.requestId, actionToken: preview.actionToken, action: 'submit' }), false);
  assert.equal(f.service.interactionService.terminalSelection.handles.size, 0);
  assert.deepEqual(f.writes, []);
});

test('installed Allow shares the host-selected snapshot without confirmation; Deny releases no text or draft', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.install(source, manifest);
  const plugin = f.service.database.getActivePlugin(id);
  f.service.permissionEngine.setMode(plugin, 'terminal.selection.read', 'allow');
  f.service.permissionEngine.setMode(plugin, 'terminal.input.propose', 'allow');
  const run = (name) => f.service.contributionService.executeCommand(`${id}.${name}`);
  const shared = await run('share'); assert.equal(shared.text, 'synthetic owned selection\nsecond line');
  assert.equal(f.prompts.filter((p) => p.phase === 'preview').length, 0, 'no sharing confirmation in Allow');
  assert.equal(f.decisions.length, 0);
  assert.equal(await run('draftLast'), true, 'editable draft remains a real workflow');
  assert.deepEqual(f.writes, []);
  f.service.permissionEngine.setMode(plugin, 'terminal.selection.read', 'deny');
  const count = f.prompts.length;
  await assert.rejects(run('share'), /disabled/);
  assert.equal(f.prompts.length, count);
  assert.equal(f.service.interactionService.terminalSelection.handles.size, 0);
  await assert.rejects(run('draftLast'), /unavailable/);
  assert.deepEqual(f.writes, []);
});
