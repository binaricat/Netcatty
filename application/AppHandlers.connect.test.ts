import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flushQueuedTrayPanelConnectHostsImpl,
  handleConnectToHostImpl,
  handleKeyboardInteractiveSubmitImpl,
  handleTrayPanelConnectRequestImpl,
} from './app/AppHandlers.ts';
import { resolveShellSetting } from '../lib/useDiscoveredShells.ts';
import type { Host } from '../types';

const baseHost: Host = {
  id: 'host-1',
  label: '10.2.0.32',
  hostname: '10.2.0.32',
  username: 'root',
  tags: [],
  os: 'linux',
  protocol: 'ssh',
};

test('connect host handler returns the created terminal tab id', () => {
  const logs: unknown[] = [];
  const connectedHosts: Host[] = [];
  const result = handleConnectToHostImpl(
    () => ({
      addConnectionLog: (entry: unknown) => logs.push(entry),
      connectToHost: (host: Host) => {
        connectedHosts.push(host);
        return 'session-from-connect';
      },
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: 'root' }),
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
    }),
    baseHost,
  );

  assert.equal(result, 'session-from-connect');
  assert.equal(connectedHosts.length, 1);
  assert.equal(logs.length, 1);
});

test('connect logs use the same Mosh-before-ET protocol precedence as the launcher', () => {
  const logs: Array<{ protocol?: string }> = [];
  handleConnectToHostImpl(
    () => ({
      addConnectionLog: (entry: { protocol?: string }) => logs.push(entry),
      connectToHost: () => 'session-both-transports',
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: 'root' }),
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
    }),
    { ...baseHost, moshEnabled: true, etEnabled: true },
  );

  assert.equal(logs[0]?.protocol, 'mosh');
});

test('connect serial host handler returns the created terminal tab id', () => {
  const serialHost: Host = {
    ...baseHost,
    id: 'serial-1',
    label: '',
    hostname: '/dev/tty.usbserial',
    protocol: 'serial',
  };

  const result = handleConnectToHostImpl(
    () => ({
      addConnectionLog: () => {},
      connectToHost: () => 'serial-session',
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: 'root' }),
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
    }),
    serialHost,
  );

  assert.equal(result, 'serial-session');
});

test('tray panel connect request queues until the vault is initialized', () => {
  const queuedHostIds: string[] = [];
  const connectedHostIds: string[] = [];

  handleTrayPanelConnectRequestImpl(
    () => ({
      connectNow: (hostId: string) => connectedHostIds.push(hostId),
      isVaultInitialized: false,
      queueConnect: (hostId: string) => queuedHostIds.push(hostId),
    }),
    'host-1',
  );

  assert.deepEqual(queuedHostIds, ['host-1']);
  assert.deepEqual(connectedHostIds, []);
});

test('tray panel connect request runs immediately after the vault is initialized', () => {
  const queuedHostIds: string[] = [];
  const connectedHostIds: string[] = [];

  handleTrayPanelConnectRequestImpl(
    () => ({
      connectNow: (hostId: string) => connectedHostIds.push(hostId),
      isVaultInitialized: true,
      queueConnect: (hostId: string) => queuedHostIds.push(hostId),
    }),
    'host-1',
  );

  assert.deepEqual(queuedHostIds, []);
  assert.deepEqual(connectedHostIds, ['host-1']);
});

test('queued tray panel connects flush in order', () => {
  const connectedHostIds: string[] = [];
  let pendingHostIds = ['host-1', 'host-2'];

  flushQueuedTrayPanelConnectHostsImpl(() => ({
    connectNow: (hostId: string) => connectedHostIds.push(hostId),
    pendingHostIds,
    setPendingHostIds: (nextHostIds: string[]) => {
      pendingHostIds = nextHostIds;
    },
  }));

  assert.deepEqual(connectedHostIds, ['host-1', 'host-2']);
  assert.deepEqual(pendingHostIds, []);
});

