import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { GroupConfig, Host, Identity, SSHKey, TerminalSession } from '../../domain/models';
import { updateRestoredSessionStatusState } from './sessionRestoreState';
import { resolveEffectiveTerminalHost, resolveTerminalSessionHost } from '../../domain/terminalHostResolution';
import { createHostTerminalSession } from './sessionFactories';
import { resolveHostDefaultLocalShell } from '../../domain/localShellHost';
import { useHostOpenSessionReuse } from './useHostOpenSessionReuse';
import { resolveShellSetting } from '../../lib/useDiscoveredShells';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const effective = (host: Host) => host;
const host = (extra: Partial<Host> = {}): Host => ({
  id: 'host', hostname: 'original.invalid', username: 'user', label: 'Original', os: 'linux', tags: [], protocol: 'ssh', ...extra,
});

async function harness(initial: Host, extra: { hosts?: Host[]; keys?: SSHKey[]; identities?: Identity[]; sessions?: TerminalSession[]; resolveEffectiveHost?: (host: Host) => Host } = {}) {
  let hosts = [initial, ...(extra.hosts ?? [])];
  let keys = extra.keys ?? [];
  let identities = extra.identities ?? [];
  let sessions: TerminalSession[] = extra.sessions ?? [{ ...createHostTerminalSession('tab', initial), status: 'connected' }];
  let find: ReturnType<typeof useHostOpenSessionReuse>;
  function Harness() {
    find = useHostOpenSessionReuse({ sessions, hosts, keys, identities, resolveEffectiveHost: extra.resolveEffectiveHost ?? effective });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Harness)); });
  return {
    find: () => find(initial.id),
    async update(input: { host?: Host; hosts?: Host[]; keys?: SSHKey[]; identities?: Identity[]; sessions?: TerminalSession[] }) {
      hosts = input.hosts ?? (input.host ? [input.host, ...hosts.slice(1)] : hosts);
      keys = input.keys ?? keys;
      identities = input.identities ?? identities;
      sessions = input.sessions ?? sessions;
      await act(async () => renderer.update(React.createElement(Harness)));
    },
    close: () => act(async () => renderer.unmount()),
  };
}

for (const [field, value] of [
  ['hostname', 'replacement.invalid'], ['username', 'other-user'], ['port', 2222],
  ['protocol', 'telnet'], ['password', 'new-password'], ['authMethod', 'key'],
  ['hostChain', { hostIds: ['jump'] }],
  ['proxyConfig', { type: 'socks5', host: 'proxy.invalid', port: 1080 }],
] as const) {
  test(`a saved ${field} edit cannot reuse the old tab`, async (t) => {
    const original = host({ password: 'old-password', authMethod: 'password' });
    const api = await harness(original, { hosts: [host({ id: 'jump', hostname: 'jump.invalid' })] });
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, [field]: value } });
    assert.equal(await api.find(), undefined);
  });
}

test('renaming the target and jump host keeps the same tab eligible', async (t) => {
  const original = host({ hostChain: { hostIds: ['jump'] } });
  const jump = host({ id: 'jump', hostname: 'jump.invalid' });
  const api = await harness(original, { hosts: [jump] });
  t.after(api.close);
  await api.update({ hosts: [{ ...original, label: 'Renamed', fontSize: 16, notes: 'Updated note' }, { ...jump, label: 'Renamed jump' }] });
  assert.equal((await api.find())?.sessionId, 'tab');
});

test('changing a jump endpoint or its password rejects the original connection', async (t) => {
  const original = host({ hostChain: { hostIds: ['jump'] } });
  const jump = host({ id: 'jump', hostname: 'jump.invalid', password: 'old' });
  const api = await harness(original, { hosts: [jump] });
  t.after(api.close);
  for (const changed of [{ ...jump, hostname: 'new-jump.invalid' }, { ...jump, password: 'new' }]) {
    await api.update({ hosts: [original, changed] });
    assert.equal(await api.find(), undefined);
  }
});

