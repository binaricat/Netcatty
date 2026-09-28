const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { configureTerminalSessionDataEmitter, emitTerminalSessionData } = require('./emitTerminalSessionData.cjs');
const { registerCattyExecHandlers } = require('./aiBridge/cattyExecHandlers.cjs');
const { execViaPty } = require('./ai/ptyExec.cjs');
// Keep bridge discovery writes/deletes off the installed app's live file.
const { isolateCliDiscoveryFile } = require('./cliDiscoveryTestIsolation.cjs');
isolateCliDiscoveryFile();

const bridge = require('./mcpServerBridge.cjs');

for (const surface of ['catty', 'mcp-exec', 'mcp-job']) {
  for (const hasPort of [true, false]) {
    test(`${surface} primes and resets on the PTY output transport (port=${hasPort})`, async (t) => {
      const deliveries = [];
      const pty = new EventEmitter();
      const session = { protocol: 'local', shellKind: 'posix', pty, webContentsId: 7 };
      const contents = { isDestroyed: () => false, send: (_channel, payload) => {
        if (!payload.syntheticEcho) deliveries.push(['ipc', payload.data]);
      } };
      const sessions = new Map([['session', session]]);
      configureTerminalSessionDataEmitter({ getSession: id => sessions.get(id), outputChannel: {
        send: (_id, data) => {
          if (!hasPort) return false;
          deliveries.push(['port', data]);
          return true;
        },
      } });
      t.after(() => { bridge.cleanup(); configureTerminalSessionDataEmitter(); });
      const transport = hasPort ? 'port' : 'ipc';
      let writes = 0;
      pty.write = data => {
        if (data === '\x03') return;
        if (writes++ === 0) {
          assert.equal(deliveries.length, 1, 'prime arrives before any typed bytes');
          assert.equal(deliveries[0][0], transport);
          assert.match(deliveries[0][1], /__NCMCP_.*_I\r?\n$/);
          emitTerminalSessionData(contents, 'session', 'wrapped echo\r\n', { session });
        }
      };
      const electronModule = { webContents: { fromId: () => contents } };
      bridge.init({ sessions, electronModule });
      bridge.setPermissionMode('auto');
      bridge.updateSessionMetadata([{ sessionId: 'session', protocol: 'local', connected: true }], 'chat');
      let pending;
      if (surface === 'catty') {
        const handlers = new Map();
        registerCattyExecHandlers({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
          validateSender: () => true, sessions, mcpServerBridge: bridge, electronModule,
          safeSend: (target, ...args) => target.send(...args), execViaPty, getFreshIdlePrompt: () => '' });
        pending = handlers.get('netcatty:ai:exec')({ sender: contents }, { sessionId: 'session', command: 'echo test', chatSessionId: 'chat' });
      } else {
        pending = bridge.dispatchBuiltinRpc(surface === 'mcp-job' ? 'netcatty/jobStart' : 'netcatty/exec', {
          sessionId: 'session', command: 'echo test', chatSessionId: 'chat',
        });
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(writes > 0, 'execution must reach the PTY');
      bridge.cancelAllPtyExecs();
      pty.emit("close");
      await pending;
      assert.equal(deliveries[1][0], transport);
      assert.equal(deliveries[1][1], 'wrapped echo\r\n');
      assert.equal(deliveries.at(-1)[0], transport);
      assert.match(deliveries.at(-1)[1], /__NCMCP_.*_R\r?\n$/);
    });
  }
}
