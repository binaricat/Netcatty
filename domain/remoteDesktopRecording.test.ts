import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionLog, RemoteDesktopRecordingClip } from './models/history';
import {
  MAX_REMOTE_DESKTOP_SESSION_EVENTS,
  appendRemoteDesktopSessionEvent,
  buildAppendRecordingClipUpdate,
  buildClearRecordingsUpdate,
  buildRemoveRecordingClipUpdate,
  findRecordingSeekTargetForEvent,
  getConnectionLogMediaIds,
  getConnectionLogRecordingClips,
  getConnectionLogRecordingSummary,
  mergeRemoteDesktopSessionMetadata,
  resolveVideoSeekSecondsForEvent,
} from './remoteDesktopRecording';

function makeBaseLog(overrides: Partial<ConnectionLog> = {}): ConnectionLog {
  return {
    id: 'log-1',
    sessionId: 'sess-1',
    hostId: 'h-1',
    hostLabel: 'Win Prod',
    hostname: '10.0.0.10',
    username: 'Administrator',
    protocol: 'rdp',
    startTime: 1_700_000_000_000,
    localUsername: 'alice',
    localHostname: 'macbook',
    saved: false,
    ...overrides,
  };
}

test('getConnectionLogRecordingClips upgrades legacy single recordingId seamlessly', () => {
  const legacy = makeBaseLog({
    endTime: 1_700_000_060_000,
    recordingId: '11111111-1111-4111-8111-111111111111',
    recordingMimeType: 'video/webm;codecs=vp9',
    recordingDurationMs: 45_000,
    recordingBytes: 2_000_000,
    recordingHasAudio: true,
  });

  const clips = getConnectionLogRecordingClips(legacy);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].id, '11111111-1111-4111-8111-111111111111');
  assert.equal(clips[0].durationMs, 45_000);
  assert.equal(clips[0].bytes, 2_000_000);
  assert.equal(clips[0].hasAudio, true);
  assert.equal(clips[0].startedAt, 1_700_000_015_000);
  assert.equal(clips[0].endedAt, 1_700_000_060_000);
});

test('multi-clip append and remove preserve earlier clips and keep legacy mirror fields accurate', () => {
  const clip1: RemoteDesktopRecordingClip = {
    id: '11111111-1111-4111-8111-111111111111',
    startedAt: 1_700_000_010_000,
    endedAt: 1_700_000_030_000,
    durationMs: 20_000,
    bytes: 1_000_000,
    mimeType: 'video/webm;codecs=vp9',
    hasAudio: false,
    hasThumbnail: true,
    width: 1920,
    height: 1080,
  };
  const clip2: RemoteDesktopRecordingClip = {
    id: '22222222-2222-4222-8222-222222222222',
    startedAt: 1_700_000_050_000,
    endedAt: 1_700_000_090_000,
    durationMs: 40_000,
    bytes: 2_500_000,
    mimeType: 'video/webm;codecs=vp9,opus',
    hasAudio: true,
    hasThumbnail: true,
    width: 1920,
    height: 1080,
  };

  let log = makeBaseLog();
  log = { ...log, ...buildAppendRecordingClipUpdate(log, clip1) };
  assert.equal(log.recordingId, clip1.id);
  assert.equal(log.recordings?.length, 1);

  log = { ...log, ...buildAppendRecordingClipUpdate(log, clip2) };
  assert.equal(log.recordings?.length, 2);
  assert.equal(log.recordingId, clip2.id);
  assert.equal(log.recordingDurationMs, 60_000);
  assert.equal(log.recordingBytes, 3_500_000);
  assert.equal(log.recordingHasAudio, true);

  const summary = getConnectionLogRecordingSummary(log);
  assert.equal(summary.clipCount, 2);
  assert.equal(summary.totalDurationMs, 60_000);
  assert.equal(summary.totalBytes, 3_500_000);
  assert.equal(summary.hasAudio, true);

  // Removing clip2 falls back to clip1
  log = { ...log, ...buildRemoveRecordingClipUpdate(log, clip2.id) };
  assert.equal(log.recordings?.length, 1);
  assert.equal(log.recordingId, clip1.id);
  assert.equal(log.recordingHasAudio, false);

  // Removing clip1 clears all recording fields
  log = { ...log, ...buildRemoveRecordingClipUpdate(log, clip1.id) };
  assert.equal(log.recordings, undefined);
  assert.equal(log.recordingId, undefined);
  assert.equal(log.recordingBytes, undefined);
});