test('rotating a referenced identity or key keeps stable IDs from masking auth changes', async (t) => {
  const identity: Identity = { id: 'identity', label: 'Login', username: 'user', password: 'old', authMethod: 'password', created: 0 };
  const original = host({ identityId: identity.id });
  const api = await harness(original, { identities: [identity] });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ identities: [{ ...identity, password: 'rotated' }] });
  assert.equal(await api.find(), undefined);
  const key: SSHKey = { id: 'key', label: 'Key', type: 'ED25519', privateKey: 'old-key', source: 'generated', category: 'key', created: 0 };
  const keyHost = host({ identityFileId: key.id, authMethod: 'key' });
  const keyApi = await harness(keyHost, { keys: [key] });
  t.after(keyApi.close);
  assert.equal((await keyApi.find())?.sessionId, 'tab');
  await keyApi.update({ keys: [{ ...key, privateKey: 'rotated-key' }] });
  assert.equal(await keyApi.find(), undefined);
});

for (const [field, value] of [
  ['baudRate', 19200], ['dataBits', 7], ['stopBits', 2], ['parity', 'even'], ['flowControl', 'rts/cts'],
] as const) {
  test(`a serial ${field} edit must not reuse the opening parameters`, async (t) => {
    const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', serialConfig: { path: '/dev/tty.test', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' } });
    const api = await harness(original);
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, serialConfig: { ...original.serialConfig!, [field]: value } } });
    assert.equal(await api.find(), undefined);
  });
}

test('unchanged legacy serial defaults still match their opening snapshot', async (t) => {
  const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', port: 9600 });
  const api = await harness(original);
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
});

test('the captured serial settings come from the opening session even if the vault was already edited', async (t) => {
  const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', serialConfig: { path: '/dev/tty.test', baudRate: 9600 } });
  const session: TerminalSession = { ...createHostTerminalSession('tab', original), status: 'connected' };
  const api = await harness({ ...original, serialConfig: { ...original.serialConfig!, baudRate: 19200 } }, { sessions: [session] });
  t.after(api.close);
  assert.equal(await api.find(), undefined);
});

for (const changedField of ['configuration', 'credentialId'] as const) {
  test(`a restored plugin tab keeps its opening ${changedField} after manual reconnect`, async (t) => {
    const providerId = 'com.example.transport.connection';
    const original = host({ protocol: `plugin:${providerId}`, pluginConnection: { providerId, configuration: { endpoint: 'original.invalid' }, credentialId: 'original-credential-reference' } });
    const edited = { ...original, pluginConnection: { ...original.pluginConnection!, [changedField]: changedField === 'configuration' ? { endpoint: 'replacement.invalid' } : 'replacement-credential-reference' } };
    const restored: TerminalSession = { ...createHostTerminalSession('tab', original), status: 'disconnected', restoreState: 'restored-disconnected' };
    const api = await harness(edited, { sessions: [restored] });
    t.after(api.close);
    assert.equal(await api.find(), undefined);
    const reconnecting = updateRestoredSessionStatusState([restored], restored.id, 'connecting');
    const actual = resolveTerminalSessionHost({ session: reconnecting[0], hosts: [edited], groupConfigs: [], proxyProfiles: [], localOs: 'linux' });
    assert.deepEqual(actual.pluginConnection, original.pluginConnection, 'the real terminal resolver uses the restored opening configuration');
    await api.update({ sessions: reconnecting });
    assert.equal(await api.find(), undefined, 'host_open must not call that old transport the edited vault connection');
  });
}

test('an unchanged restored plugin configuration can be reused after manual reconnect', async (t) => {
  const providerId = 'com.example.transport.connection';
  const original = host({ protocol: `plugin:${providerId}`, pluginConnection: { providerId, configuration: { endpoint: 'original.invalid' } } });
  const restored: TerminalSession = { ...createHostTerminalSession('tab', original), status: 'disconnected', restoreState: 'restored-disconnected' };
  const api = await harness({ ...original, label: 'Renamed' }, { sessions: [restored] });
  t.after(api.close);
  await api.update({ sessions: updateRestoredSessionStatusState([restored], restored.id, 'connecting') });
  assert.equal((await api.find())?.sessionId, 'tab');
});

for (const [field, value] of [
  ['telnetPort', 2324], ['telnetUsername', 'other-telnet-user'], ['telnetPassword', 'rotated-telnet-password'],
] as const) {
  test(`a Telnet ${field} edit cannot reuse the old transport`, async (t) => {
    const original = host({ protocol: 'telnet', telnetPort: 2323, telnetUsername: 'telnet-user', telnetPassword: 'telnet-password' });
    const api = await harness(original);
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, [field]: value } });
    assert.equal(await api.find(), undefined);
  });
}

