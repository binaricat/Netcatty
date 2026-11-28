import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  appendRemoteDesktopClipToConnectionLog,
  collectProtectedRemoteDesktopMediaIds,
  getRemoteDesktopRecordingsBridge,
  registerSessionLogFinalizer,
} from '../../application/state/remoteDesktopLogActions';
import type { RemoteDesktopProtocol } from '../../domain/remoteDesktop';
import {
  STORAGE_KEY_REMOTE_DESKTOP_AUTO_RECORD,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_FPS,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_INCLUDE_AUDIO,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_MAX_MB,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_RETENTION_DAYS,
} from '../../infrastructure/config/storageKeys';
import { toast } from '../ui/toast';
import {
  formatRecordingDuration,
  formatTransferBytes,
  tr,
  type RemoteDesktopCanvasHandle,
  type RemoteDesktopRecordingCaptureHandle,
} from './remoteDesktopHelpers';

// Mirrors LOCAL_STORAGE_ADAPTER_CHANGED_EVENT from infrastructure/persistence/localStorageAdapter.ts
// without violating the component -> infrastructure/persistence lint boundary.
const LOCAL_STORAGE_CHANGED_EVENT = 'netcatty:local-storage-adapter-changed';

// Cap in-flight IPC chunk bytes in renderer RAM so stalled disk I/O never OOMs Electron.
const MAX_PENDING_IPC_BYTES = 32 * 1024 * 1024;
const CHUNK_TIMESLICE_MS = 2000;
const STOP_WAIT_TIMEOUT_MS = 5000;

export interface RemoteDesktopRecordingsApi {
  begin(options: {
    mimeType?: string;
    hostLabel?: string;
    protocol: 'rdp' | 'vnc';
  }): Promise<{ recordingId: string }>;
  append(options: {
    recordingId: string;
    chunk: Uint8Array;
  }): Promise<{ bytesWritten: number }>;
  finish(options: {
    recordingId: string;
    durationMs: number;
    hasAudio?: boolean;
    maxBytes?: number;
    retentionDays?: number;
    protectedIds?: string[];
  }): Promise<{
    recordingId: string;
    bytes: number;
    durationMs: number;
    playbackUrl: string;
  }>;
  abort(options: { recordingId: string }): Promise<{ ok: boolean }>;
  saveThumbnail?(options: {
    id?: string;
    data: Uint8Array;
  }): Promise<{ ok: boolean; id?: string; url?: string; bytes?: number }>;
}

function readStorageString(key: string): string | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null;
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export interface RemoteDesktopRecordingSettings {
  autoRecord: boolean;
  fps: 5 | 10 | 15;
  includeAudio: boolean;
  maxMb: number;
  retentionDays: number;
}

const DEFAULT_RECORDING_SETTINGS: RemoteDesktopRecordingSettings = {
  autoRecord: false,
  fps: 10,
  includeAudio: true,
  maxMb: 1024,
  retentionDays: 30,
};

const RECORDING_SETTING_KEYS = new Set<string>([
  STORAGE_KEY_REMOTE_DESKTOP_AUTO_RECORD,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_FPS,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_INCLUDE_AUDIO,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_MAX_MB,
  STORAGE_KEY_REMOTE_DESKTOP_RECORDING_RETENTION_DAYS,
]);

export function resolveRecordingVideoBitsPerSecond(fps: number): number {
  if (fps <= 5) return 1_000_000;
  if (fps <= 10) return 1_800_000;
  return 2_500_000;
}

export function pickRemoteDesktopRecordingMimeType(
  includeAudio: boolean,
  isTypeSupported?: (mimeType: string) => boolean,
): string {
  const check = isTypeSupported ?? (
    typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? (mime: string) => MediaRecorder.isTypeSupported(mime)
      : () => false
  );
  const candidates = includeAudio
    ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ]
    : [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
  for (const candidate of candidates) {
    try {
      if (check(candidate)) return candidate;
    } catch {
      // ignore unsupported check errors
    }
  }
  return '';
}

