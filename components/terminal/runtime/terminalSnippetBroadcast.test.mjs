import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath, URL } from 'node:url';
import { setTimeout } from 'node:timers';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const { normalizeLineEndings } = await load('lib/utils.ts');
const { shouldDelayAutoRunSnippetInput, AUTO_RUN_SNIPPET_LINE_DELAY_MS } = await load('components/terminal/terminalHelpers.ts');
const { resolveTerminalBroadcastTargetIds } = await load('domain/terminalBroadcast.ts');
const { canUseDirectSessionWriteFallback } = await load('components/terminalLayer/terminalLayerSessionRouting.ts');
const sourceAt = file => readFileSync(path.join(root, file), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const extract = (source, from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'Production extraction boundaries changed');
  return source.slice(start, end);
};
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Telnet evidence');
};

for (const mode of ['paste', 'lineDelay']) {
  test(`broadcast ${mode} snippet preserves Telnet auto-login on source and peer`, async () => {
    const backendFile = path.join(root, 'electron/bridges/terminalBridge.cjs');
    const backend = new Module(backendFile);
    backend.filename = backendFile;
    backend.paths = Module._nodeModulePaths(path.dirname(backendFile));
    backend._compile(sourceAt('electron/bridges/terminalBridge.cjs'), backendFile);
    const bridge = backend.exports;
    const received = [], sockets = [], events = [], calls = [];
    const server = net.createServer(socket => {
      const index = received.length;
      received.push('');
      sockets.push(socket);
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let askedUser = false, askedPassword = false;
      socket.on('data', chunk => {
        received[index] += chunk;
        if (!askedUser && received[index].includes('second\r\n')) {
          askedUser = true;
          socket.write('Username: ');
        }
        if (!askedPassword && received[index].includes('saved-user\r\n')) {
          askedPassword = true;
          socket.write('\r\nPassword: ');
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    bridge.init({ sessions: new Map(), electronModule: {
      webContents: { fromId: () => ({ send: (channel, payload) => events.push({ channel, payload }) }) },
    } });
    try {
      for (const id of ['source', 'peer']) {
        await bridge.startTelnetSession({ sender: { id: 1 } }, {
          sessionId: id, hostname: '127.0.0.1', port: server.address().port,
          username: 'saved-user', password: 'saved-secret',
        });
      }
      const terminalBackend = { writeToSession(sessionId, data, options) {
        calls.push({ sessionId, data, ...options });
        bridge.writeToSession(null, { sessionId, data, ...options });
      } };
      const layerSource = sourceAt('components/TerminalLayer.tsx');
      const layerEnv = {
        useCallback: callback => callback, terminalBackend,
        resolveTerminalBroadcastTargetIds, canUseDirectSessionWriteFallback,
        sessionsRef: { current: ['source', 'peer'].map(id => ({ id, protocol: 'telnet', status: 'connected' })) },
        isGlobalBroadcastEnabled: true, isTerminalSensitiveInputActive: () => false,
      };
      vm.runInNewContext(compile(extract(layerSource,
        '  const handleBroadcastInput = useCallback(', '  const handleCommandSubmitted')
        + '\nglobalThis.broadcast = handleBroadcastInput;'), layerEnv);
      const snippetSource = sourceAt('components/Terminal.tsx');
      const snippetEnv = {
        useCallback: callback => callback,
        termRef: { current: { modes: { bracketedPasteMode: false }, focus() {} } },
        sessionRef: { current: 'source' }, sessionId: 'source', hibernatedRef: { current: false },
        passwordPromptActiveRef: { current: false }, isBroadcastEnabledRef: { current: true },
        onBroadcastInputRef: { current: layerEnv.broadcast },
        normalizeLineEndings, shouldDelayAutoRunSnippetInput, AUTO_RUN_SNIPPET_LINE_DELAY_MS,
        disableBracketedPasteRef: { current: false }, prepareProgrammaticSudoInput: data => data,
        scrollToBottomAfterProgrammaticInput() {}, terminalBackend,
        host: { protocol: 'telnet' }, serialConfig: { lineMode: false },
      };
      vm.runInNewContext(compile(extract(snippetSource,
        '  const executeSnippetCommand = useCallback(', '  const executeSnippet = useCallback(')
        + '\nglobalThis.send = executeSnippetCommand;'), snippetEnv);
      assert.equal(await snippetEnv.send('first\nsecond', false, { multiLineRunMode: mode }), true);
      await waitFor(() => received[0]?.includes('saved-secret\r\n'));
      await waitFor(() => received[1]?.includes('saved-secret\r\n'));
      assert.deepEqual(events.filter(event => event.channel === 'netcatty:telnet:auto-login-cancelled'), []);
      assert.equal(calls.find(call => call.sessionId === 'source').automated, true);
      assert.equal(calls.find(call => call.sessionId === 'peer').automated, true);
      assert.equal(calls.find(call => call.sessionId === 'peer').lineDelayMs, mode === 'lineDelay' ? 250 : undefined);
      assert.equal(received[1].includes('saved-secret'), true);
    } finally {
      bridge.cleanupAllSessions();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