test('Telnet identity credential rotation and missing identity reject reuse', async (t) => {
  const identity: Identity = { id: 'telnet-login', label: 'Telnet login', username: 'telnet-user', password: 'original', authMethod: 'password', created: 0 };
  const original = host({ protocol: 'telnet', telnetIdentityId: identity.id });
  const api = await harness(original, { identities: [identity] });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  for (const identities of [[{ ...identity, username: 'other-user' }], [{ ...identity, password: 'rotated' }], []]) {
    await api.update({ identities });
    assert.equal(await api.find(), undefined);
  }
});

test('Telnet explicit empty login does not fall back to SSH login fields', async (t) => {
  const original = host({ protocol: 'telnet', telnetUsername: '', telnetPassword: '', password: 'ssh-only' });
  const api = await harness(original);
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ host: { ...original, label: 'Renamed', username: 'unrelated-ssh-user', password: 'unrelated-ssh-password', identityId: 'missing-ssh-identity', telnetPort: 23 } });
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ host: { ...original, telnetUsername: undefined, telnetPassword: undefined } });
  assert.equal(await api.find(), undefined, 'removing explicit empty overrides enables the actual fallback login');
});

for (const transport of [{ protocol: 'et' as const }, { protocol: 'ssh' as const, etEnabled: true }]) {
  test(`changing a jump ET server port rejects the old ${JSON.stringify(transport)} transport`, async (t) => {
    const original = host({ ...transport, hostChain: { hostIds: ['jump'] } });
    const jump = host({ id: 'jump', hostname: 'jump.invalid', etPort: 2022 });
    const api = await harness(original, { hosts: [jump] });
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ hosts: [original, { ...jump, etPort: 3022 }] });
    assert.equal(await api.find(), undefined);
  });
}

test('serial direct auto-login password is not masked by an unrelated SSH identity', async (t) => {
  const identity: Identity = { id: 'ssh-login', label: 'SSH login', username: 'ssh-user', password: 'ssh-password', authMethod: 'password', created: 0 };
  const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', password: 'serial-password', identityId: identity.id });
  const api = await harness(original, { identities: [identity] });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ host: { ...original, password: 'rotated-serial-password' } });
  assert.equal(await api.find(), undefined);
});

test('unchanged serial direct username matches the actual auto-login input', async (t) => {
  const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: 'serial-user', password: 'serial-password' });
  const api = await harness(original);
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ host: { ...original, username: 'other-serial-user' } });
  assert.equal(await api.find(), undefined);
});

for (const [field, value] of [
  ['localShell', '/bin/bash'], ['localShellArgs', ['--norc']], ['localStartDir', '/replacement'],
] as const) {
  test(`a saved local ${field} edit cannot reuse the old process`, async (t) => {
    const original = host({ protocol: 'local', hostname: 'localhost', localShell: '/bin/zsh', localShellArgs: ['-l'], localStartDir: '/original' });
    const session = { ...createHostTerminalSession('tab', original), status: 'connected', localShell: original.localShell, localShellArgs: original.localShellArgs, localStartDir: original.localStartDir } as TerminalSession;
    const api = await harness(original, { sessions: [session] });
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, [field]: value } });
    assert.equal(await api.find(), undefined);
    const alreadyEdited = await harness({ ...original, [field]: value }, { sessions: [session] });
    t.after(alreadyEdited.close);
    assert.equal(await alreadyEdited.find(), undefined, 'opening fields come from the actual local session');
  });
}

test('local default shell, cwd and empty args match the renderer launch contract', async (t) => {
  const original = host({ protocol: 'local', hostname: 'localhost' });
  const api = await harness(original);
  t.after(api.close);
  await api.update({ host: { ...original, localShell: '', localStartDir: '', label: 'Renamed' } });
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ host: { ...original, localShellArgs: [] } });
  assert.equal((await api.find())?.sessionId, 'tab', 'the renderer omits empty args so backend login defaults still apply');
});