export function readRemoteDesktopRecordingSettings(): RemoteDesktopRecordingSettings {
  const rawAuto = readStorageString(STORAGE_KEY_REMOTE_DESKTOP_AUTO_RECORD);
  const rawFpsStr = readStorageString(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_FPS);
  const rawAudio = readStorageString(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_INCLUDE_AUDIO);
  const rawMaxMbStr = readStorageString(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_MAX_MB);
  const rawRetentionStr = readStorageString(STORAGE_KEY_REMOTE_DESKTOP_RECORDING_RETENTION_DAYS);

  const rawFps = rawFpsStr === null || rawFpsStr.trim() === '' ? Number.NaN : Number(rawFpsStr);
  const rawMaxMb = rawMaxMbStr === null || rawMaxMbStr.trim() === '' ? Number.NaN : Number(rawMaxMbStr);
  const rawRetention = rawRetentionStr === null || rawRetentionStr.trim() === ''
    ? Number.NaN
    : Number(rawRetentionStr);

  const fps: 5 | 10 | 15 = rawFps === 5 ? 5 : rawFps === 15 ? 15 : DEFAULT_RECORDING_SETTINGS.fps;
  const maxMb = Number.isFinite(rawMaxMb) && rawMaxMb > 0 ? Math.round(rawMaxMb) : DEFAULT_RECORDING_SETTINGS.maxMb;
  const retentionDays = Number.isFinite(rawRetention) && rawRetention >= 0
    ? Math.round(rawRetention)
    : DEFAULT_RECORDING_SETTINGS.retentionDays;

  return {
    autoRecord: rawAuto === null ? DEFAULT_RECORDING_SETTINGS.autoRecord : rawAuto === 'true',
    fps,
    includeAudio: rawAudio === null ? DEFAULT_RECORDING_SETTINGS.includeAudio : rawAudio === 'true',
    maxMb,
    retentionDays,
  };
}

export interface UseRemoteDesktopRecorderOptions {
  sessionId: string;
  protocol: RemoteDesktopProtocol;
  hostLabel: string;
  status: 'connecting' | 'connected' | 'disconnected';
  audioEnabled: boolean;
  canvasHandleRef: React.RefObject<RemoteDesktopCanvasHandle | null>;
  recordingsBridgeOverride?: RemoteDesktopRecordingsApi | null;
  onRecordingLifecycleEvent?: (event: {
    kind: 'recording_started' | 'recording_stopped';
    timestamp: number;
    summary: string;
    detail?: string;
  }) => void;
}

export interface UseRemoteDesktopRecorderResult {
  isRecording: boolean;
  isStopping: boolean;
  isSupported: boolean;
  elapsedMs: number;
  formattedElapsed: string;
  startRecording: (options?: { silent?: boolean }) => Promise<boolean>;
  stopRecording: (options?: { stampEndTime?: boolean; silent?: boolean }) => Promise<void>;
  toggleRecording: () => Promise<void>;
}

interface ActiveRecordingRun {
  recordingId: string;
  mimeType: string;
  hasAudio: boolean;
  width?: number;
  height?: number;
  startedAt: number;
  recorder: MediaRecorder;
  stream: MediaStream;
  disposeCapture: () => void;
  thumbnailPromise: Promise<boolean>;
  appendChain: Promise<void>;
  appendError: Error | null;
  bytesQueued: number;
  pendingIpcBytes: number;
  stopPromise: Promise<void> | null;
  aborted: boolean;
  settings: RemoteDesktopRecordingSettings;
}

function acquireCanvasCapture(
  handle: RemoteDesktopCanvasHandle | null,
  fps: number,
  wantAudio: boolean,
): RemoteDesktopRecordingCaptureHandle | null {
  if (!handle) return null;
  if (typeof handle.createRecordingCapture === 'function') {
    return handle.createRecordingCapture(fps, wantAudio);
  }
  const stream = handle.getCaptureStream?.(fps, wantAudio) ?? null;
  if (!stream) return null;
  let disposed = false;
  return {
    stream,
    width: 0,
    height: 0,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      } catch {
        // ignore
      }
    },
  };
}