test('keyboard-interactive submit can save login password for the session host', async () => {
  let hosts: Host[] = [{
    ...baseHost,
    password: 'old-password',
    savePassword: false,
  }];
  let queue = [{
    requestId: 'ki-1',
    sessionId: 'session-1',
    hostname: baseHost.hostname,
    allowSavePassword: true,
  }];
  const bridgeResponses: unknown[] = [];
  const hostUpdates: Host[][] = [];

  await handleKeyboardInteractiveSubmitImpl(
    () => ({
      hosts,
      keyboardInteractiveQueue: queue,
      netcattyBridge: {
        get: () => ({
          respondKeyboardInteractive: (...args: unknown[]) => {
            bridgeResponses.push(args);
            return { success: true };
          },
        }),
      },
      sessions: [{
        id: 'session-1',
        hostId: baseHost.id,
        hostname: baseHost.hostname,
      }],
      setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => {
        queue = updater(queue);
      },
      t: (key: string) => key,
      toast: { error: () => {} },
      updateHosts: (nextHosts: Host[]) => {
        hostUpdates.push(nextHosts);
        hosts = nextHosts;
      },
    }),
    'ki-1',
    ['login-password', 'otp-code'],
    'new-login-password',
  );

  assert.equal(hostUpdates.length, 1);
  assert.deepEqual(hosts[0], {
    ...baseHost,
    password: 'new-login-password',
    savePassword: true,
  });
  assert.deepEqual(queue, []);
  assert.equal(bridgeResponses.length, 1);
});

test('keyboard-interactive submit does not save secondary password when allowSavePassword is false', async () => {
  let hosts: Host[] = [{
    ...baseHost,
    password: 'login-password',
  }];
  let queue = [{
    requestId: 'ki-external',
    sessionId: 'sftp-connection-1',
    hostId: baseHost.id,
    scope: 'external',
    hostname: baseHost.hostname,
    allowSavePassword: false,
  }];
  let hostUpdates = 0;

  await handleKeyboardInteractiveSubmitImpl(
    () => ({
      hosts,
      keyboardInteractiveQueue: queue,
      netcattyBridge: {
        get: () => ({
          respondKeyboardInteractive: () => ({ success: true }),
        }),
      },
      sessions: [],
      setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => {
        queue = updater(queue);
      },
      t: (key: string) => key,
      toast: { error: () => {} },
      updateHosts: (nextHosts: Host[]) => {
        hostUpdates += 1;
        hosts = nextHosts;
      },
    }),
    'ki-external',
    ['secondary-password'],
    'should-not-save',
  );

  assert.equal(hostUpdates, 0);
  assert.equal(hosts[0].password, 'login-password');
  assert.deepEqual(queue, []);
});

test('keyboard-interactive submit uses explicit hostId when saving password', async () => {
  const jumpHost: Host = {
    ...baseHost,
    id: 'jump-1',
    label: 'Jump',
    hostname: 'jump.example.com',
    password: 'old-jump-password',
  };
  let hosts: Host[] = [{
    ...baseHost,
    password: 'target-password',
  }, jumpHost];
  let queue = [{
    requestId: 'ki-jump',
    sessionId: 'terminal-session-1',
    hostId: jumpHost.id,
    scope: 'terminal',
    hostname: jumpHost.hostname,
    allowSavePassword: true,
  }];

  await handleKeyboardInteractiveSubmitImpl(
    () => ({
      hosts,
      keyboardInteractiveQueue: queue,
      netcattyBridge: {
        get: () => ({
          respondKeyboardInteractive: () => ({ success: true }),
        }),
      },
      sessions: [{
        id: 'terminal-session-1',
        hostId: baseHost.id,
        hostname: baseHost.hostname,
      }],
      setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => {
        queue = updater(queue);
      },
      t: (key: string) => key,
      toast: { error: () => {} },
      updateHosts: (nextHosts: Host[]) => {
        hosts = nextHosts;
      },
    }),
    'ki-jump',
    ['jump-login-password'],
    'new-jump-password',
  );

  assert.equal(hosts.find((host) => host.id === baseHost.id)?.password, 'target-password');
  assert.equal(hosts.find((host) => host.id === jumpHost.id)?.password, 'new-jump-password');
});