for (const [label, proxy] of [
  ['a missing saved profile', { proxyProfileId: 'missing-profile' }],
  ['a usable proxy', { proxyConfig: { type: 'socks5', host: 'proxy.invalid', port: 1080 } }],
  ['a missing proxy identity', { proxyConfig: { type: 'socks5', host: '', port: 0, identityId: 'missing-identity' } }],
  ['an incomplete proxy identity', { proxyConfig: { type: 'socks5', host: '', port: 0, identityId: 'incomplete-identity' } }],
] as const) {
  test(`Telnet adding ${label} cannot bypass actual starter rejection through reuse`, async (t) => {
    const original = host({ protocol: 'telnet' });
    const api = await harness(original, { identities: [{ id: 'incomplete-identity', label: 'Incomplete', username: 'proxy-user', authMethod: 'password', created: 0 }] });
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, ...proxy } });
    assert.equal(await api.find(), undefined);
    await api.update({ host: { ...original, label: 'Renamed without a proxy' } });
    assert.equal((await api.find())?.sessionId, 'tab');
  });
}

test('Telnet inheriting a proxy profile cannot reuse its previous direct session', async (t) => {
  const original = host({ protocol: 'telnet', group: 'prod/web' });
  const groupConfigs: GroupConfig[] = [];
  const proxyProfiles = [{ id: 'group-proxy', label: 'Proxy', createdAt: 0, config: { type: 'socks5' as const, host: 'proxy.invalid', port: 1080 } }];
  const resolveEffectiveHost = (candidate: Host) => resolveEffectiveTerminalHost({ host: candidate, groupConfigs, proxyProfiles });
  const api = await harness(original, { resolveEffectiveHost });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  groupConfigs.push({ path: 'prod', proxyProfileId: 'group-proxy' });
  assert.equal(resolveEffectiveHost(original).proxyConfig?.host, 'proxy.invalid');
  await api.update({ host: { ...original } });
  assert.equal(await api.find(), undefined);
});

for (const owner of ['saved', 'global'] as const) {
  for (const [field, changed] of [
    ['localShell', '/bin/zsh'], ['localShellArgs', ['--norc']], ['localStartDir', '/project-b'],
  ] as const) {
    test(`local launch snapshot survives ${owner} ${field} edits and unchanged defaults reuse`, async (t) => {
      const settings = { localShell: '/bin/bash', localShellArgs: undefined as string[] | undefined, localStartDir: '/project-a' };
      const original = host({ protocol: 'local', hostname: 'localhost', ...(owner === 'saved' ? settings : {}) });
      const context = {
        terminalSettings: settings,
        resolveShellSetting: (command: string, _shells: DiscoveredShell[], args?: string[]) => ({ command, args }),
      };
      const resolveEffectiveHost = (candidate: Host) => resolveHostDefaultLocalShell(candidate, context);
      const launched = { ...createHostTerminalSession('launched', resolveEffectiveHost(original)), status: 'connected' as const };
      const api = await harness(original, { sessions: [launched], resolveEffectiveHost });
      t.after(api.close);
      assert.equal((await api.find())?.sessionId, launched.id, 'undefined settings args and [] snapshot launch identically');
      const edited = owner === 'saved' ? { ...original, [field]: changed } : original;
      if (owner === 'global') Object.assign(settings, { [field]: changed });
      await api.update({ host: edited });
      assert.equal(await api.find(), undefined, 'an edited launch must not return the old process');
      const copy = resolveTerminalSessionHost({ session: launched, hosts: [edited], groupConfigs: [], proxyProfiles: [], localOs: 'linux', defaultLocalShell: context });
      assert.equal(copy.localShell, '/bin/bash');
      assert.deepEqual(copy.localShellArgs, []);
      assert.equal(copy.localStartDir, '/project-a');
    });
  }
}

test('home and backend-default snapshots do not inherit later global or saved settings', async (t) => {
  const original = host({ protocol: 'local', hostname: 'localhost' });
  const settings: { localShell?: string; localStartDir?: string } = {};
  const context = { terminalSettings: settings, resolveShellSetting: (command: string) => command ? { command } : null };
  const resolveEffectiveHost = (candidate: Host) => resolveHostDefaultLocalShell(candidate, context);
  const launched = { ...createHostTerminalSession('home-default', resolveEffectiveHost(original)), status: 'connected' as const };
  assert.equal(launched.localShell, '');
  assert.equal(launched.localStartDir, '~');
  const api = await harness(original, { sessions: [launched], resolveEffectiveHost });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, launched.id);
  Object.assign(settings, { localShell: '/bin/bash', localStartDir: '/new-global' });
  const edited = { ...original, localShell: '/bin/zsh', localStartDir: '/new-saved' };
  await api.update({ host: edited });
  assert.equal(await api.find(), undefined);
  const copied = resolveTerminalSessionHost({ session: launched, hosts: [edited], groupConfigs: [], proxyProfiles: [], localOs: 'linux', defaultLocalShell: context });
  assert.equal(copied.localShell, '', 'empty captured executable still requests backend default');
  assert.equal(copied.localStartDir, '~', 'home remains home after a new global directory');
});

