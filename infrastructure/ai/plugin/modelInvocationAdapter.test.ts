import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createPluginModelAdapter } from './modelInvocationAdapter';
import { createBridgeFetchForSDK } from '../sdk/providers';
import type { ProviderConfig } from '../types';

const require = createRequire(import.meta.url);
const { ModelInvocationBroker } = require('../../../electron/plugins/ai/modelInvocationBroker.cjs');
const { SelectedContextAuthority } = require('../../../electron/plugins/context/selectedContextAuthority.cjs');


// Local deterministic OpenAI-compatible fixture. No model inference, credentials,
// user's Notes, configured endpoints or paid API requests are used by this test.
test('broker -> existing model factory -> existing host HTTP transport -> loopback fixture -> stream and usage', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-ai-fixture-'));
  const priorTmp = process.env.TMPDIR;
  process.env.TMPDIR = fixtureRoot;
  const aiBridge = require('../../../electron/bridges/aiBridge.cjs');
  t.after(() => {
    if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer __IPC_SECURED__');
    let body = '';
    for await (const chunk of request) { body += chunk; assert.ok(Buffer.byteLength(body) < 32_768); }
    const payload = JSON.parse(body);
    requests.push(payload);
    assert.equal(payload.model, 'deterministic-fixture');
    assert.equal(payload.stream, true);
    assert.equal(payload.tools, undefined);
    assert.equal(payload.tool_choice, undefined);
    assert.equal(payload.messages.some((message: { role: string }) => message.role === 'system'), false);
    assert.match(JSON.stringify(payload.messages), /Synthetic retry plan/);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (payload.messages.at(-1).content === 'Large fixture') {
      response.end(`data: ${'X'.repeat(140_000)}\n\n`);
      return;
    }
    const send = (delta: Record<string, unknown>, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deterministic-fixture',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    send({ role: 'assistant' }); send({ content: 'Synthetic plan: ' });
    if (payload.messages.at(-1).content === 'Stop fixture') {
      const timer = setTimeout(() => { send({ content: 'late text' }); response.end('data: [DONE]\n\n'); }, 2000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    send({ content: 'add retry button.' }); send({}, 'stop');
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'deterministic-fixture', choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const data = new Map<string, (value: string) => void>();
  const end = new Map<string, () => void>();
  const errors = new Map<string, (value: string) => void>();
  const originalWindow = globalThis.window;
  const sentBodies: string[] = [];
  const bridge = {
    aiFetch: async () => { throw Error('Nonstreaming transport is not expected'); },
    onAiStreamData: (id: string, callback: (value: string) => void) => { data.set(id, callback); return () => data.delete(id); },
    onAiStreamEnd: (id: string, callback: () => void) => { end.set(id, callback); return () => end.delete(id); },
    onAiStreamError: (id: string, callback: (value: string) => void) => { errors.set(id, callback); return () => errors.delete(id); },
    aiChatCancel: async () => { aiBridge.cleanup(); return true; },
    aiChatStream: async (id: string, url: string, headers: Record<string, string>, body: string) => {
      assert.equal(new URL(url).origin, new URL(baseURL).origin);
      sentBodies.push(body);
      const result = await aiBridge._streamRequestForTests(url, { headers, body }, { sender: {
        isDestroyed: () => false,
        send: (channel: string, payload: { data?: string; error?: string }) => {
          if (channel.endsWith(':data')) data.get(id)?.(payload.data!);
          if (channel.endsWith(':end')) end.get(id)?.();
          if (channel.endsWith(':error')) errors.get(id)?.(payload.error!);
        },
      } }, id, false);
      return { ok: result.statusCode === 200, ...result };
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { netcatty: bridge } });
  t.after(() => { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); aiBridge.cleanup(); });
  const config: ProviderConfig = { id: 'isolated-fixture', providerId: 'custom', enabled: true, name: 'Fixture',
    baseURL, defaultModel: 'deterministic-fixture', apiKey: 'synthetic-not-a-paid-api-key' };
  const model = createPluginModelAdapter({ config, label: 'Local deterministic fixture', isCurrent: () => true });
  const owner = {};
  const resolveDataOwner = () => owner;
  const context = { pluginId: 'example', pluginVersion: '1', runtimeId: 'qa-isolated', assertActive: async () => {} };
  const contexts = new SelectedContextAuthority({ resolveDataOwner });
  const note = await contexts.share({ scope: 'note', version: '1', title: 'Synthetic Note', isCurrent: () => true,
    readText: () => 'Synthetic retry plan: add retry button.' }, context);
  const broker = new ModelInvocationBroker({ resolveDataOwner, resolveBudgetOwner: () => 'synthetic-source-owner', contexts, selectModel: () => model });
  t.after(() => broker.shutdown());
  const chat = await broker.open(context);
  const turn = await broker.start({ chatHandle: chat.chatHandle, prompt: 'Summarize this Note.',
    contexts: [{ handle: note.handle, version: note.version }] }, context);
  let text = ''; let usage;
  for (;;) {
    const event = await broker.read(turn.turnHandle, context);
    if (event.kind === 'end') break;
    if (event.kind === 'text') text += event.text;
    if (event.kind === 'usage') usage = event;
  }
  assert.equal(text, 'Synthetic plan: add retry button.');
  assert.deepEqual(usage, { kind: 'usage', sequence: 2, inputTokens: 12, outputTokens: 6, totalTokens: 18 });
  assert.equal(requests.length, 1);
  assert.equal(aiBridge._getActiveStreamCountForTests(), 0);
  assert.doesNotMatch(JSON.stringify({ chat, turn, text, usage, sentBodies }), /synthetic-not-a-paid-api-key/);
  // Exercise the actual page handlers through its existing command-only view
  // surface. This is DOM QA, not installed-plugin or native Electron evidence.
  const dom = new JSDOM(fs.readFileSync(new URL('../../../examples/plugins/assistant/view.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const commandHandlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    open: () => broker.open(context), contexts: () => contexts.summaries(context),
    send: (params) => broker.start(params, context),
    read: (params) => broker.read(params.turnHandle, context),
    stop: (params) => broker.stop(params.turnHandle, context),
    close: (params) => broker.close(params.chatHandle, context),
  };
  const commands = {
    executeCommand: async (id: string, params: Record<string, unknown>) => {
      const operation = id.replace('com.netcatty.assistant.', '');
      assert.ok(Object.hasOwn(commandHandlers, operation));
      return structuredClone(await commandHandlers[operation](structuredClone(params)));
    },
  };
  const mount = dom.window.eval('(' + fs.readFileSync(new URL('../../../examples/plugins/assistant/panel.js', import.meta.url), 'utf8').replace('export function mount', 'function mount') + ')');
  const dispose = mount(dom.window.document.body, { commands, views: { onDidReceiveMessage: () => ({ dispose() {} }) } }, 'com.netcatty.assistant.panel');
  t.after(dispose);
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() >= deadline) throw Error('Panel state timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const element = (id: string) => dom.window.document.getElementById(id)!;
  await waitFor(() => element('status').textContent === 'Ready');
  const selection = element('context') as HTMLSelectElement;
  assert.equal(selection.options.length, 2);
  assert.equal(selection.value, '');
  selection.value = note.handle; // Explicit synthetic Note selection in the UI.
  element('compose').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await waitFor(() => element('status').textContent === 'Complete');
  assert.equal(element('response').textContent, 'Synthetic plan: add retry button.');
  assert.match(element('usage').textContent!, /12 input tokens/);
  assert.equal(requests.length, 2);
  (element('prompt') as HTMLTextAreaElement).value = 'Stop fixture';
  element('compose').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await waitFor(() => element('response').textContent === 'Synthetic plan: ');
  element('stop').dispatchEvent(new dom.window.Event('click'));
  await waitFor(() => element('status').textContent === 'Stopped');
  assert.equal(broker.turns.size, 0);
  assert.equal((element('send') as HTMLButtonElement).disabled, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(element('response').textContent, 'Synthetic plan: ');
  assert.equal(aiBridge._getActiveStreamCountForTests(), 0);
  const dummyBody = (prompt: string) => JSON.stringify({ model: 'deterministic-fixture', stream: true,
    messages: [{ role: 'user', content: 'Synthetic retry plan' }, { role: 'user', content: prompt }] });
  const sender = { isDestroyed: () => false, send: () => {} };
  const streamOptions = { headers: { authorization: 'Bearer __IPC_SECURED__', 'content-type': 'application/json' }, body: dummyBody('Stop fixture') };
  await aiBridge._streamRequestForTests(`${baseURL}/chat/completions`, streamOptions, { sender }, 'plugin-model_runtime-a_one', false);
  await aiBridge._streamRequestForTests(`${baseURL}/chat/completions`, streamOptions, { sender }, 'plugin-model_runtime-b_two', false);
  await aiBridge._streamRequestForTests(`${baseURL}/chat/completions`, streamOptions, { sender }, 'sdk_agent_synthetic', false);
  assert.equal(aiBridge._getActiveStreamCountForTests(), 3);
  assert.equal(aiBridge.cancelPluginAIStreamsForSender({}, 'runtime-a'), 0);
  assert.equal(aiBridge.cancelPluginAIStreamsForSender(sender, 'runtime-a'), 1);
  assert.equal(aiBridge._getActiveStreamCountForTests(), 2);
  assert.equal(aiBridge.cancelPluginAIStreamsForSender(sender), 1);
  assert.equal(aiBridge._getActiveStreamCountForTests(), 1); // Ordinary synthetic Agent request survives.
  aiBridge.cleanup();
  let oversizedError: string | undefined;
  const oversizedEnded = new Promise<void>((resolve) => {
    const capture = { isDestroyed: () => false, send: (channel: string, payload: { error?: string }) => {
      if (channel.endsWith(':error')) { oversizedError = payload.error; resolve(); }
    } };
    void aiBridge._streamRequestForTests(`${baseURL}/chat/completions`, { ...streamOptions, body: dummyBody('Large fixture') },
      { sender: capture }, 'plugin-model_runtime-a_oversized', false).catch(() => resolve());
  });
  await oversizedEnded;
  assert.match(oversizedError!, /Plugin model stream byte budget exceeded/);
  assert.equal(aiBridge._getActiveStreamCountForTests(), 0);

});

test('plugin provider adapter refuses direct-fetch fallback when the host transport disappears', async (t) => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
  t.after(() => Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }));
  await assert.rejects(createBridgeFetchForSDK('fixture', { requireBridge: true })('http://127.0.0.1:1/never'), /Host AI transport is unavailable/);
});

test('plugin transport byte cap cancels before unbounded SDK buffering', async (t) => {
  const originalWindow = globalThis.window;
  let emit: (value: string) => void; let cancelled = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { netcatty: {
    onAiStreamData: (_id: string, callback: (value: string) => void) => { emit = callback; return () => {}; },
    onAiStreamEnd: () => () => {}, onAiStreamError: () => () => {},
    aiChatCancel: async () => { cancelled++; return true; },
    aiChatStream: async () => {
      emit('X'.repeat(33));
      // Late data after cancellation must be discarded as well.
      emit('Y'.repeat(100));
      return { ok: true, statusCode: 200, statusText: 'OK' };
    },
  } } });
  t.after(() => Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }));
  const response = await createBridgeFetchForSDK('fixture', { requireBridge: true, maxStreamBytes: 32 })(
    'http://127.0.0.1:1/fixture', { method: 'POST', body: JSON.stringify({ stream: true }) });
  await assert.rejects(response.text(), /AI stream byte budget exceeded/);
  assert.equal(cancelled, 1);
});