test('keyboard-interactive submit preserves host changes made while delivery is pending', async () => {
  let hosts: Host[] = [{
    ...baseHost,
    label: 'Original label',
    password: 'old-password',
  }];
  const hostsRef = { current: hosts };
  let queue = [{
    requestId: 'ki-delayed',
    sessionId: 'session-delayed',
    hostname: baseHost.hostname,
    allowSavePassword: true,
  }];
  let resolveDelivery: (result: { success: boolean }) => void = () => {};
  const delivery = new Promise<{ success: boolean }>((resolve) => {
    resolveDelivery = resolve;
  });

  const submitPromise = handleKeyboardInteractiveSubmitImpl(
    () => ({
      hosts,
      hostsRef,
      keyboardInteractiveQueue: queue,
      netcattyBridge: {
        get: () => ({ respondKeyboardInteractive: () => delivery }),
      },
      sessions: [{
        id: 'session-delayed',
        hostId: baseHost.id,
        hostname: baseHost.hostname,
      }],
      setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => {
        queue = updater(queue);
      },
      t: (key: string) => key,
      toast: { error: () => {} },
      updateHosts: (nextHosts: Host[]) => {
        hosts = nextHosts;
        hostsRef.current = nextHosts;
      },
    }),
    'ki-delayed',
    ['new-password'],
    'new-password',
  );

  hosts = [{ ...hosts[0], label: 'Synced label', tags: ['synced'] }];
  hostsRef.current = hosts;
  resolveDelivery({ success: true });
  await submitPromise;

  assert.deepEqual(hosts[0], {
    ...baseHost,
    label: 'Synced label',
    tags: ['synced'],
    password: 'new-password',
    savePassword: true,
  });
  assert.deepEqual(queue, []);
});

test('keyboard-interactive submit keeps the prompt and password unchanged when delivery fails', async () => {
  let hosts: Host[] = [{
    ...baseHost,
    password: 'old-password',
  }];
  let queue = [{
    requestId: 'ki-failed',
    sessionId: 'session-1',
    hostname: baseHost.hostname,
    allowSavePassword: true,
  }];
  const errors: string[] = [];

  const submitted = await handleKeyboardInteractiveSubmitImpl(
    () => ({
      hosts,
      keyboardInteractiveQueue: queue,
      netcattyBridge: {
        get: () => ({
          respondKeyboardInteractive: () => ({ success: false, error: 'Request not found' }),
        }),
      },
      sessions: [{
        id: 'session-1',
        hostId: baseHost.id,
        hostname: baseHost.hostname,
      }],
      setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => {
        queue = updater(queue);
      },
      t: (key: string) => key,
      toast: { error: (message: string) => errors.push(message) },
      updateHosts: (nextHosts: Host[]) => {
        hosts = nextHosts;
      },
    }),
    'ki-failed',
    ['new-password'],
    'new-password',
  );

  assert.equal(submitted, false);
  assert.deepEqual(queue.map((request) => request.requestId), ['ki-failed']);
  assert.equal(hosts[0].password, 'old-password');
  assert.deepEqual(errors, ['Request not found']);
});

test('local host without explicit shell resolves the configured Settings shell', () => {
  const connectedHosts: Host[] = [];
  const localHost: Host = { ...baseHost, id: 'local-1', hostname: 'localhost', protocol: 'local' };
  const discoveredShells = [
    { id: 'wsl-ubuntu', name: 'Ubuntu (WSL)', command: 'wsl.exe', args: ['-d', 'Ubuntu'] },
  ];

  handleConnectToHostImpl(
    () => ({
      addConnectionLog: () => {},
      connectToHost: (host: Host) => {
        connectedHosts.push(host);
        return 'local-session';
      },
      discoveredShells,
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: '' }),
      resolveShellSetting,
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
      terminalSettings: { localShell: 'wsl-ubuntu' },
    }) as never,
    localHost,
  );

  assert.equal(connectedHosts.length, 1);
  assert.equal(connectedHosts[0].localShell, 'wsl.exe');
  assert.deepEqual(connectedHosts[0].localShellArgs, ['-d', 'Ubuntu']);
  assert.equal(connectedHosts[0].localShellName, 'Ubuntu (WSL)');
});

test('local host with an explicit shell keeps it (no Settings fallback)', () => {
  const connectedHosts: Host[] = [];
  const localHost: Host = {
    ...baseHost,
    id: 'local-2',
    hostname: 'localhost',
    protocol: 'local',
    localShell: 'pwsh',
  };

  handleConnectToHostImpl(
    () => ({
      addConnectionLog: () => {},
      connectToHost: (host: Host) => {
        connectedHosts.push(host);
        return 'local-session-2';
      },
      discoveredShells: [],
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: '' }),
      resolveShellSetting,
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
      terminalSettings: { localShell: 'wsl-ubuntu' },
    }) as never,
    localHost,
  );

  assert.equal(connectedHosts.length, 1);
  assert.equal(connectedHosts[0].localShell, 'pwsh');
  assert.equal(connectedHosts[0].localShellName, undefined);
});