test('saved discovery IDs resolve before snapshot while backend default stays independent of discovery', async (t) => {
  const saved = host({ protocol: 'local', hostname: 'localhost', localShell: 'bash' });
  const context = {
    discoveredShells: [{ id: 'bash', name: 'Bash', command: '/bin/bash', args: ['-l'], icon: 'bash', isDefault: true }],
    resolveShellSetting: (command: string) => command === 'bash' ? { command: '/bin/bash', args: ['-l'] } : null,
  };
  const resolveEffectiveHost = (candidate: Host) => resolveHostDefaultLocalShell(candidate, context);
  const launched = { ...createHostTerminalSession('discovered', resolveEffectiveHost(saved)), status: 'connected' as const };
  assert.equal(launched.localShell, '/bin/bash');
  const api = await harness(saved, { sessions: [launched], resolveEffectiveHost });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, launched.id);
  const defaultLaunch = resolveEffectiveHost({ ...saved, localShell: undefined });
  assert.equal(defaultLaunch.localShell, '');
  assert.equal(defaultLaunch.localShellArgs, undefined);
});

for (const discovered of [
  { id: 'bin-bash', name: 'Bash', command: '/bin/bash', args: ['-l'], icon: 'bash' },
  { id: 'wsl-ubuntu', name: 'Ubuntu', command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'], icon: 'ubuntu' },
]) {
  for (const owner of ['saved', 'global'] as const) {
    test(`cold ${owner} ${discovered.id} reuses after discovery without masking edits`, async (t) => {
      const settings = { localShell: discovered.id, localStartDir: '/project-a' };
      const original = host({ protocol: 'local', hostname: 'localhost', ...(owner === 'saved' ? settings : {}) });
      const context = { terminalSettings: settings, discoveredShells: [] as DiscoveredShell[], resolveShellSetting };
      const resolveEffectiveHost = (candidate: Host) => resolveHostDefaultLocalShell(candidate, context);
      const launched = { ...createHostTerminalSession('cold', resolveEffectiveHost(original)), status: 'connected' as const };
      assert.equal(launched.localShell, discovered.id);
      const api = await harness(original, { sessions: [launched], resolveEffectiveHost });
      t.after(api.close);
      assert.equal((await api.find())?.sessionId, launched.id);
      context.discoveredShells = [discovered];
      await api.update({ host: { ...original } });
      assert.equal((await api.find())?.sessionId, launched.id, 'discovery resolves the same executable and default arguments');
      const edited = { ...original, localShell: discovered.command, localShellArgs: ['--edited'], localStartDir: '/project-b' };
      await api.update({ host: edited });
      assert.equal(await api.find(), undefined, 'a real path/argument/directory edit still opens a new session');
      const copy = resolveTerminalSessionHost({ session: launched, hosts: [edited], groupConfigs: [], proxyProfiles: [], localOs: 'linux', defaultLocalShell: context });
      assert.equal(copy.localShell, discovered.id);
      assert.deepEqual(copy.localShellArgs, []);
      assert.equal(copy.localStartDir, '/project-a');
    });
  }
}

test('discovery does not replace an explicit executable or its custom arguments with an alias', async (t) => {
  const original = host({ protocol: 'local', hostname: 'localhost', localShell: '/bin/bash', localShellArgs: ['--norc'] });
  const context = { discoveredShells: [] as DiscoveredShell[], resolveShellSetting };
  const resolveEffectiveHost = (candidate: Host) => resolveHostDefaultLocalShell(candidate, context);
  const api = await harness(original, { resolveEffectiveHost });
  t.after(api.close);
  context.discoveredShells = [{ id: 'bin-bash', name: 'Bash', command: '/bin/bash', args: ['-l'], icon: 'bash' }];
  await api.update({ host: { ...original } });
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ host: { ...original, localShell: 'bin-bash', localShellArgs: undefined } });
  assert.equal(await api.find(), undefined, 'selecting discovered login defaults changes the actual launch');
});