export function useRemoteDesktopRecorder({
  sessionId,
  protocol,
  hostLabel,
  status,
  audioEnabled,
  canvasHandleRef,
  recordingsBridgeOverride,
  onRecordingLifecycleEvent,
}: UseRemoteDesktopRecorderOptions): UseRemoteDesktopRecorderResult {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RemoteDesktopRecordingSettings>(readRemoteDesktopRecordingSettings);
  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const activeRunRef = useRef<ActiveRecordingRun | null>(null);
  const autoRecordedForConnectionRef = useRef(false);
  const mountedRef = useRef(true);
  const latestMetaRef = useRef({
    sessionId,
    protocol,
    hostLabel,
    status,
    audioEnabled,
    settings,
    onRecordingLifecycleEvent,
  });
  latestMetaRef.current = {
    sessionId,
    protocol,
    hostLabel,
    status,
    audioEnabled,
    settings,
    onRecordingLifecycleEvent,
  };

  const getBridge = useCallback((): RemoteDesktopRecordingsApi | null => {
    if (recordingsBridgeOverride !== undefined) return recordingsBridgeOverride;
    return getRemoteDesktopRecordingsBridge();
  }, [recordingsBridgeOverride]);

  const isSupported = typeof MediaRecorder !== 'undefined' && Boolean(getBridge());

  // Stay in sync with Settings > System recording preferences
  useEffect(() => {
    const refresh = () => setSettings(readRemoteDesktopRecordingSettings());
    const onAdapterChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string | null }>).detail;
      if (!detail?.key || RECORDING_SETTING_KEYS.has(detail.key)) {
        refresh();
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || RECORDING_SETTING_KEYS.has(event.key)) {
        refresh();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(LOCAL_STORAGE_CHANGED_EVENT, onAdapterChanged);
      window.addEventListener('storage', onStorage);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(LOCAL_STORAGE_CHANGED_EVENT, onAdapterChanged);
        window.removeEventListener('storage', onStorage);
      }
    };
  }, []);

  // Elapsed timer while recording (1s granularity avoids redundant React re-renders)
  useEffect(() => {
    if (!isRecording) {
      setElapsedMs(0);
      return undefined;
    }
    const timer = window.setInterval(() => {
      const run = activeRunRef.current;
      if (run) {
        const nextMs = Math.max(0, Date.now() - run.startedAt);
        setElapsedMs((prev) =>
          Math.floor(prev / 1000) === Math.floor(nextMs / 1000) ? prev : nextMs,
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const stopRecording = useCallback(
    async (options?: { stampEndTime?: boolean; silent?: boolean }): Promise<void> => {
      const run = activeRunRef.current;
      if (!run) return;
      if (run.stopPromise) {
        return run.stopPromise;
      }

      const bridge = getBridge();
      const finalize = async () => {
        if (mountedRef.current) setIsStopping(true);
        try {
          if (run.recorder.state !== 'inactive') {
            await new Promise<void>((resolve) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeoutId);
                try {
                  run.recorder.removeEventListener?.('stop', done);
                  run.recorder.removeEventListener?.('error', done);
                } catch {
                  // ignore
                } finally {
                  resolve();
                }
              };
              const timeoutId = window.setTimeout(done, STOP_WAIT_TIMEOUT_MS);
              run.recorder.addEventListener('stop', done, { once: true });
              run.recorder.addEventListener('error', done, { once: true });
              try {
                if (typeof run.recorder.requestData === 'function' && run.recorder.state === 'recording') {
                  run.recorder.requestData();
                }
              } catch {
                // ignore
              }
              try {
                run.recorder.stop();
              } catch {
                done();
              }
            });
          }

          run.recorder.ondataavailable = null;
          run.recorder.onerror = null;
          run.disposeCapture();
          await Promise.all([
            run.appendChain.catch(() => {}),
            run.thumbnailPromise.catch(() => false),
          ]);

          const endedAt = Date.now();
          const durationMs = Math.max(1, endedAt - run.startedAt);
          if (!bridge) return;

          if (run.aborted || run.appendError || run.bytesQueued <= 0) {
            await bridge.abort({ recordingId: run.recordingId }).catch(() => {});
            if (run.appendError && !options?.silent) {
              toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
            }
            return;
          }

          try {
            const hasThumbnail = await run.thumbnailPromise.catch(() => false);
            const finished = await bridge.finish({
              recordingId: run.recordingId,
              durationMs,
              hasAudio: run.hasAudio,
              maxBytes: run.settings.maxMb * 1024 * 1024,
              retentionDays: run.settings.retentionDays,
              protectedIds: collectProtectedRemoteDesktopMediaIds(),
            });
            const finalDurationMs = finished.durationMs ?? durationMs;
            await appendRemoteDesktopClipToConnectionLog(
              latestMetaRef.current.sessionId,
              {
                id: finished.recordingId,
                startedAt: run.startedAt,
                endedAt,
                durationMs: finalDurationMs,
                bytes: finished.bytes,
                mimeType: run.mimeType || 'video/webm',
                hasAudio: run.hasAudio,
                ...(hasThumbnail ? { hasThumbnail: true } : {}),
                ...(run.width && run.height ? { width: run.width, height: run.height } : {}),
              },
              { stampEndTime: options?.stampEndTime },
            );
            latestMetaRef.current.onRecordingLifecycleEvent?.({
              kind: 'recording_stopped',
              timestamp: endedAt,
              summary: 'Recording saved',
              detail: `${formatRecordingDuration(finalDurationMs)} \u00b7 ${formatTransferBytes(finished.bytes)}${run.hasAudio ? ' \u00b7 Audio' : ''}`,
            });
            if (!options?.silent) {
              toast.success(
                tr(t, 'remoteDesktop.recording.saved', 'Session recording saved to Connection Logs'),
              );
            }
          } catch {
            await bridge.abort({ recordingId: run.recordingId }).catch(() => {});
            if (!options?.silent) {
              toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
            }
          }
        } finally {
          // Ensure capture is always disposed even on unexpected throw.
          run.disposeCapture();
          if (activeRunRef.current === run) {
            activeRunRef.current = null;
          }
          if (mountedRef.current) {
            setIsRecording(false);
            setIsStopping(false);
            setElapsedMs(0);
          }
        }
      };

      run.stopPromise = finalize();
      return run.stopPromise;
    },
    [getBridge, t],
  );

  const startingRef = useRef(false);
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;

  const startRecording = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (activeRunRef.current || startingRef.current) return false;
      const meta = latestMetaRef.current;
      if (meta.status !== 'connected') return false;

      const bridge = getBridge();
      if (typeof MediaRecorder === 'undefined' || !bridge) {
        if (!options?.silent) {
          toast.error(
            tr(
              t,
              'remoteDesktop.recording.unsupported',
              'Session recording is not supported in this environment',
            ),
          );
        }
        return false;
      }

      startingRef.current = true;
      try {
        const wantAudio = meta.protocol === 'rdp' && meta.audioEnabled && meta.settings.includeAudio;
        const capture = acquireCanvasCapture(canvasHandleRef.current, meta.settings.fps, wantAudio);
        if (!capture || capture.stream.getVideoTracks().length === 0) {
          capture?.dispose();
          if (!options?.silent) {
            toast.error(
              tr(
                t,
                'remoteDesktop.recording.unsupported',
                'Session recording is not supported in this environment',
              ),
            );
          }
          return false;
        }

        const hasAudio = capture.stream.getAudioTracks().length > 0;
        const mimeType = pickRemoteDesktopRecordingMimeType(hasAudio);
        const videoBitsPerSecond = resolveRecordingVideoBitsPerSecond(meta.settings.fps);

        let recordingId: string;
        try {
          const begun = await bridge.begin({
            mimeType: mimeType || 'video/webm',
            hostLabel: meta.hostLabel,
            protocol: meta.protocol,
          });
          recordingId = begun.recordingId;
        } catch {
          capture.dispose();
          if (!options?.silent) {
            toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
          }
          return false;
        }

        // Guard against unmount or disconnect while awaiting bridge.begin()
        if (!mountedRef.current || latestMetaRef.current.status !== 'connected') {
          capture.dispose();
          await bridge.abort({ recordingId }).catch(() => {});
          return false;
        }

        let recorder: MediaRecorder;
        try {
          const recorderOptions: MediaRecorderOptions = { videoBitsPerSecond };
          if (mimeType) recorderOptions.mimeType = mimeType;
          recorder = new MediaRecorder(capture.stream, recorderOptions);
        } catch {
          capture.dispose();
          await bridge.abort({ recordingId }).catch(() => {});
          if (!options?.silent) {
            toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
          }
          return false;
        }

        const startedAt = Date.now();
        const run: ActiveRecordingRun = {
          recordingId,
          mimeType: recorder.mimeType || mimeType || 'video/webm',
          hasAudio,
          width: capture.width || undefined,
          height: capture.height || undefined,
          startedAt,
          recorder,
          stream: capture.stream,
          disposeCapture: capture.dispose,
          thumbnailPromise: Promise.resolve(false),
          appendChain: Promise.resolve(),
          appendError: null,
          bytesQueued: 0,
          pendingIpcBytes: 0,
          stopPromise: null,
          aborted: false,
          settings: meta.settings,
        };
        activeRunRef.current = run;

        recorder.ondataavailable = (ev: BlobEvent) => {
          if (!ev.data || ev.data.size <= 0 || run.aborted) return;
          const blob = ev.data;
          const chunkSize = blob.size;
          if (run.pendingIpcBytes + chunkSize > MAX_PENDING_IPC_BYTES) {
            run.appendError = new Error('Recording write queue exceeded memory limit');
            run.aborted = true;
            void stopRecordingRef.current({ silent: false });
            return;
          }
          run.bytesQueued += chunkSize;
          run.pendingIpcBytes += chunkSize;
          run.appendChain = run.appendChain.then(async () => {
            try {
              if (run.aborted) return;
              const buffer = await blob.arrayBuffer();
              if (run.aborted) return;
              await bridge.append({
                recordingId: run.recordingId,
                chunk: new Uint8Array(buffer),
              });
            } catch (err) {
              run.appendError = err instanceof Error ? err : new Error(String(err));
              run.aborted = true;
              void stopRecordingRef.current({ silent: false });
            } finally {
              run.pendingIpcBytes = Math.max(0, run.pendingIpcBytes - chunkSize);
            }
          });
        };

        recorder.onerror = () => {
          if (!run.appendError) {
            run.appendError = new Error('MediaRecorder error');
          }
          run.aborted = true;
          void stopRecordingRef.current({ silent: false });
        };

        try {
          recorder.start(CHUNK_TIMESLICE_MS);
        } catch {
          activeRunRef.current = null;
          recorder.ondataavailable = null;
          recorder.onerror = null;
          capture.dispose();
          await bridge.abort({ recordingId }).catch(() => {});
          if (!options?.silent) {
            toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
          }
          return false;
        }

        // Capture a tiny JPEG poster thumbnail only after MediaRecorder.start() succeeds
        // so failed starts can never race abort() and leave an orphan thumbnail file.
        run.thumbnailPromise = (async () => {
          if (!bridge.saveThumbnail || !canvasHandleRef.current?.captureThumbnailJpeg) {
            return false;
          }
          try {
            const jpeg = await canvasHandleRef.current.captureThumbnailJpeg();
            if (!jpeg || jpeg.byteLength === 0 || run.aborted) return false;
            const res = await bridge.saveThumbnail({ id: recordingId, data: jpeg });
            return Boolean(res?.ok);
          } catch {
            return false;
          }
        })();

        latestMetaRef.current.onRecordingLifecycleEvent?.({
          kind: 'recording_started',
          timestamp: startedAt,
          summary: 'Recording started',
          detail: `${meta.settings.fps} FPS${hasAudio ? ' \u00b7 Audio' : ''}`,
        });

        if (mountedRef.current) {
          setIsRecording(true);
          setElapsedMs(0);
        }
        if (!options?.silent) {
          toast.info(tr(t, 'remoteDesktop.recording.started', 'Session recording started'));
        }
        return true;
      } finally {
        startingRef.current = false;
      }
    },
    [canvasHandleRef, getBridge, t],
  );

  const toggleRecording = useCallback(async () => {
    if (activeRunRef.current) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [startRecording, stopRecording]);

  // Flush active recordings gracefully before window close / app quit
  // so main-process shutdown cleanupAll() never discards an in-progress .webm.part.
  useEffect(() => {
    return registerSessionLogFinalizer(async () => {
      if (activeRunRef.current) {
        await stopRecordingRef.current({ stampEndTime: true, silent: true });
      }
    });
  }, []);

  // Auto-record once per connection when enabled in settings
  useEffect(() => {
    if (status === 'connected') {
      if (settings.autoRecord && !autoRecordedForConnectionRef.current && !activeRunRef.current) {
        autoRecordedForConnectionRef.current = true;
        void startRecording({ silent: false });
      }
      return;
    }
    autoRecordedForConnectionRef.current = false;
    if (activeRunRef.current) {
      void stopRecording({ stampEndTime: false });
    }
  }, [settings.autoRecord, startRecording, status, stopRecording]);

  // Clean flush/stop on unmount (uses ref so locale changes never abort active recordings)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeRunRef.current) {
        void stopRecordingRef.current({ stampEndTime: true, silent: true });
      }
    };
  }, []);

  return {
    isRecording,
    isStopping,
    isSupported,
    elapsedMs,
    formattedElapsed: formatRecordingDuration(elapsedMs),
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
