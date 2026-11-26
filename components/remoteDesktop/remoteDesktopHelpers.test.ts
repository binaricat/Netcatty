import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleTerminalDataCaptureImpl,
  stampRemoteDesktopSessionEndTimes,
} from '../../application/app/AppHandlers';
import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
import type { ConnectionLog } from '../../domain/models';
import type { Host, TerminalSession } from '../../types';
import {
  canOpenCompanionRemoteDesktopSftp,
  computeClipboardUploadProgress,
  formatRecordingDuration,
  formatTransferBytes,
} from './remoteDesktopHelpers';

test('formatTransferBytes formats zero, bytes, KB, MB, and GB cleanly', () => {
  assert.equal(formatTransferBytes(0), '0 B');
  assert.equal(formatTransferBytes(-42), '0 B');
  assert.equal(formatTransferBytes(Number.NaN), '0 B');
  assert.equal(formatTransferBytes(512), '512 B');
  assert.equal(formatTransferBytes(1024), '1 KB');
  assert.equal(formatTransferBytes(1536), '1.5 KB');
  assert.equal(formatTransferBytes(1024 * 1024 * 2.5), '2.5 MB');
  assert.equal(formatTransferBytes(1024 * 1024 * 1024 * 1.25), '1.25 GB');
});

test('computeClipboardUploadProgress aggregates multi-file high-water offsets without NaN', () => {
  const files = [{ size: 1000 }, { size: 3000 }];
  const hw = new Map<number, number>([
    [0, 1000],
    [1, 1000],
  ]);
  assert.deepEqual(computeClipboardUploadProgress(files, hw), {
    transferredBytes: 2000,
    totalBytes: 4000,
    percent: 50,
  });

  // Clamps over-reported offsets to individual file size
  hw.set(0, 9999);
  hw.set(1, 3000);
  assert.deepEqual(computeClipboardUploadProgress(files, hw), {
    transferredBytes: 4000,
    totalBytes: 4000,
    percent: 100,
  });

  // 0-byte file completes cleanly without NaN
  assert.deepEqual(computeClipboardUploadProgress([{ size: 0 }], new Map()), {
    transferredBytes: 0,
    totalBytes: 0,
    percent: 0,
  });
  assert.deepEqual(computeClipboardUploadProgress([{ size: 0 }], new Map([[0, 0]])), {
    transferredBytes: 0,
    totalBytes: 0,
    percent: 100,
  });
});

test('canOpenCompanionRemoteDesktopSftp gates SSH/Mosh/ET companions vs standalone, telnet, and plugin hosts', () => {
  const host = (protocol?: Host['protocol']): Pick<Host, 'protocol'> => ({ protocol });

  assert.equal(canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: true }, host(undefined)), true);
  assert.equal(canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: true }, host('ssh')), true);
  assert.equal(canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: true }, host('mosh')), true);
  assert.equal(canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: true }, host('et')), true);

  assert.equal(canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: false }, host('ssh')), false);
  assert.equal(canOpenCompanionRemoteDesktopSftp({}, host('rdp')), false);
  assert.equal(canOpenCompanionRemoteDesktopSftp({}, host('vnc')), false);
  assert.equal(canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: true }, host('telnet')), false);
  assert.equal(
    canOpenCompanionRemoteDesktopSftp({ remoteDesktopCompanion: true }, host('plugin:acme:proto' as Host['protocol'])),
    false,
  );
});

test('formatRecordingDuration renders MM:SS and HH:MM:SS', () => {
  assert.equal(formatRecordingDuration(0), '00:00');
  assert.equal(formatRecordingDuration(-100), '00:00');
  assert.equal(formatRecordingDuration(65_000), '01:05');
  assert.equal(formatRecordingDuration(3_723_000), '1:02:03');
});

test('stampRemoteDesktopSessionEndTimes and handleTerminalDataCaptureImpl stamp endTime on RDP/VNC close', async () => {
  const updates: Array<{ id: string; patch: Partial<ConnectionLog> }> = [];
  const logs: ConnectionLog[] = [
    {
      id: 'log-rdp',
      sessionId: 'sess-rdp',
      hostId: 'h1',
      hostLabel: 'Win RDP',
      hostname: '10.0.0.10',
      username: 'admin',
      protocol: 'rdp',
      startTime: 1000,
      localUsername: 'u',
      localHostname: 'l',
      saved: false,
    },
    {
      id: 'log-ssh',
      sessionId: 'sess-ssh',
      hostId: 'h2',
      hostLabel: 'Linux SSH',
      hostname: '10.0.0.11',
      username: 'root',
      protocol: 'ssh',
      startTime: 1000,
      localUsername: 'u',
      localHostname: 'l',
      saved: false,
    },
  ];
  const sessions = [
    { id: 'sess-rdp', protocol: 'rdp', hostname: '10.0.0.10' },
    { id: 'sess-ssh', protocol: 'ssh', hostname: '10.0.0.11' },
  ] as unknown as TerminalSession[];

  const stamped = stampRemoteDesktopSessionEndTimes(
    () => ({
      sessions,
      connectionLogs: logs,
      updateConnectionLog: (id: string, patch: Partial<ConnectionLog>) => {
        updates.push({ id, patch });
      },
    }),
    ['sess-rdp', 'sess-ssh'],
  );

  assert.equal(stamped, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'log-rdp');
  assert.ok(typeof updates[0].patch.endTime === 'number' && updates[0].patch.endTime > 0);
  assert.equal('terminalData' in updates[0].patch, false);

  updates.length = 0;
  await handleTerminalDataCaptureImpl(
    () => ({
      IS_DEV: false,
      sessions,
      connectionLogs: logs,
      selectConnectionLogForTerminalDataCapture,
      updateConnectionLog: (id: string, patch: Partial<ConnectionLog>) => {
        updates.push({ id, patch });
      },
    }),
    'sess-rdp',
    '',
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'log-rdp');
  assert.ok(typeof updates[0].patch.endTime === 'number' && updates[0].patch.endTime > 0);
  assert.equal('terminalData' in updates[0].patch, false);
});
