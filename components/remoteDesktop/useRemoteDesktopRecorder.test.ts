import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JSDOM } from 'jsdom';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import {
  publishConnectionLogsSnapshot,
  registerConnectionLogsActions,
} from '../../application/state/connectionLogsStore';
import type { ConnectionLog } from '../../domain/models';
import {
  STORAGE_KEY_REMOTE_DESKTOP_AUTO_RECORD,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_FPS,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_INCLUDE_AUDIO,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_MAX_MB,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_RETENTION_DAYS,
} from '../../infrastructure/config/storageKeys';
import type { RemoteDesktopCanvasHandle } from './remoteDesktopHelpers';
import {
  pickRemoteDesktopRecordingMimeType,
  readRemoteDesktopRecordingSettings,
  resolveRecordingVideoBitsPerSecond,
  useRemoteDesktopRecorder,
  type RemoteDesktopRecordingsApi,
  type UseRemoteDesktopRecorderResult,
} from './useRemoteDesktopRecorder';

function installDomEnv() {
  const dom = new JSDOM('', { url: 'http://localhost' });
  const keys = ['window', 'document', 'localStorage', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT', 'MediaRecorder'] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    CustomEvent: { value: dom.window.CustomEvent, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  return {
    dom,
    restore: () => {
      dom.window.close();
      for (const key of keys) {
        const desc = previous.get(key);
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

class FakeMediaRecorder {
  static supportedMimes = new Set<string>(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm']);
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(mime: string): boolean {
    return FakeMediaRecorder.supportedMimes.has(mime);
  }

  public state: 'inactive' | 'recording' | 'paused' = 'inactive';
  public mimeType: string;
  public videoBitsPerSecond: number | undefined;
  public timeslice: number | undefined;
  public ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<() => void>>();

  constructor(public stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'video/webm';
    this.videoBitsPerSecond = options?.videoBitsPerSecond;
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, cb: () => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }

  start(timeslice?: number) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }

  emitChunk(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: this.mimeType });
    this.ondataavailable?.({ data: blob });
  }

  requestData() {
    this.emitChunk(new Uint8Array([1, 2, 3, 4]));
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    const set = this.listeners.get('stop');
    if (set) {
      for (const cb of [...set]) cb();
      set.clear();
    }
  }
}

function createFakeStream(includeAudio: boolean) {
  let stoppedTracks = 0;
  const makeTrack = (kind: 'video' | 'audio') => ({
    kind,
    stop: () => { stoppedTracks += 1; },
  });
  const videoTracks = [makeTrack('video')];
  const audioTracks = includeAudio ? [makeTrack('audio')] : [];
  const stream = {
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    getTracks: () => [...videoTracks, ...audioTracks],
  } as unknown as MediaStream;
  return { stream, getStoppedTracks: () => stoppedTracks };
}

function createFakeBridge(overrides?: Partial<RemoteDesktopRecordingsApi>) {
  const calls = {
    begin: [] as Array<{ mimeType?: string; hostLabel?: string; protocol: 'rdp' | 'vnc' }>,
    append: [] as Array<{ recordingId: string; chunkLen: number }>,
    finish: [] as Array<{
      recordingId: string;
      durationMs: number;
      hasAudio?: boolean;
      maxBytes?: number;
      retentionDays?: number;
      protectedIds?: string[];
    }>,
    abort: [] as Array<{ recordingId: string }>,
  };

  const bridge: RemoteDesktopRecordingsApi = {
    begin: async (opts) => {
      calls.begin.push(opts);
      return { recordingId: 'rec-test-1' };
    },
    append: async (opts) => {
      calls.append.push({ recordingId: opts.recordingId, chunkLen: opts.chunk.byteLength });
      return { bytesWritten: opts.chunk.byteLength };
    },
    finish: async (opts) => {
      calls.finish.push(opts);
      return {
        recordingId: opts.recordingId,
        bytes: calls.append.reduce((sum, item) => sum + item.chunkLen, 0),
        durationMs: opts.durationMs,
        playbackUrl: `netcatty-media://recording/${opts.recordingId}`,
      };
    },
    abort: async (opts) => {
      calls.abort.push(opts);
      return { ok: true };
    },
    ...overrides,
  };

  return { bridge, calls };
}

test('resolveRecordingVideoBitsPerSecond scales bitrate for 5/10/15 FPS', () => {
  assert.equal(resolveRecordingVideoBitsPerSecond(5), 1_000_000);
  assert.equal(resolveRecordingVideoBitsPerSecond(10), 1_800_000);
  assert.equal(resolveRecordingVideoBitsPerSecond(15), 2_500_000);
});

test('pickRemoteDesktopRecordingMimeType selects preferred WebM codecs with audio fallback', () => {
  assert.equal(
    pickRemoteDesktopRecordingMimeType(true, (m) => m === 'video/webm;codecs=vp8,opus' || m === 'video/webm'),
    'video/webm;codecs=vp8,opus',
  );
  assert.equal(
    pickRemoteDesktopRecordingMimeType(false, (m) => m === 'video/webm;codecs=vp9'),
    'video/webm;codecs=vp9',
  );
  assert.equal(pickRemoteDesktopRecordingMimeType(true, () => false), '');
});

test('readRemoteDesktopRecordingSettings reads defaults and persisted overrides', () => {
  const env = installDomEnv();
  try {
    assert.deepEqual(readRemoteDesktopRecordingSettings(), {
      autoRecord: false,
      fps: 10,
      includeAudio: true,
      maxMb: 1024,
      retentionDays: 30,
    });

    globalThis.localStorage.setItem(STORAGE_KEY_REMOTE_DESKTOP_AUTO_RECORD, 'true');
    globalThis.localStorage.setItem(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_FPS, '15');
    globalThis.localStorage.setItem(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_INCLUDE_AUDIO, 'false');
    globalThis.localStorage.setItem(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_MAX_MB, '512');
    globalThis.localStorage.setItem(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_RETENTION_DAYS, '7');

    assert.deepEqual(readRemoteDesktopRecordingSettings(), {
      autoRecord: true,
      fps: 15,
      includeAudio: false,
      maxMb: 512,
      retentionDays: 7,
    });
  } finally {
    env.restore();
  }
});

test('useRemoteDesktopRecorder streams chunks, finishes with protectedIds, and updates ConnectionLog', async () => {
  const env = installDomEnv();
  FakeMediaRecorder.instances = [];
  Object.defineProperty(globalThis, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true });

  const logUpdates: Array<{ id: string; updates: Partial<ConnectionLog> }> = [];
  publishConnectionLogsSnapshot({
    connectionLogs: [
      {
        id: 'log-saved-other',
        sessionId: 'sess-old',
        hostId: 'h0',
        hostLabel: 'Old RDP',
        hostname: '10.0.0.1',
        username: 'admin',
        protocol: 'rdp',
        startTime: 1000,
        endTime: 2000,
        localUsername: 'u',
        localHostname: 'l',
        saved: true,
        recordingId: 'rec-protected-99',
      },
      {
        id: 'log-active-rdp',
        sessionId: 'sess-rdp-1',
        hostId: 'h1',
        hostLabel: 'Win Server',
        hostname: '10.0.0.2',
        username: 'Administrator',
        protocol: 'rdp',
        startTime: 5000,
        localUsername: 'u',
        localHostname: 'l',
        saved: false,
      },
    ],
  });
  registerConnectionLogsActions({
    updateConnectionLog: (id, updates) => { logUpdates.push({ id, updates }); },
    toggleConnectionLogSaved: () => {},
    deleteConnectionLog: () => {},
    clearUnsavedConnectionLogs: () => {},
  });

  const { bridge, calls } = createFakeBridge();
  const fakeStream = createFakeStream(true);
  let recorderApi!: UseRemoteDesktopRecorderResult;
  let root: ReactTestRenderer | undefined;

  function Harness({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
    const canvasRef = useRef<RemoteDesktopCanvasHandle | null>({
      sendSpecialKey: () => {},
      typeText: () => {},
      releaseAllInputs: () => {},
      captureScreenshot: async () => null,
      getCaptureStream: () => fakeStream.stream,
    });
    recorderApi = useRemoteDesktopRecorder({
      sessionId: 'sess-rdp-1',
      protocol: 'rdp',
      hostLabel: 'Win Server',
      status,
      audioEnabled: true,
      canvasHandleRef: canvasRef,
      recordingsBridgeOverride: bridge,
    });
    return null;
  }

  try {
    await act(async () => {
      root = create(
        React.createElement(I18nProvider, {
          locale: 'en',
          children: React.createElement(Harness, { status: 'connected' }),
        }),
      );
    });

    assert.equal(recorderApi.isRecording, false);
    assert.equal(recorderApi.isSupported, true);

    await act(async () => {
      const started = await recorderApi.startRecording({ silent: true });
      assert.equal(started, true);
    });

    assert.equal(recorderApi.isRecording, true);
    assert.equal(calls.begin.length, 1);
    assert.equal(calls.begin[0].protocol, 'rdp');
    assert.equal(FakeMediaRecorder.instances.length, 1);
    assert.equal(FakeMediaRecorder.instances[0].timeslice, 2000);
    assert.equal(FakeMediaRecorder.instances[0].videoBitsPerSecond, 1_800_000);

    await act(async () => {
      FakeMediaRecorder.instances[0].emitChunk(new Uint8Array([10, 20, 30, 40, 50]));
      await recorderApi.stopRecording({ silent: true });
    });

    assert.equal(recorderApi.isRecording, false);
    assert.equal(fakeStream.getStoppedTracks(), 2);
    assert.equal(calls.append.length, 2); // 5B + 4B from requestData
    assert.equal(calls.finish.length, 1);
    assert.deepEqual(calls.finish[0].protectedIds, ['rec-protected-99']);
    assert.equal(calls.finish[0].hasAudio, true);
    assert.equal(calls.finish[0].maxBytes, 1024 * 1024 * 1024);
    assert.equal(calls.finish[0].retentionDays, 30);

    assert.equal(logUpdates.length, 1);
    assert.equal(logUpdates[0].id, 'log-active-rdp');
    assert.equal(logUpdates[0].updates.recordingId, 'rec-test-1');
    assert.equal(logUpdates[0].updates.recordingHasAudio, true);
    assert.equal(logUpdates[0].updates.recordingBytes, 9);
  } finally {
    await act(async () => { root?.unmount(); });
    registerConnectionLogsActions(null);
    publishConnectionLogsSnapshot({ connectionLogs: [] });
    env.restore();
  }
});

test('useRemoteDesktopRecorder aborts cleanly when chunk append fails', async () => {
  const env = installDomEnv();
  FakeMediaRecorder.instances = [];
  Object.defineProperty(globalThis, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true });

  const { bridge, calls } = createFakeBridge({
    append: async () => {
      throw new Error('ENOSPC: disk full');
    },
  });
  const fakeStream = createFakeStream(false);
  let recorderApi!: UseRemoteDesktopRecorderResult;
  let root: ReactTestRenderer | undefined;

  function Harness() {
    const canvasRef = useRef<RemoteDesktopCanvasHandle | null>({
      sendSpecialKey: () => {},
      typeText: () => {},
      releaseAllInputs: () => {},
      captureScreenshot: async () => null,
      getCaptureStream: () => fakeStream.stream,
    });
    recorderApi = useRemoteDesktopRecorder({
      sessionId: 'sess-vnc-1',
      protocol: 'vnc',
      hostLabel: 'Ubuntu VNC',
      status: 'connected',
      audioEnabled: false,
      canvasHandleRef: canvasRef,
      recordingsBridgeOverride: bridge,
    });
    return null;
  }

  try {
    await act(async () => {
      root = create(
        React.createElement(I18nProvider, {
          locale: 'en',
          children: React.createElement(Harness),
        }),
      );
    });

    await act(async () => {
      await recorderApi.startRecording({ silent: true });
      FakeMediaRecorder.instances[0].emitChunk(new Uint8Array([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 10));
    });

    assert.equal(recorderApi.isRecording, false);
    assert.equal(calls.finish.length, 0);
    assert.equal(calls.abort.length, 1);
    assert.equal(calls.abort[0].recordingId, 'rec-test-1');
  } finally {
    await act(async () => { root?.unmount(); });
    env.restore();
  }
});

test('useRemoteDesktopRecorder preserves multiple clips, captures thumbnails, disposes capture, and flushes on app shutdown', async () => {
  const env = installDomEnv();
  FakeMediaRecorder.instances = [];
  Object.defineProperty(globalThis, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true });

  const finalizers = new Set<() => void | Promise<void>>();
  let finalizerUnsubscribed = false;
  (globalThis.window as unknown as Record<string, unknown>).netcatty = {
    onFinalizeSessionLogs: (fn: () => void | Promise<void>) => {
      finalizers.add(fn);
      return () => {
        finalizerUnsubscribed = true;
        finalizers.delete(fn);
      };
    },
  };

  let currentLog: ConnectionLog = {
    id: 'log-multi-rdp',
    sessionId: 'sess-multi',
    hostId: 'h1',
    hostLabel: 'Win Multi',
    hostname: '10.0.0.9',
    username: 'Administrator',
    protocol: 'rdp',
    startTime: 10_000,
    localUsername: 'u',
    localHostname: 'l',
    saved: false,
  };
  publishConnectionLogsSnapshot({ connectionLogs: [currentLog] });
  registerConnectionLogsActions({
    updateConnectionLog: (_id, updates) => {
      currentLog = { ...currentLog, ...updates };
      publishConnectionLogsSnapshot({ connectionLogs: [currentLog] });
    },
    toggleConnectionLogSaved: () => {},
    deleteConnectionLog: () => {},
    clearUnsavedConnectionLogs: () => {},
  });

  let nextId = 0;
  const savedThumbs: string[] = [];
  const { bridge } = createFakeBridge({
    begin: async () => ({ recordingId: `11111111-1111-4111-8111-11111111111${++nextId}` }),
    saveThumbnail: async (opts) => {
      savedThumbs.push(opts.id || '');
      return { ok: true, id: opts.id, bytes: opts.data.byteLength };
    },
  });

  let disposeCount = 0;
  let recorderApi!: UseRemoteDesktopRecorderResult;
  let root: ReactTestRenderer | undefined;

  function Harness() {
    const canvasRef = useRef<RemoteDesktopCanvasHandle | null>({
      sendSpecialKey: () => {},
      typeText: () => {},
      releaseAllInputs: () => {},
      captureScreenshot: async () => null,
      captureThumbnailJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      createRecordingCapture: () => {
        const fake = createFakeStream(false);
        return {
          stream: fake.stream,
          width: 1920,
          height: 1080,
          dispose: () => {
            disposeCount += 1;
            fake.stream.getTracks().forEach((track) => track.stop());
          },
        };
      },
    });
    recorderApi = useRemoteDesktopRecorder({
      sessionId: 'sess-multi',
      protocol: 'rdp',
      hostLabel: 'Win Multi',
      status: 'connected',
      audioEnabled: false,
      canvasHandleRef: canvasRef,
      recordingsBridgeOverride: bridge,
    });
    return null;
  }

  try {
    await act(async () => {
      root = create(
        React.createElement(I18nProvider, {
          locale: 'en',
          children: React.createElement(Harness),
        }),
      );
    });

    // Clip 1: manual start + stop
    await act(async () => {
      await recorderApi.startRecording({ silent: true });
      FakeMediaRecorder.instances[0].emitChunk(new Uint8Array([1, 2, 3]));
      await recorderApi.stopRecording({ silent: true });
    });

    assert.equal(currentLog.recordings?.length, 1);
    assert.equal(currentLog.recordings?.[0].hasThumbnail, true);
    assert.equal(currentLog.recordings?.[0].width, 1920);
    assert.equal(savedThumbs.length, 1);

    // Clip 2: start then flush via app shutdown finalizer (onFinalizeSessionLogs)
    await act(async () => {
      await recorderApi.startRecording({ silent: true });
      FakeMediaRecorder.instances[1].emitChunk(new Uint8Array([4, 5, 6, 7]));
      for (const fn of finalizers) {
        await fn();
      }
    });

    assert.equal(recorderApi.isRecording, false);
    assert.equal(currentLog.recordings?.length, 2);
    assert.equal(currentLog.recordings?.[0].id, '11111111-1111-4111-8111-111111111111');
    assert.equal(currentLog.recordings?.[1].id, '11111111-1111-4111-8111-111111111112');
    assert.ok(disposeCount >= 2, 'capture dispose() should run for every clip');
  } finally {
    await act(async () => { root?.unmount(); });
    assert.equal(finalizerUnsubscribed, true, 'shutdown finalizer listener must unsubscribe on unmount');
    registerConnectionLogsActions(null);
    publishConnectionLogsSnapshot({ connectionLogs: [] });
    env.restore();
  }
});
