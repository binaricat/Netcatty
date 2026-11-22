import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Host, TerminalSession } from '../../domain/models';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { updateRestoredSessionStatusState } from '../../application/state/sessionRestoreState';
import { createHostTerminalSession } from '../../application/state/sessionFactories';
import { useHostOpenSessionReuse } from '../../application/state/useHostOpenSessionReuse';
import { handleVaultAgentOp, type VaultAgentApiDeps } from './vaultAgentBridgeClient';

const require = createRequire(import.meta.url);
const { isolateCliDiscoveryFile } = require('../../electron/bridges/cliDiscoveryTestIsolation.cjs');
isolateCliDiscoveryFile();
const bridge = require('../../electron/bridges/mcpServerBridge.cjs');
const { registerMcpTools } = require('../../electron/capabilities/codegen/mcpToolRegistry.cjs');

test('MCP host_open forwards the schema input through RPC and vault service to the real renderer handler', async (t) => {
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode('auto');
  t.after(() => bridge.cleanup());
  const host: Host = { id: 'host-1', label: 'Host', hostname: 'example.invalid', username: 'user', protocol: 'ssh', os: 'linux', tags: [] };
  const tabs: TerminalSession[] = [{ id: 'existing', hostId: host.id, hostLabel: host.label, hostname: host.hostname, username: host.username, status: 'connecting' }];
  let finder: ReturnType<typeof useHostOpenSessionReuse>;
  let renderer: ReactTestRenderer;
  function Harness() {
    finder = useHostOpenSessionReuse({ sessions: [...tabs], hosts: [{ ...host }], keys: [], identities: [], resolveEffectiveHost: (value) => value });
    return null;
  }
  const render = async () => act(async () => {
    if (renderer) renderer.update(React.createElement(Harness));
    else renderer = create(React.createElement(Harness));
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  t.after(async () => act(async () => renderer.unmount()));
  await render();
  let lastOpenOptions: { workspaceId?: string; chatSessionId?: string } | undefined;
  const deps = {
    getHosts: () => [host],
    resolveEffectiveHost: (value: Host) => value,
    findExistingSessionForHost: (hostId: string) => finder(hostId),
    openHost: (openedHost: Host, _isExternalMcpCall: boolean, options?: { workspaceId?: string; chatSessionId?: string }) => {
      lastOpenOptions = options;
      const sessionId = `new-${tabs.length}`;
      tabs.push(createHostTerminalSession(sessionId, openedHost));
      return { ok: true as const, sessionId, host };
    },
  } as unknown as VaultAgentApiDeps;
  bridge.setVaultAgentInvoker((op: string, params: Record<string, unknown>) => handleVaultAgentOp(op, params, deps));
  let openTool: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  let schema: { parse: (args: Record<string, unknown>) => Record<string, unknown> };
  registerMcpTools({
    tool(name: string, _description: string, shape: Record<string, unknown>, handler: typeof openTool) {
      if (name !== 'host_open') return;
      schema = require('zod').z.object(shape);
      openTool = handler;
    },
  }, {
    rpcCall: (method: string, params: Record<string, unknown>) => bridge.dispatchBuiltinRpc(method, params),
    scopeParams: { chatSessionId: 'integration-chat' },
    guardWriteOperation: () => null,
    catalogDescription: (_name: string, fallback: string) => fallback,
  });
  assert.ok(openTool);
  const run = async (args: Record<string, unknown>) => {
    await render();
    const response = await openTool!(schema.parse(args)) as { content: { text: string }[] };
    await render();
    return JSON.parse(response.content[0].text);
  };
  for (let index = 0; index < 3; index++) {
    const reused = await run({ hostId: host.id });
    assert.equal(reused.sessionId, 'existing');
    assert.equal(reused.reused, true);
  }
  assert.equal(tabs.length, 1);
  const fresh = await run({ hostId: host.id, newTab: 'true' });
  assert.equal(fresh.sessionId, 'new-1');
  assert.equal(tabs.length, 2);
  // The invoking chat's context must reach the placement layer so the new tab
  // can land in the chat's bound workspace (resolveAgentHostOpenWorkspace).
  assert.equal(lastOpenOptions?.chatSessionId, 'integration-chat');
  assert.equal(lastOpenOptions?.workspaceId, undefined);
  // An inactive tab requires a real open instead of an endless wait.
  // An explicit workspaceId is forwarded untouched to the placement layer.
  for (const tab of tabs) tab.status = 'disconnected';
  const recovered = await run({ hostId: host.id, newTab: 'false', workspaceId: 'ws-explicit' });
  assert.equal(recovered.sessionId, 'new-2');
  assert.equal(lastOpenOptions?.workspaceId, 'ws-explicit');
  assert.equal(tabs.length, 3);
  tabs[2].status = 'connected';
  host.label = 'Renamed only';
  assert.equal((await run({ hostId: host.id })).sessionId, recovered.sessionId);
  host.hostname = 'replacement.invalid';
  const editedTarget = await run({ hostId: host.id });
  assert.notEqual(editedTarget.sessionId, recovered.sessionId, 'a saved endpoint edit must not reuse the old transport');
  assert.equal(editedTarget.reused, undefined);
  tabs.length = 0;
  host.protocol = 'telnet';
  host.telnetPort = 2323;
  host.telnetUsername = 'telnet-user';
  host.telnetPassword = 'telnet-password';
  const telnet = await run({ hostId: host.id });
  tabs[0].status = 'connected';
  assert.equal((await run({ hostId: host.id })).sessionId, telnet.sessionId);
  host.telnetPort = 2324;
  const changedTelnet = await run({ hostId: host.id });
  assert.notEqual(changedTelnet.sessionId, telnet.sessionId, 'the actual Telnet destination port change requires a new transport');
  assert.equal(changedTelnet.reused, undefined);
  // Current-main fields only: saved-local creation/default snapshots remain #3616's responsibility.
  tabs.length = 0;
  host.protocol = 'local';
  host.hostname = 'localhost';
  host.localShell = '/bin/zsh';
  host.localShellArgs = ['-l'];
  host.localStartDir = '/original';
  const local = await run({ hostId: host.id });
  tabs[0].status = 'connected';
  assert.equal((await run({ hostId: host.id })).sessionId, local.sessionId);
  host.localStartDir = '/replacement';
  const changedLocal = await run({ hostId: host.id });
  assert.notEqual(changedLocal.sessionId, local.sessionId, 'an explicit saved local directory change must not reuse the old process');
  assert.equal(changedLocal.reused, undefined);
  // Saved serial hosts use the same first-party host_open path and factory.
  tabs.length = 0;
  host.protocol = 'serial';
  host.hostname = '/dev/tty.test';
  host.username = '';
  host.serialConfig = { path: host.hostname, baudRate: 9600, dataBits: 8, parity: 'none', flowControl: 'none' };
  const serial = await run({ hostId: host.id });
  assert.equal(serial.protocol, 'serial');
  assert.equal(tabs[0].serialConfig?.baudRate, 9600);
  tabs[0].status = 'connected';
  assert.equal((await run({ hostId: host.id })).sessionId, serial.sessionId);
  host.serialConfig = { ...host.serialConfig, baudRate: 19200 };
  const changedSerial = await run({ hostId: host.id });
  assert.notEqual(changedSerial.sessionId, serial.sessionId, 'an edited serial configuration must not reuse the old parameters');
  assert.equal(changedSerial.reused, undefined);
  assert.equal(tabs[1].serialConfig?.baudRate, 19200);
  assert.equal(tabs[0].serialConfig?.baudRate, 9600);
  tabs.length = 0;
  host.protocol = 'plugin:com.example.transport.connection';
  host.hostname = 'plugin-host';
  host.pluginConnection = { providerId: 'com.example.transport.connection', configuration: { endpoint: 'original.invalid' } };
  tabs.push({ ...createHostTerminalSession('restored-plugin', host), status: 'disconnected', restoreState: 'restored-disconnected' });
  await render();
  host.pluginConnection = { ...host.pluginConnection, configuration: { endpoint: 'replacement.invalid' } };
  tabs.splice(0, tabs.length, ...updateRestoredSessionStatusState(tabs, 'restored-plugin', 'connecting'));
  const changedPlugin = await run({ hostId: host.id });
  assert.notEqual(changedPlugin.sessionId, 'restored-plugin', 'restored plugin transport must not mask the edited provider configuration');
  assert.equal(changedPlugin.reused, undefined);
  assert.deepEqual(tabs[0].pluginConnection?.configuration, { endpoint: 'original.invalid' });
  assert.deepEqual(tabs[1].pluginConnection?.configuration, { endpoint: 'replacement.invalid' });
});