test('getConnectionLogMediaIds collects all clip IDs and session thumbnailId', () => {
  const log = makeBaseLog({
    recordings: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
        bytes: 100,
        mimeType: 'video/webm',
        hasAudio: false,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        startedAt: 3000,
        endedAt: 4000,
        durationMs: 1000,
        bytes: 200,
        mimeType: 'video/webm',
        hasAudio: false,
      },
    ],
    remoteDesktopMeta: {
      thumbnailId: '33333333-3333-4333-8333-333333333333',
    },
  });

  assert.deepEqual(getConnectionLogMediaIds(log).sort(), [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]);
});

test('buildClearRecordingsUpdate preserves protected media and clears unprotected metadata', () => {
  const protectedId = '11111111-1111-4111-8111-111111111111';
  const unprotectedId = '22222222-2222-4222-8222-222222222222';
  const log = makeBaseLog({
    recordings: [
      {
        id: protectedId,
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
        bytes: 100,
        mimeType: 'video/webm',
        hasAudio: false,
      },
      {
        id: unprotectedId,
        startedAt: 3000,
        endedAt: 4000,
        durationMs: 1000,
        bytes: 200,
        mimeType: 'video/webm',
        hasAudio: false,
      },
    ],
    recordingId: unprotectedId,
    remoteDesktopMeta: {
      resolution: { width: 1920, height: 1080 },
      thumbnailId: '33333333-3333-4333-8333-333333333333',
    },
  });

  const updates = buildClearRecordingsUpdate(log, new Set([protectedId]));
  assert.ok(updates);
  assert.equal(updates.recordings?.length, 1);
  assert.equal(updates.recordingId, protectedId);
  assert.equal(updates.remoteDesktopMeta?.thumbnailId, undefined);
  assert.deepEqual(updates.remoteDesktopMeta?.resolution, { width: 1920, height: 1080 });
});

test('appendRemoteDesktopSessionEvent enforces event cap and trims long text', () => {
  let events = appendRemoteDesktopSessionEvent(undefined, {
    timestamp: 1000,
    kind: 'connected',
    summary: '   Connected to RDP   ',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Connected to RDP');

  for (let i = 0; i < MAX_REMOTE_DESKTOP_SESSION_EVENTS + 25; i += 1) {
    events = appendRemoteDesktopSessionEvent(events, {
      timestamp: 2000 + i,
      kind: 'resized',
      summary: `Resized #${i}`,
    });
  }
  assert.equal(events.length, MAX_REMOTE_DESKTOP_SESSION_EVENTS);
  assert.equal(events[events.length - 1].summary, `Resized #${MAX_REMOTE_DESKTOP_SESSION_EVENTS + 24}`);
});

test('resolveVideoSeekSecondsForEvent and findRecordingSeekTargetForEvent map event timestamps to clips', () => {
  const clips: RemoteDesktopRecordingClip[] = [
    {
      id: 'clip-a',
      startedAt: 10_000,
      endedAt: 30_000,
      durationMs: 20_000,
      bytes: 100,
      mimeType: 'video/webm',
      hasAudio: false,
    },
    {
      id: 'clip-b',
      startedAt: 60_000,
      endedAt: 120_000,
      durationMs: 60_000,
      bytes: 200,
      mimeType: 'video/webm',
      hasAudio: true,
    },
  ];

  assert.equal(resolveVideoSeekSecondsForEvent(clips[0], 15_500), 5.5);
  assert.equal(resolveVideoSeekSecondsForEvent(clips[0], 45_000), null);

  assert.deepEqual(findRecordingSeekTargetForEvent(clips, 75_000), {
    clipId: 'clip-b',
    offsetSeconds: 15,
  });
  assert.equal(findRecordingSeekTargetForEvent(clips, 45_000), null);
});

test('mergeRemoteDesktopSessionMetadata preserves previous fields when patching', () => {
  const merged = mergeRemoteDesktopSessionMetadata(
    { resolution: { width: 1280, height: 720 }, tunneled: true },
    { securityLabel: 'TLS / NLA', monitorCount: 2 },
  );
  assert.deepEqual(merged, {
    resolution: { width: 1280, height: 720 },
    tunneled: true,
    securityLabel: 'TLS / NLA',
    monitorCount: 2,
  });
});
