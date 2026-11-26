import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTerminalPopupHost,
  resolveTerminalPopupRemoteDesktopProtocol,
} from '../TerminalPopupPage';
import { resolveRemoteDesktopConnectionSpec } from '../../domain/remoteDesktop';
import { isAutoReconnectableSshHost } from '../../application/state/terminalAutoReconnect';
import type { Host } from '../../domain/models';
import type { TerminalPopupPayload } from '../../domain/systemManager/types';

test('companion RDP pop-out preserves underlying SSH host and tunnelViaHostSsh', () => {
  const sshHost: Host = {
    id: 'ssh-host-1',
    label: 'Prod Bastion',
    hostname: '10.0.0.5',
    port: 2222,
    username: 'ubuntu',
    identityId: 'id-ssh-1',
    protocol: 'ssh',
    tags: [],
    os: 'linux',
    rdpConfig: {
      enabled: true,
      port: 3390,
      tunnelViaHostSsh: true,
      tunnelTargetHost: '127.0.0.1',
      username: 'Administrator',
    },
  };

  const payload: TerminalPopupPayload = {
    title: 'Prod Bastion (RDP)',
    parentSessionId: 'sess-1',
    startupCommand: '',
    sourceSession: {
      id: 'sess-1',
      hostId: sshHost.id,
      hostLabel: 'Prod Bastion (RDP)',
      hostname: sshHost.hostname,
      username: 'Administrator',
      status: 'connected',
      protocol: 'rdp',
      port: 3390,
      remoteDesktopCompanion: true,
      rdpConfig: sshHost.rdpConfig,
    },
  };

  const popupHost = resolveTerminalPopupHost(payload, [sshHost]);
  const remoteProtocol = resolveTerminalPopupRemoteDesktopProtocol(payload, popupHost);

  assert.equal(remoteProtocol, 'rdp');
  assert.equal(popupHost.protocol, 'ssh');
  assert.equal(popupHost.port, 2222);
  assert.equal(popupHost.username, 'ubuntu');
  assert.equal(popupHost.identityId, 'id-ssh-1');

  const spec = resolveRemoteDesktopConnectionSpec(popupHost, 'rdp');
  assert.equal(spec.isCompanion, true);
  assert.equal(spec.tunnelViaHostSsh, true);
  assert.equal(spec.port, 3390);
  assert.equal(spec.hostname, '127.0.0.1');
  assert.equal(spec.hostHostname, '10.0.0.5');
  assert.equal(spec.username, 'Administrator');
});

test('companion VNC pop-out preserves underlying SSH host and tunnelViaHostSsh', () => {
  const sshHost: Host = {
    id: 'ssh-host-2',
    label: 'Linux Workstation',
    hostname: '192.168.10.20',
    port: 22,
    username: 'alice',
    protocol: 'ssh',
    tags: [],
    os: 'linux',
    vncConfig: {
      enabled: true,
      port: 5901,
      tunnelViaHostSsh: true,
    },
  };

  const payload: TerminalPopupPayload = {
    title: 'Linux Workstation (VNC)',
    parentSessionId: 'sess-2',
    startupCommand: '',
    sourceSession: {
      id: 'sess-2',
      hostId: sshHost.id,
      hostLabel: 'Linux Workstation (VNC)',
      hostname: sshHost.hostname,
      username: '',
      status: 'connected',
      protocol: 'vnc',
      port: 5901,
      remoteDesktopCompanion: true,
      vncConfig: sshHost.vncConfig,
    },
  };

  const popupHost = resolveTerminalPopupHost(payload, [sshHost]);
  const remoteProtocol = resolveTerminalPopupRemoteDesktopProtocol(payload, popupHost);

  assert.equal(remoteProtocol, 'vnc');
  assert.equal(popupHost.protocol, 'ssh');
  assert.equal(popupHost.port, 22);
  assert.equal(popupHost.username, 'alice');

  const spec = resolveRemoteDesktopConnectionSpec(popupHost, 'vnc');
  assert.equal(spec.isCompanion, true);
  assert.equal(spec.tunnelViaHostSsh, true);
  assert.equal(spec.port, 5901);
  assert.equal(spec.hostname, '127.0.0.1');
  assert.equal(spec.hostHostname, '192.168.10.20');
});

test('standalone RDP pop-out resolves direct RDP host without companion SSH tunneling', () => {
  const rdpHost: Host = {
    id: 'rdp-host-1',
    label: 'Windows Server',
    hostname: '10.1.2.3',
    port: 3389,
    username: 'admin',
    protocol: 'rdp',
    tags: [],
    os: 'windows',
    rdpConfig: {
      port: 3389,
      domain: 'CORP',
    },
  };

  const payload: TerminalPopupPayload = {
    title: 'Windows Server',
    parentSessionId: 'sess-3',
    startupCommand: '',
    sourceSession: {
      id: 'sess-3',
      hostId: rdpHost.id,
      hostLabel: 'Windows Server',
      hostname: rdpHost.hostname,
      username: 'admin',
      status: 'connected',
      protocol: 'rdp',
      port: 3389,
      rdpConfig: rdpHost.rdpConfig,
    },
  };

  const popupHost = resolveTerminalPopupHost(payload, [rdpHost]);
  const remoteProtocol = resolveTerminalPopupRemoteDesktopProtocol(payload, popupHost);

  assert.equal(remoteProtocol, 'rdp');
  assert.equal(popupHost.protocol, 'rdp');
  assert.equal(popupHost.port, 3389);

  const spec = resolveRemoteDesktopConnectionSpec(popupHost, 'rdp');
  assert.equal(spec.isCompanion, false);
  assert.equal(spec.tunnelViaHostSsh, false);
  assert.equal(spec.domain, 'CORP');
});

test('isAutoReconnectableSshHost excludes vnc and rdp hosts cleanly', () => {
  assert.equal(isAutoReconnectableSshHost({ protocol: 'rdp', hostname: '10.0.0.1' }), false);
  assert.equal(isAutoReconnectableSshHost({ protocol: 'vnc', hostname: '10.0.0.1' }), false);
  assert.equal(isAutoReconnectableSshHost({ protocol: 'ssh', hostname: '10.0.0.1' }), true);
});
