import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  getConnectionLogsActions,
  getConnectionLogsSnapshot,
} from '../../application/state/connectionLogsStore';
import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
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
  tr,
  type RemoteDesktopCanvasHandle,
} from './remoteDesktopHelpers';

// Mirrors LOCAL_STORAGE_ADAPTER_CHANGED_EVENT from infrastructure/persistence/localStorageAdapter.ts
// without violating the component -> infrastructure/persistence lint boundary.
const LOCAL_STORAGE_CHANGED_EVENT = 'netcatty:local-storage-adapter-changed';

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
}

function readStorageString(key: string): string | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null;
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function getWindowRecordingsBridge(): RemoteDesktopRecordingsApi | null {
  if (typeof window === 'undefined') return null;
  const win = window as Window & {
    netcatty?: { remoteDesktopRecordings?: RemoteDesktopRecordingsApi };
  };
  return win.netcatty?.remoteDesktopRecordings ?? null;
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

function collectProtectedRecordingIds(): string[] {
  const { connectionLogs } = getConnectionLogsSnapshot();
  const ids: string[] = [];
  for (const log of connectionLogs) {
    if (log.saved && log.recordingId) {
      ids.push(log.recordingId);
    }
  }
  return ids;
}

function updateMatchingConnectionLogRecording(
  sessionId: string,
  updates: {
    recordingId: string;
    recordingMimeType: string;
    recordingDurationMs: number;
    recordingBytes: number;
    recordingHasAudio: boolean;
    endTime?: number;
  },
): void {
  const { connectionLogs } = getConnectionLogsSnapshot();
  const actions = getConnectionLogsActions();
  if (!actions?.updateConnectionLog) return;
  const matchingLog = selectConnectionLogForTerminalDataCapture(
    [...connectionLogs],
    { sessionId },
  );
  if (!matchingLog) return;
  actions.updateConnectionLog(matchingLog.id, updates);
}

export interface UseRemoteDesktopRecorderOptions {
  sessionId: string;
  protocol: RemoteDesktopProtocol;
  hostLabel: string;
  status: 'connecting' | 'connected' | 'disconnected';
  audioEnabled: boolean;
  canvasHandleRef: React.RefObject<RemoteDesktopCanvasHandle | null>;
  recordingsBridgeOverride?: RemoteDesktopRecordingsApi | null;
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
  startedAt: number;
  recorder: MediaRecorder;
  stream: MediaStream;
  appendChain: Promise<void>;
  appendError: Error | null;
  bytesQueued: number;
  stopPromise: Promise<void> | null;
  aborted: boolean;
  settings: RemoteDesktopRecordingSettings;
}

const CHUNK_TIMESLICE_MS = 2000;
const STOP_WAIT_TIMEOUT_MS = 5000;

export function useRemoteDesktopRecorder({
  sessionId,
  protocol,
  hostLabel,
  status,
  audioEnabled,
  canvasHandleRef,
  recordingsBridgeOverride,
}: UseRemoteDesktopRecorderOptions): UseRemoteDesktopRecorderResult {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RemoteDesktopRecordingSettings>(readRemoteDesktopRecordingSettings);
  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const activeRunRef = useRef<ActiveRecordingRun | null>(null);
  const autoRecordedForConnectionRef = useRef(false);
  const mountedRef = useRef(true);
  const latestMetaRef = useRef({ sessionId, protocol, hostLabel, status, audioEnabled, settings });
  latestMetaRef.current = { sessionId, protocol, hostLabel, status, audioEnabled, settings };

  const getBridge = useCallback((): RemoteDesktopRecordingsApi | null => {
    if (recordingsBridgeOverride !== undefined) return recordingsBridgeOverride;
    return getWindowRecordingsBridge();
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

  const stopStreamTracks = (stream: MediaStream) => {
    try {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    } catch {
      // ignore
    }
  };

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
                resolve();
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

          stopStreamTracks(run.stream);
          await run.appendChain.catch(() => {});

          const durationMs = Math.max(1, Date.now() - run.startedAt);
          if (!bridge) return;

          if (run.aborted || run.appendError || run.bytesQueued <= 0) {
            await bridge.abort({ recordingId: run.recordingId }).catch(() => {});
            if (run.appendError && !options?.silent) {
              toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
            }
            return;
          }

          try {
            const finished = await bridge.finish({
              recordingId: run.recordingId,
              durationMs,
              hasAudio: run.hasAudio,
              maxBytes: run.settings.maxMb * 1024 * 1024,
              retentionDays: run.settings.retentionDays,
              protectedIds: collectProtectedRecordingIds(),
            });
            updateMatchingConnectionLogRecording(latestMetaRef.current.sessionId, {
              recordingId: finished.recordingId,
              recordingMimeType: run.mimeType || 'video/webm',
              recordingDurationMs: finished.durationMs ?? durationMs,
              recordingBytes: finished.bytes,
              recordingHasAudio: run.hasAudio,
              ...(options?.stampEndTime ? { endTime: Date.now() } : {}),
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

  const startRecording = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (activeRunRef.current) return false;
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

      const wantAudio = meta.protocol === 'rdp' && meta.audioEnabled && meta.settings.includeAudio;
      const stream = canvasHandleRef.current?.getCaptureStream?.(meta.settings.fps, wantAudio) ?? null;
      if (!stream || stream.getVideoTracks().length === 0) {
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

      const hasAudio = stream.getAudioTracks().length > 0;
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
        stopStreamTracks(stream);
        if (!options?.silent) {
          toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
        }
        return false;
      }

      let recorder: MediaRecorder;
      try {
        const recorderOptions: MediaRecorderOptions = { videoBitsPerSecond };
        if (mimeType) recorderOptions.mimeType = mimeType;
        recorder = new MediaRecorder(stream, recorderOptions);
      } catch {
        stopStreamTracks(stream);
        await bridge.abort({ recordingId }).catch(() => {});
        if (!options?.silent) {
          toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
        }
        return false;
      }

      const run: ActiveRecordingRun = {
        recordingId,
        mimeType: recorder.mimeType || mimeType || 'video/webm',
        hasAudio,
        startedAt: Date.now(),
        recorder,
        stream,
        appendChain: Promise.resolve(),
        appendError: null,
        bytesQueued: 0,
        stopPromise: null,
        aborted: false,
        settings: meta.settings,
      };
      activeRunRef.current = run;

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (!ev.data || ev.data.size <= 0 || run.aborted) return;
        const blob = ev.data;
        run.bytesQueued += blob.size;
        run.appendChain = run.appendChain.then(async () => {
          if (run.aborted) return;
          try {
            const buffer = await blob.arrayBuffer();
            if (run.aborted) return;
            await bridge.append({
              recordingId: run.recordingId,
              chunk: new Uint8Array(buffer),
            });
          } catch (err) {
            run.appendError = err instanceof Error ? err : new Error(String(err));
            run.aborted = true;
            void stopRecording({ silent: false });
          }
        });
      };

      recorder.onerror = () => {
        if (!run.appendError) {
          run.appendError = new Error('MediaRecorder error');
        }
        run.aborted = true;
        void stopRecording({ silent: false });
      };

      try {
        recorder.start(CHUNK_TIMESLICE_MS);
      } catch {
        activeRunRef.current = null;
        stopStreamTracks(stream);
        await bridge.abort({ recordingId }).catch(() => {});
        if (!options?.silent) {
          toast.error(tr(t, 'remoteDesktop.recording.failed', 'Session recording failed'));
        }
        return false;
      }

      if (mountedRef.current) {
        setIsRecording(true);
        setElapsedMs(0);
      }
      if (!options?.silent) {
        toast.info(tr(t, 'remoteDesktop.recording.started', 'Session recording started'));
      }
      return true;
    },
    [canvasHandleRef, getBridge, stopRecording, t],
  );

  const toggleRecording = useCallback(async () => {
    if (activeRunRef.current) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [startRecording, stopRecording]);

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

  // Clean flush/stop on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeRunRef.current) {
        void stopRecording({ stampEndTime: true, silent: true });
      }
    };
  }, [stopRecording]);

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
