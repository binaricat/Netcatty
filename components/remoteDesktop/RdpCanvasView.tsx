import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertCircle, UploadCloud } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  computeMonitorVirtualBounds,
  mapViewportToVirtualDesktopCoords,
  resolveEffectiveRdpSecurityMode,
  resolveNextRdpAutoFallback,
  splitWindowsUserDomain,
  type MonitorLayoutSpec,
  type NormalizedRdpConfig,
  type RdpAutoFallbackStage,
  type RdpDisplayControlCaps,
  type RdpNegotiatedSecurityInfo,
} from '../../domain/remoteDesktop';
import {
  permilleToFramebufferCoord,
  resolveChordToRdpScancodes,
  resolveKeyToRdpScancode,
  type RemoteDesktopAction,
} from '../../domain/remoteDesktopActionCodec';
import type { RemoteDesktopSharedFolder } from '../../infrastructure/remoteDesktop/remoteDesktopSharedFolders';
import {
  captureFrameFromCanvas,
  type RemoteDesktopCaptureRequest,
  type RemoteDesktopProviderFrame,
} from '../../infrastructure/remoteDesktop/remoteDesktopSnapshotRegistry';
import { cn } from '../../lib/utils';
import { toast } from '../ui/toast';
import { RdpAudioPlayer, type RdpAudioMessage } from './rdpAudioPlayer';
import { domCodeToRdpScancode, RDP_SPECIAL_CHORDS } from './rdpScancodeMap';
import {
  computeClipboardUploadProgress,
  getRemoteDesktopBridge,
  isRemoteDesktopGrabReleaseChord,
  tr,
  type RemoteDesktopCanvasHandle,
  type RemoteDesktopClipboardFileOffer,
  type RemoteDesktopClipboardTransferState,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopRdpdrRequest,
} from './remoteDesktopHelpers';
import type { RemoteDesktopSpecialKeyId } from './vncKeymap';

import type {
  ClipboardData as IronClipboardData,
  DeviceEvent as IronDeviceEvent,
  Session as IronSession,
} from '@netcatty/ironrdp-wasm';

type IronRdpModule = typeof import('@netcatty/ironrdp-wasm');

let ironRdpInitPromise: Promise<IronRdpModule> | null = null;

async function loadIronRdp(): Promise<IronRdpModule> {
  if (!ironRdpInitPromise) {
    ironRdpInitPromise = (async () => {
      const mod = await import('@netcatty/ironrdp-wasm');
      await mod.default();
      mod.setup('warn');
      return mod;
    })().catch((err) => {
      ironRdpInitPromise = null;
      throw err;
    });
  }
  return ironRdpInitPromise;
}

const FILE_CONTENTS_FLAG_SIZE = 0x00000001;
const FILE_CONTENTS_FLAG_RANGE = 0x00000002;
const FILE_CHUNK_SIZE = 64 * 1024;
const PROGRESS_THROTTLE_MS = 100;

interface WebkitFileSystemEntryLike {
  isDirectory?: boolean;
}

function getDataTransferItemEntry(item: DataTransferItem): WebkitFileSystemEntryLike | null {
  const maybeItem = item as DataTransferItem & {
    webkitGetAsEntry?: () => WebkitFileSystemEntryLike | null;
  };
  return typeof maybeItem.webkitGetAsEntry === 'function' ? maybeItem.webkitGetAsEntry() : null;
}

export interface RdpCanvasViewProps {
  sessionId: string;
  wsUrl: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  domain: string;
  rdpConfig: NormalizedRdpConfig;
  autoFallbackStage: RdpAutoFallbackStage;
  isVisible: boolean;
  displayMode: RemoteDesktopDisplayMode;
  highDpi?: boolean;
  mapCmdToCtrl?: boolean;
  viewOnly: boolean;
  clipboardSyncEnabled: boolean;
  audioMuted: boolean;
  audioVolume: number;
  keyboardGrabActive: boolean;
  sharedFolders?: readonly RemoteDesktopSharedFolder[];
  fixedResolution?: { width: number; height: number } | null;
  monitorLayout?: readonly MonitorLayoutSpec[];
  activeMonitorIndex?: 'all' | number;
  onDisplayControlCaps?: (caps: RdpDisplayControlCaps) => void;
  onFpsChange?: (fps: number) => void;
  onRequestReleaseGrab: () => void;
  onConnected: (info: {
    width: number;
    height: number;
    encrypted?: boolean;
    securityInfo?: RdpNegotiatedSecurityInfo;
  }) => void;
  onDesktopResize: (size: { width: number; height: number }) => void;
  onRemoteClipboardFilesChange?: (files: RemoteDesktopClipboardFileOffer[]) => void;
  onClipboardFileTransferStatus?: (status: string | null) => void;
  onClipboardTransferChange?: (transfer: RemoteDesktopClipboardTransferState | null) => void;
  onNegotiationFallbackNeeded?: (nextStage: Exclude<RdpAutoFallbackStage, 'none'>) => void;
  onError: (error: { message: string; isAuthError?: boolean; kind?: number }) => void;
  onDisconnected: (reason?: string) => void;
}

function extractAuthTokenFromWsUrl(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    return parsed.searchParams.get('token') || 'netcatty';
  } catch {
    return 'netcatty';
  }
}

export const RdpCanvasView = React.memo(forwardRef<RemoteDesktopCanvasHandle, RdpCanvasViewProps>(
  function RdpCanvasView(
    {
      sessionId,
      wsUrl,
      hostname,
      port,
      username,
      password,
      domain,
      rdpConfig,
      autoFallbackStage,
      isVisible,
      displayMode,
      highDpi = true,
      mapCmdToCtrl = false,
      viewOnly,
      clipboardSyncEnabled,
      audioMuted,
      audioVolume,
      keyboardGrabActive,
      sharedFolders = [],
      fixedResolution = null,
      monitorLayout = [],
      activeMonitorIndex = 'all',
      onDisplayControlCaps,
      onFpsChange,
      onRequestReleaseGrab,
      onConnected,
      onDesktopResize,
      onRemoteClipboardFilesChange,
      onClipboardFileTransferStatus,
      onClipboardTransferChange,
      onNegotiationFallbackNeeded,
      onError,
      onDisconnected,
    },
    ref,
  ) {
    const { t } = useI18n();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const cachedCanvasRectRef = useRef<DOMRect | null>(null);
    const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);
    const pointerRafRef = useRef<number | null>(null);
    const lastSentPointerRef = useRef<{ x: number; y: number } | null>(null);
    const imeInputRef = useRef<HTMLTextAreaElement | null>(null);
    const sessionRef = useRef<IronSession | null>(null);
    const modRef = useRef<IronRdpModule | null>(null);
    const audioPlayerRef = useRef<RdpAudioPlayer | null>(null);
    const lastAltRightUpRef = useRef(0);
    const lastRemoteClipboardTextRef = useRef('');
    const uploadedFilesRef = useRef<File[]>([]);
    const uploadTransferIdRef = useRef<string>('');
    const uploadedHighWaterByIndexRef = useRef<Map<number, number>>(new Map());
    const lastUploadProgressEmitRef = useRef<number>(0);
    const remoteFilesRef = useRef<{ clipDataId?: number; files: RemoteDesktopClipboardFileOffer[] }>({ files: [] });
    const nextStreamIdRef = useRef(1);
    const pendingDownloadsRef = useRef<
      Map<
        number,
        {
          transferId: string;
          file: RemoteDesktopClipboardFileOffer;
          fileIndex: number;
          clipDataId?: number;
          stage: 'size' | 'range';
          totalSize: number;
          offset: number;
          saveStreamId: string | null;
          lastProgressEmitAt: number;
        }
      >
    >(new Map());
    const dragDepthRef = useRef(0);
    const [remoteSize, setRemoteSize] = useState<{ width: number; height: number }>({
      width: rdpConfig.width || 1920,
      height: rdpConfig.height || 1080,
    });
    const [cursorCss, setCursorCss] = useState<string>('default');
    const [dragOverlayState, setDragOverlayState] = useState<{
      active: boolean;
      itemCount: number;
      blockedReason?: 'disabled' | 'view-only';
    }>({ active: false, itemCount: 0 });

    const callbacksRef = useRef({
      onConnected,
      onDesktopResize,
      onRemoteClipboardFilesChange,
      onClipboardFileTransferStatus,
      onClipboardTransferChange,
      onNegotiationFallbackNeeded,
      onDisplayControlCaps,
      onFpsChange,
      onError,
      onDisconnected,
      onRequestReleaseGrab,
    });
    callbacksRef.current = {
      onConnected,
      onDesktopResize,
      onRemoteClipboardFilesChange,
      onClipboardFileTransferStatus,
      onClipboardTransferChange,
      onNegotiationFallbackNeeded,
      onDisplayControlCaps,
      onFpsChange,
      onError,
      onDisconnected,
      onRequestReleaseGrab,
    };

    const propsRef = useRef({
      sessionId,
      viewOnly,
      clipboardSyncEnabled,
      isVisible,
      keyboardGrabActive,
      displayMode,
      highDpi,
      mapCmdToCtrl,
      sharedFolders,
      fixedResolution,
      monitorLayout,
      activeMonitorIndex,
    });
    propsRef.current = {
      sessionId,
      viewOnly,
      clipboardSyncEnabled,
      isVisible,
      keyboardGrabActive,
      displayMode,
      highDpi,
      mapCmdToCtrl,
      sharedFolders,
      fixedResolution,
      monitorLayout,
      activeMonitorIndex,
    };

    const activeMonitorRect = useMemo(() => {
      if (
        !monitorLayout
        || monitorLayout.length <= 1
        || typeof activeMonitorIndex !== 'number'
        || activeMonitorIndex < 0
        || activeMonitorIndex >= monitorLayout.length
      ) {
        return null;
      }
      const bounds = computeMonitorVirtualBounds(monitorLayout);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
      const slice = bounds.monitorRects[activeMonitorIndex];
      if (!slice) return null;
      const scaleX = remoteSize.width / bounds.width;
      const scaleY = remoteSize.height / bounds.height;
      return {
        left: slice.left * scaleX,
        top: slice.top * scaleY,
        width: slice.width * scaleX,
        height: slice.height * scaleY,
      };
    }, [activeMonitorIndex, monitorLayout, remoteSize.height, remoteSize.width]);

    const activeMonitorRectRef = useRef(activeMonitorRect);
    activeMonitorRectRef.current = activeMonitorRect;

    // Sync user mute / volume to audio player
    useEffect(() => {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.setMuted(audioMuted);
        audioPlayerRef.current.setVolume(audioVolume);
      }
    }, [audioMuted, audioVolume]);

    const applyDeviceEvents = useCallback((buildEvents: (mod: IronRdpModule) => IronDeviceEvent[]) => {
      const session = sessionRef.current;
      const mod = modRef.current;
      if (!session || !mod) return;
      try {
        const tx = new mod.InputTransaction();
        for (const ev of buildEvents(mod)) {
          tx.addEvent(ev);
        }
        session.applyInputs(tx);
      } catch {
        // Session may have just closed
      }
    }, []);

    const releaseAllInputs = useCallback(() => {
      try {
        sessionRef.current?.releaseAllInputs();
      } catch { /* ignore */ }
    }, []);

    const sendSpecialKey = useCallback(
      (id: RemoteDesktopSpecialKeyId) => {
        if (propsRef.current.viewOnly) return;
        const chord = RDP_SPECIAL_CHORDS[id];
        if (!chord || chord.length === 0) return;
        applyDeviceEvents((mod) => [
          ...chord.map((sc) => mod.DeviceEvent.keyPressed(sc)),
          ...[...chord].reverse().map((sc) => mod.DeviceEvent.keyReleased(sc)),
        ]);
      },
      [applyDeviceEvents],
    );

    const typeText = useCallback(
      (text: string) => {
        if (propsRef.current.viewOnly || !text) return;
        const normalized = text.replace(/\r\n/g, '\n');
        applyDeviceEvents((mod) => {
          const events: IronDeviceEvent[] = [];
          for (const ch of normalized) {
            if (ch === '\n') {
              events.push(mod.DeviceEvent.keyPressed(0x001c));
              events.push(mod.DeviceEvent.keyReleased(0x001c));
            } else if (ch === '\t') {
              events.push(mod.DeviceEvent.keyPressed(0x000f));
              events.push(mod.DeviceEvent.keyReleased(0x000f));
            } else {
              events.push(mod.DeviceEvent.unicodePressed(ch));
              events.push(mod.DeviceEvent.unicodeReleased(ch));
            }
          }
          return events;
        });
      },
      [applyDeviceEvents],
    );

    const captureScreenshot = useCallback(async (): Promise<Blob | null> => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    }, []);

    const captureFrame = useCallback(
      (
        options?: RemoteDesktopCaptureRequest & {
          maxWidth?: number;
          protocol?: 'vnc' | 'rdp';
          hostLabel?: string;
          hostname?: string;
          includePreview?: boolean;
        },
      ): RemoteDesktopProviderFrame | null => {
        const canvas = canvasRef.current;
        if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
        return captureFrameFromCanvas(canvas, {
          ...options,
          protocol: 'rdp',
        });
      },
      [],
    );

    const getCanvasRect = useCallback((): DOMRect | null => {
      return canvasRef.current?.getBoundingClientRect() ?? null;
    }, []);

    const getCaptureStream = useCallback((fps: number, includeAudio?: boolean): MediaStream | null => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      if (typeof canvas.captureStream !== 'function') return null;
      try {
        const videoStream = canvas.captureStream(fps);
        if (!includeAudio) return videoStream;
        const audioStream = audioPlayerRef.current?.getCaptureAudioStream() ?? null;
        const audioTracks = audioStream?.getAudioTracks() ?? [];
        if (audioTracks.length === 0 || typeof MediaStream === 'undefined') {
          return videoStream;
        }
        const clonedAudioTracks = audioTracks.map((track) => (
          typeof track.clone === 'function' ? track.clone() : track
        ));
        return new MediaStream([...videoStream.getVideoTracks(), ...clonedAudioTracks]);
      } catch {
        return null;
      }
    }, []);

    const emitClipboardTransfer = useCallback((transfer: RemoteDesktopClipboardTransferState | null) => {
      callbacksRef.current.onClipboardTransferChange?.(transfer);
      callbacksRef.current.onClipboardFileTransferStatus?.(transfer?.message ?? null);
    }, []);

    const downloadRemoteClipboardFile = useCallback(async (fileIndex: number) => {
      const session = sessionRef.current;
      const mod = modRef.current;
      const bridge = getRemoteDesktopBridge();
      if (!session || !mod || !bridge) return;
      const file = remoteFilesRef.current.files.find((f) => f.index === fileIndex);
      if (!file || file.isDirectory) return;

      const beginRes = await bridge.saveClipboardFile({
        action: 'begin',
        fileName: file.name,
      });
      if (!beginRes?.ok || beginRes.canceled || !beginRes.streamId) {
        return;
      }
      if (sessionRef.current !== session) {
        void bridge.saveClipboardFile({ action: 'abort', streamId: beginRes.streamId }).catch(() => {});
        return;
      }

      const streamId = nextStreamIdRef.current++;
      const transferId = `clip-down-${Date.now()}-${streamId}`;
      const totalSize = file.size > 0 ? file.size : 0;
      const clipDataId = remoteFilesRef.current.clipDataId;
      const initialStage: 'size' | 'range' = totalSize > 0 ? 'range' : 'size';
      pendingDownloadsRef.current.set(streamId, {
        transferId,
        file,
        fileIndex,
        clipDataId,
        stage: initialStage,
        totalSize,
        offset: 0,
        saveStreamId: beginRes.streamId,
        lastProgressEmitAt: Date.now(),
      });
      emitClipboardTransfer({
        id: transferId,
        direction: 'download',
        phase: 'transferring',
        fileName: file.name,
        fileCount: 1,
        transferredBytes: 0,
        totalBytes: totalSize,
        percent: 0,
        message: `Downloading ${file.name}...`,
      });

      try {
        session.invokeExtension(
          new mod.Extension('request_file_contents', {
            streamId,
            index: fileIndex,
            flags: initialStage === 'size' ? FILE_CONTENTS_FLAG_SIZE : FILE_CONTENTS_FLAG_RANGE,
            position: 0,
            size: initialStage === 'size' ? 8 : Math.min(FILE_CHUNK_SIZE, totalSize),
            ...(clipDataId !== undefined ? { dataId: clipDataId } : {}),
          }),
        );
      } catch (err) {
        pendingDownloadsRef.current.delete(streamId);
        await bridge.saveClipboardFile({ action: 'abort', streamId: beginRes.streamId }).catch(() => {});
        const errMessage = err instanceof Error ? `Download failed: ${err.message}` : 'Download failed';
        emitClipboardTransfer({
          id: transferId,
          direction: 'download',
          phase: 'error',
          fileName: file.name,
          fileCount: 1,
          transferredBytes: 0,
          totalBytes: totalSize,
          percent: 0,
          message: errMessage,
          error: errMessage,
        });
      }
    }, [emitClipboardTransfer]);

    const uploadLocalClipboardFiles = useCallback(async (filesInput: FileList | File[]) => {
      const session = sessionRef.current;
      const mod = modRef.current;
      if (!session || !mod || propsRef.current.viewOnly) return;
      const files = Array.from(filesInput).filter((f) => Boolean(f?.name));
      if (files.length === 0) return;
      uploadedFilesRef.current = files;
      uploadedHighWaterByIndexRef.current.clear();
      const transferId = `clip-up-${Date.now()}-${nextStreamIdRef.current++}`;
      uploadTransferIdRef.current = transferId;
      lastUploadProgressEmitRef.current = 0;
      const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.size) || 0), 0);
      const metadata = files.map((file) => ({
        name: file.name,
        size: file.size,
        lastModified: Math.floor((file.lastModified || Date.now()) / 1000),
      }));
      try {
        session.invokeExtension(new mod.Extension('initiate_file_copy', metadata));
        const stagedMessage = `Ready to paste ${files.length} file${files.length > 1 ? 's' : ''} on remote (Ctrl+V)`;
        emitClipboardTransfer({
          id: transferId,
          direction: 'upload',
          phase: 'staged',
          fileName: files[0].name,
          fileCount: files.length,
          transferredBytes: 0,
          totalBytes,
          percent: 0,
          message: stagedMessage,
        });
        toast.info(stagedMessage);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : 'Server does not support clipboard file transfer';
        emitClipboardTransfer({
          id: transferId,
          direction: 'upload',
          phase: 'error',
          fileName: files[0].name,
          fileCount: files.length,
          transferredBytes: 0,
          totalBytes,
          percent: 0,
          message: errMessage,
          error: errMessage,
        });
      }
    }, [emitClipboardTransfer]);

    const focusInput = useCallback(() => {
      imeInputRef.current?.focus({ preventScroll: true });
    }, []);

    // Sync local clipboard to remote when focused or manually requested
    const syncLocalClipboardToRdp = useCallback(async (force = false) => {
      if ((!force && !propsRef.current.clipboardSyncEnabled) || propsRef.current.viewOnly) return;
      const session = sessionRef.current;
      const mod = modRef.current;
      if (!session || !mod) return;
      try {
        const text = await navigator.clipboard?.readText();
        if (text && (force || text !== lastRemoteClipboardTextRef.current)) {
          lastRemoteClipboardTextRef.current = text;
          const data = new mod.ClipboardData();
          try {
            data.addText('text/plain', text);
            await session.onClipboardPaste(data);
          } finally {
            try { data.free(); } catch { /* ignore */ }
          }
        }
      } catch {
        // Clipboard permission or empty
      }
    }, []);

    const syncClipboardNow = useCallback(() => syncLocalClipboardToRdp(true), [syncLocalClipboardToRdp]);

    const resizeToPreset = useCallback((width: number, height: number) => {
      const session = sessionRef.current;
      if (!session) return;
      const clampedW = Math.min(8192, Math.max(200, Math.floor(width)));
      const clampedH = Math.min(8192, Math.max(200, Math.floor(height)));
      const evenW = clampedW - (clampedW % 2);
      const evenH = clampedH - (clampedH % 2);
      const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const effectiveDpr = propsRef.current.highDpi ? Math.min(2, Math.max(1, rawDpr)) : 1;
      const scaleFactor = propsRef.current.highDpi
        ? Math.min(500, Math.max(100, Math.round(effectiveDpr * 100)))
        : 100;
      try {
        // Wait for server-confirmed backing canvas resize (`canvasResizedCallback`)
        // to update `remoteSize` so UI/pointer math never desyncs from `canvas.width/height`.
        session.resize(evenW, evenH, scaleFactor);
      } catch {
        // Ignore resize error if server does not support Display Control
      }
    }, []);

    const setMonitorLayout = useCallback((monitors: MonitorLayoutSpec[]) => {
      const session = sessionRef.current;
      const mod = modRef.current;
      if (!session || !mod || !Array.isArray(monitors) || monitors.length === 0) return;
      try {
        // Let `canvasResizedCallback` update `remoteSize` once the server applies
        // the new virtual desktop bounds, preventing premature coordinate desync.
        session.invokeExtension(new mod.Extension('set_monitor_layout', monitors));
      } catch {
        // Ignore if display control extension is not ready
      }
    }, []);

    const addSharedDrive = useCallback((drive: { deviceId: number; name: string }) => {
      const session = sessionRef.current;
      const mod = modRef.current;
      if (!session || !mod) return;
      try {
        session.invokeExtension(new mod.Extension('rdpdr_add_drive', drive));
      } catch {
        // Session may have closed or RDPDR not active
      }
    }, []);

    const removeSharedDrive = useCallback((deviceId: number) => {
      const session = sessionRef.current;
      const mod = modRef.current;
      if (!session || !mod) return;
      try {
        session.invokeExtension(new mod.Extension('rdpdr_remove_drive', deviceId));
      } catch {
        // Session may have closed or RDPDR not active
      }
    }, []);

    const remoteSizeRef = useRef(remoteSize);
    remoteSizeRef.current = remoteSize;
    const lastSentScaleFactorRef = useRef<number | null>(null);
    const [sessionConnectedSeq, setSessionConnectedSeq] = useState(0);

    const performAiAction = useCallback(
      async (action: RemoteDesktopAction, options?: { signal?: AbortSignal }): Promise<void> => {
        const signal = options?.signal;
        if (signal?.aborted) return;
        if (propsRef.current.viewOnly) {
          throw new Error('RDP session is in view-only mode.');
        }
        const session = sessionRef.current;
        const mod = modRef.current;
        if (!session || !mod) {
          throw new Error('RDP session is not connected.');
        }
        const isCancelled = () => Boolean(signal?.aborted || propsRef.current.viewOnly || sessionRef.current !== session);
        const sleep = (ms: number) => new Promise<void>((resolve) => {
          if (ms <= 0 || isCancelled()) {
            resolve();
            return;
          }
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
          };
          const timer = window.setTimeout(finish, ms);
          signal?.addEventListener('abort', finish, { once: true });
        });
        const canvas = canvasRef.current;
        const fbW = Math.max(1, canvas?.width || remoteSizeRef.current.width || 1920);
        const fbH = Math.max(1, canvas?.height || remoteSizeRef.current.height || 1080);

        const glidePointerTo = async (targetX: number, targetY: number) => {
          if (isCancelled()) return;
          const prev = lastSentPointerRef.current;
          if (!prev) {
            lastSentPointerRef.current = { x: targetX, y: targetY };
            applyDeviceEvents((m) => [m.DeviceEvent.mouseMove(targetX, targetY)]);
            return;
          }
          const dx = targetX - prev.x;
          const dy = targetY - prev.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 6) {
            lastSentPointerRef.current = { x: targetX, y: targetY };
            applyDeviceEvents((m) => [m.DeviceEvent.mouseMove(targetX, targetY)]);
            return;
          }
          const steps = Math.max(6, Math.min(14, Math.round(dist / 85) + 5));
          const stepDelay = 14;
          for (let step = 1; step <= steps; step += 1) {
            if (isCancelled()) return;
            const t = step / steps;
            // Cubic ease-out for natural cursor deceleration
            const eased = 1 - Math.pow(1 - t, 3);
            const ix = Math.round(prev.x + dx * eased);
            const iy = Math.round(prev.y + dy * eased);
            lastSentPointerRef.current = { x: ix, y: iy };
            applyDeviceEvents((m) => [m.DeviceEvent.mouseMove(ix, iy)]);
            if (step < steps) {
              await sleep(stepDelay);
            }
          }
        };

        switch (action.type) {
          case 'wait':
            await sleep(action.ms);
            return;

          case 'move': {
            const x = permilleToFramebufferCoord(action.x, fbW);
            const y = permilleToFramebufferCoord(action.y, fbH);
            await glidePointerTo(x, y);
            return;
          }

          case 'click': {
            const x = permilleToFramebufferCoord(action.x, fbW);
            const y = permilleToFramebufferCoord(action.y, fbH);
            const btn = action.button === 'right' ? 2 : action.button === 'middle' ? 1 : 0;
            const clickCount = action.clickCount ?? 1;
            await glidePointerTo(x, y);
            if (isCancelled()) return;
            const modCodes: number[] = [];
            for (const mk of action.modifiers ?? []) {
              const code = resolveKeyToRdpScancode(mk);
              if (code !== null) modCodes.push(code);
            }
            let buttonHeld = false;
            let modsHeld = false;
            try {
              if (modCodes.length > 0) {
                applyDeviceEvents((m) => modCodes.map((sc) => m.DeviceEvent.keyPressed(sc)));
                modsHeld = true;
              }
              for (let i = 0; i < clickCount; i += 1) {
                if (isCancelled()) break;
                if (i > 0) {
                  await sleep(45);
                  if (isCancelled()) break;
                }
                applyDeviceEvents((m) => [
                  m.DeviceEvent.mouseMove(x, y),
                  m.DeviceEvent.mouseButtonPressed(btn),
                ]);
                buttonHeld = true;
                await sleep(24);
                applyDeviceEvents((m) => [
                  m.DeviceEvent.mouseMove(x, y),
                  m.DeviceEvent.mouseButtonReleased(btn),
                ]);
                buttonHeld = false;
              }
            } finally {
              if (buttonHeld) {
                const pos = lastSentPointerRef.current ?? { x, y };
                applyDeviceEvents((m) => [
                  m.DeviceEvent.mouseMove(pos.x, pos.y),
                  m.DeviceEvent.mouseButtonReleased(btn),
                ]);
              }
              if (modsHeld && modCodes.length > 0) {
                applyDeviceEvents((m) => [...modCodes].reverse().map((sc) => m.DeviceEvent.keyReleased(sc)));
              }
            }
            return;
          }

          case 'drag': {
            const startX = permilleToFramebufferCoord(action.fromX, fbW);
            const startY = permilleToFramebufferCoord(action.fromY, fbH);
            const endX = permilleToFramebufferCoord(action.toX, fbW);
            const endY = permilleToFramebufferCoord(action.toY, fbH);
            const btn = action.button === 'right' ? 2 : 0;
            const steps = Math.max(6, Math.min(40, Math.round(action.steps ?? 12)));
            await glidePointerTo(startX, startY);
            if (isCancelled()) return;
            await sleep(20);
            if (isCancelled()) return;
            let buttonHeld = false;
            try {
              applyDeviceEvents((m) => [
                m.DeviceEvent.mouseMove(startX, startY),
                m.DeviceEvent.mouseButtonPressed(btn),
              ]);
              buttonHeld = true;
              for (let step = 1; step <= steps; step += 1) {
                if (isCancelled()) break;
                await sleep(16);
                if (isCancelled()) break;
                const t = step / steps;
                const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                const ix = Math.round(startX + (endX - startX) * eased);
                const iy = Math.round(startY + (endY - startY) * eased);
                lastSentPointerRef.current = { x: ix, y: iy };
                applyDeviceEvents((m) => [m.DeviceEvent.mouseMove(ix, iy)]);
              }
              if (!isCancelled()) {
                await sleep(18);
              }
              if (!isCancelled()) {
                lastSentPointerRef.current = { x: endX, y: endY };
                applyDeviceEvents((m) => [
                  m.DeviceEvent.mouseMove(endX, endY),
                  m.DeviceEvent.mouseButtonReleased(btn),
                ]);
                buttonHeld = false;
              }
            } finally {
              if (buttonHeld) {
                const pos = lastSentPointerRef.current ?? { x: startX, y: startY };
                applyDeviceEvents((m) => [
                  m.DeviceEvent.mouseMove(pos.x, pos.y),
                  m.DeviceEvent.mouseButtonReleased(btn),
                ]);
              }
            }
            return;
          }

          case 'scroll': {
            const x = permilleToFramebufferCoord(action.x, fbW);
            const y = permilleToFramebufferCoord(action.y, fbH);
            await glidePointerTo(x, y);
            if (isCancelled()) return;
            const dy = action.deltaY ?? 0;
            const dx = action.deltaX ?? 0;
            applyDeviceEvents((m) => {
              const evs: IronDeviceEvent[] = [m.DeviceEvent.mouseMove(x, y)];
              if (dy !== 0) {
                const rawDelta = -dy;
                const amount = Math.sign(rawDelta) * Math.max(1, Math.min(120, Math.round(Math.abs(rawDelta))));
                evs.push(m.DeviceEvent.wheelRotations(true, amount, m.RotationUnit.Pixel));
              }
              if (dx !== 0) {
                const amount = Math.sign(dx) * Math.max(1, Math.min(120, Math.round(Math.abs(dx))));
                evs.push(m.DeviceEvent.wheelRotations(false, amount, m.RotationUnit.Pixel));
              }
              return evs;
            });
            return;
          }

          case 'type': {
            if (isCancelled()) return;
            typeText(action.text);
            return;
          }

          case 'key': {
            if (isCancelled()) return;
            const chord = resolveChordToRdpScancodes(action.key);
            if (!chord || chord.length === 0) {
              throw new Error(`Unsupported RDP key chord: ${action.key}`);
            }
            applyDeviceEvents((m) => chord.map((sc) => m.DeviceEvent.keyPressed(sc)));
            try {
              await sleep(20);
            } finally {
              applyDeviceEvents((m) => [...chord].reverse().map((sc) => m.DeviceEvent.keyReleased(sc)));
            }
            return;
          }
        }
      },
      [applyDeviceEvents, typeText],
    );

    useImperativeHandle(
      ref,
      () => ({
        sendSpecialKey,
        typeText,
        releaseAllInputs,
        captureScreenshot,
        captureFrame,
        getCanvasRect,
        getCaptureStream,
        focusInput,
        syncClipboardNow,
        downloadRemoteClipboardFile,
        uploadLocalClipboardFiles,
        resizeToPreset,
        setMonitorLayout,
        addSharedDrive,
        removeSharedDrive,
        performAiAction,
      }),
      [
        addSharedDrive,
        captureFrame,
        captureScreenshot,
        downloadRemoteClipboardFile,
        focusInput,
        getCanvasRect,
        getCaptureStream,
        performAiAction,
        releaseAllInputs,
        removeSharedDrive,
        resizeToPreset,
        sendSpecialKey,
        setMonitorLayout,
        syncClipboardNow,
        typeText,
        uploadLocalClipboardFiles,
      ],
    );

    // Release keys when hidden or switching into view-only mode
    useEffect(() => {
      if (!isVisible || viewOnly) {
        releaseAllInputs();
      }
    }, [isVisible, releaseAllInputs, viewOnly]);

    // Connect IronRDP WASM session
    useEffect(() => {
      let disposed = false;
      const pendingDownloads = pendingDownloadsRef.current;
      const uploadedHighWater = uploadedHighWaterByIndexRef.current;
      const audioPlayer = rdpConfig.audioEnabled
        ? new RdpAudioPlayer({ muted: audioMuted, volume: audioVolume })
        : null;
      audioPlayerRef.current = audioPlayer;

      const start = async () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const mod = await loadIronRdp();
        if (disposed) return;
        modRef.current = mod;

        const containerRect = containerRef.current?.getBoundingClientRect();
        const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const effectiveDpr = propsRef.current.highDpi ? Math.min(2, Math.max(1, rawDpr)) : 1;
        const scaleFactor = propsRef.current.highDpi
          ? Math.min(500, Math.max(100, Math.round(effectiveDpr * 100)))
          : 100;
        const cssW = Math.max(640, Math.floor(containerRect?.width || rdpConfig.width || 1280));
        const cssH = Math.max(480, Math.floor(containerRect?.height || rdpConfig.height || 800));
        const fixedRes = propsRef.current.fixedResolution;
        const initW = fixedRes
          ? Math.max(200, Math.min(8192, Math.floor(fixedRes.width)))
          : rdpConfig.resolutionMode === 'fixed'
            ? Math.max(640, rdpConfig.width || 1920)
            : Math.min(3840, Math.max(640, Math.floor(cssW * effectiveDpr)));
        const initH = fixedRes
          ? Math.max(200, Math.min(8192, Math.floor(fixedRes.height)))
          : rdpConfig.resolutionMode === 'fixed'
            ? Math.max(480, rdpConfig.height || 1080)
            : Math.min(2160, Math.max(480, Math.floor(cssH * effectiveDpr)));
        // Even dimensions help EGFX / H.264 / ClearCodec alignment
        const alignedW = initW - (initW % 2);
        const alignedH = initH - (initH % 2);
        canvas.width = alignedW;
        canvas.height = alignedH;
        setRemoteSize({ width: alignedW, height: alignedH });

        const { username: cleanUser, domain: cleanDomain } = splitWindowsUserDomain(username, domain);
        const authToken = extractAuthTokenFromWsUrl(wsUrl);
        const securityMode = rdpConfig.securityMode ?? 'auto';
        const effectiveSecurityMode = resolveEffectiveRdpSecurityMode(securityMode, autoFallbackStage);
        const enableCredSsp = effectiveSecurityMode === 'nla' || effectiveSecurityMode === 'auto';
        const enableStandardRdp = effectiveSecurityMode === 'rdp';
        let negotiatedSecurityInfo: RdpNegotiatedSecurityInfo | null = null;

        const rdpdrSessionId = propsRef.current.sessionId;
        const bridgeForRdpdr = getRemoteDesktopBridge();
        let initialRdpdrDrives: Array<{ deviceId: number; name: string }> = [];
        if (bridgeForRdpdr?.rdpdrRegisterDrives && rdpdrSessionId) {
          const desiredDrives = (propsRef.current.sharedFolders ?? []).map((folder) => ({
            deviceId: folder.deviceId,
            name: folder.name,
            path: folder.path,
            readOnly: folder.readOnly,
          }));
          try {
            const regRes = await bridgeForRdpdr.rdpdrRegisterDrives(rdpdrSessionId, desiredDrives);
            if (disposed) return;
            if (regRes?.ok && Array.isArray(regRes.registered)) {
              initialRdpdrDrives = regRes.registered.map((d) => ({
                deviceId: d.deviceId,
                name: d.name,
              }));
            }
          } catch {
            // Proceed without initial drives if registration fails
          }
        }

        const builder = new mod.SessionBuilder()
          .username(cleanUser)
          .password(password)
          .destination(`${hostname}:${port}`)
          .proxyAddress(wsUrl)
          .authToken(authToken)
          .renderCanvas(canvas)
          .desktopSize(new mod.DesktopSize(alignedW, alignedH))
          .canvasResizedCallback(() => {
            if (disposed) return;
            const c = canvasRef.current;
            if (!c || c.width <= 0 || c.height <= 0) return;
            setRemoteSize({ width: c.width, height: c.height });
            callbacksRef.current.onDesktopResize({ width: c.width, height: c.height });
          })
          .setCursorStyleCallbackContext({})
          .setCursorStyleCallback((
            cursorKind: string,
            cursorData?: string,
            hotspotX?: number,
            hotspotY?: number,
          ) => {
            if (disposed) return;
            if (cursorKind === 'hidden') {
              setCursorCss('none');
            } else if (cursorKind === 'url' && cursorData) {
              const hx = Number.isFinite(hotspotX) ? Math.round(hotspotX!) : 0;
              const hy = Number.isFinite(hotspotY) ? Math.round(hotspotY!) : 0;
              const wrapped = cursorData.startsWith('url(') ? cursorData : `url("${cursorData}")`;
              setCursorCss(`${wrapped} ${hx} ${hy}, auto`);
            } else {
              setCursorCss('default');
            }
          });

        if (cleanDomain) {
          builder.serverDomain(cleanDomain);
        }

        builder
          .extension(new mod.Extension('display_control', true))
          .extension(
            new mod.Extension('display_control_caps_callback', (caps: RdpDisplayControlCaps) => {
              if (disposed) return;
              callbacksRef.current.onDisplayControlCaps?.(caps);
            }),
          )
          .extension(new mod.Extension('desktop_scale_factor', rdpConfig.resolutionMode === 'fixed' ? 100 : scaleFactor))
          .extension(new mod.Extension('color_depth', rdpConfig.colorDepth || 32))
          .extension(new mod.Extension('enable_credssp', enableCredSsp))
          .extension(new mod.Extension('enable_standard_rdp_security', enableStandardRdp))
          .extension(
            new mod.Extension('security_info_callback', (info: RdpNegotiatedSecurityInfo) => {
              negotiatedSecurityInfo = info;
            }),
          )
          .extension(new mod.Extension('client_name', 'Netcatty'));

        // RDPDR sandboxed local drive redirection (always attach callback so live hotplug works)
        if (bridgeForRdpdr?.rdpdrOp && rdpdrSessionId) {
          builder
            .extension(new mod.Extension('rdpdr_drives', initialRdpdrDrives))
            .extension(
              new mod.Extension('rdpdr_request_callback', (req: RemoteDesktopRdpdrRequest) => {
                if (disposed) return;
                const bridge = getRemoteDesktopBridge();
                if (!bridge?.rdpdrOp) return;
                void bridge
                  .rdpdrOp(rdpdrSessionId, req)
                  .then((res) => {
                    if (disposed) return;
                    const activeSession = sessionRef.current;
                    if (!activeSession) return;
                    try {
                      activeSession.invokeExtension(new mod.Extension('rdpdr_response', res));
                    } catch {
                      // Session may have just closed
                    }
                  })
                  .catch(() => {
                    if (disposed || !sessionRef.current || req.op === 'reset') return;
                    try {
                      sessionRef.current.invokeExtension(
                        new mod.Extension('rdpdr_response', {
                          op: req.op,
                          deviceId: req.deviceId,
                          completionId: req.completionId,
                          status: 0xc0000001, // STATUS_UNSUCCESSFUL
                        }),
                      );
                    } catch {
                      // Ignore closed session errors
                    }
                  });
              }),
            );
        }

        if (rdpConfig.loadBalanceInfo) {
          builder.extension(new mod.Extension('load_balance_info', rdpConfig.loadBalanceInfo));
        }
        if (rdpConfig.alternateShell) {
          builder.extension(new mod.Extension('alternate_shell', rdpConfig.alternateShell));
        }
        if (rdpConfig.shellWorkingDir) {
          builder.extension(new mod.Extension('work_dir', rdpConfig.shellWorkingDir));
        }

        if (audioPlayer) {
          builder.extension(
            new mod.Extension('audio_playback', (msg: RdpAudioMessage) => {
              if (!disposed) audioPlayer.handleMessage(msg);
            }),
          );
        }

        // Clipboard (text / HTML / PNG)
        builder.remoteClipboardChangedCallback((clipboardData: IronClipboardData) => {
          if (disposed || !propsRef.current.clipboardSyncEnabled) return;
          try {
            const items = clipboardData.items();
            let plainText: string | null = null;
            let pngBytes: Uint8Array | null = null;
            for (const item of items) {
              const mime = item.mimeType();
              const val = item.value();
              if (mime === 'text/plain' && typeof val === 'string') {
                plainText = val;
              } else if (mime === 'image/png' && val instanceof Uint8Array) {
                pngBytes = val;
              }
            }
            if (pngBytes && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
              const pngCopy = new Uint8Array(pngBytes.byteLength);
              pngCopy.set(pngBytes);
              const blob = new Blob([pngCopy], { type: 'image/png' });
              void navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {
                if (plainText) {
                  lastRemoteClipboardTextRef.current = plainText;
                  void navigator.clipboard?.writeText(plainText).catch(() => {});
                }
              });
            } else if (plainText !== null) {
              lastRemoteClipboardTextRef.current = plainText;
              void navigator.clipboard?.writeText(plainText).catch(() => {});
            }
          } catch {
            // Ignore clipboard errors
          }
        });

        builder.forceClipboardUpdateCallback(() => {
          if (!disposed) void syncLocalClipboardToRdp();
        });

        // CLIPRDR bidirectional file transfer
        if (rdpConfig.clipboardFilesEnabled) {
          builder.extension(
            new mod.Extension(
              'files_available_callback',
              (
                files: Array<{ name?: string; size?: number; isDirectory?: boolean }>,
                clipDataId?: number,
              ) => {
                if (disposed) return;
                const offers: RemoteDesktopClipboardFileOffer[] = (Array.isArray(files) ? files : []).map(
                  (f, idx) => ({
                    index: idx,
                    name: String(f?.name || `file-${idx}`),
                    size: Number(f?.size) || 0,
                    isDirectory: Boolean(f?.isDirectory),
                  }),
                );
                remoteFilesRef.current = { clipDataId, files: offers };
                callbacksRef.current.onRemoteClipboardFilesChange?.(offers);
              },
            ),
          );

          builder.extension(
            new mod.Extension(
              'file_contents_request_callback',
              (req: {
                streamId: number;
                index: number;
                flags: number;
                position: number;
                size: number;
              }) => {
                if (disposed) return;
                const session = sessionRef.current;
                if (!session) return;
                const file = uploadedFilesRef.current[req.index];
                if (!file) {
                  try {
                    session.invokeExtension(
                      new mod.Extension('submit_file_contents', {
                        streamId: req.streamId,
                        isError: true,
                        data: new Uint8Array(0),
                      }),
                    );
                  } catch { /* ignore */ }
                  return;
                }

                if ((req.flags & FILE_CONTENTS_FLAG_SIZE) !== 0) {
                  const sizeBuf = new ArrayBuffer(8);
                  const dv = new DataView(sizeBuf);
                  const low = file.size >>> 0;
                  const high = Math.floor(file.size / 0x100000000) >>> 0;
                  dv.setUint32(0, low, true);
                  dv.setUint32(4, high, true);
                  try {
                    session.invokeExtension(
                      new mod.Extension('submit_file_contents', {
                        streamId: req.streamId,
                        isError: false,
                        data: new Uint8Array(sizeBuf),
                      }),
                    );
                  } catch { /* ignore */ }
                  return;
                }

                const startOffset = Math.max(0, Number(req.position) || 0);
                const requestedSize = Math.max(0, Number(req.size) || 0);
                const slice = file.slice(startOffset, startOffset + requestedSize);
                void slice
                  .arrayBuffer()
                  .then((ab) => {
                    if (disposed || !sessionRef.current) return;
                    sessionRef.current.invokeExtension(
                      new mod.Extension('submit_file_contents', {
                        streamId: req.streamId,
                        isError: false,
                        data: new Uint8Array(ab),
                      }),
                    );
                    const prevHighWater = uploadedHighWaterByIndexRef.current.get(req.index) ?? 0;
                    const nextHighWater = Math.max(
                      prevHighWater,
                      Math.min(file.size, startOffset + ab.byteLength),
                    );
                    uploadedHighWaterByIndexRef.current.set(req.index, nextHighWater);
                    const { transferredBytes, totalBytes, percent } = computeClipboardUploadProgress(
                      uploadedFilesRef.current,
                      uploadedHighWaterByIndexRef.current,
                    );
                    const isDone = totalBytes === 0
                      ? uploadedHighWaterByIndexRef.current.size >= uploadedFilesRef.current.length
                      : transferredBytes >= totalBytes;
                    const now = Date.now();
                    if (isDone || now - lastUploadProgressEmitRef.current >= PROGRESS_THROTTLE_MS) {
                      lastUploadProgressEmitRef.current = now;
                      const fileCount = uploadedFilesRef.current.length;
                      emitClipboardTransfer({
                        id: uploadTransferIdRef.current || `clip-up-${now}`,
                        direction: 'upload',
                        phase: isDone ? 'completed' : 'transferring',
                        fileName: file.name,
                        fileCount,
                        transferredBytes,
                        totalBytes,
                        percent: isDone ? 100 : percent,
                        message: isDone
                          ? `Sent ${fileCount > 1 ? `${fileCount} files` : file.name}`
                          : `Sending ${file.name} (${percent}%)`,
                      });
                    }
                  })
                  .catch((err) => {
                    if (disposed || !sessionRef.current) return;
                    try {
                      sessionRef.current.invokeExtension(
                        new mod.Extension('submit_file_contents', {
                          streamId: req.streamId,
                          isError: true,
                          data: new Uint8Array(0),
                        }),
                      );
                    } catch { /* ignore */ }
                    const errMessage = err instanceof Error
                      ? `Failed to send ${file.name}: ${err.message}`
                      : `Failed to send ${file.name}`;
                    const { transferredBytes, totalBytes, percent } = computeClipboardUploadProgress(
                      uploadedFilesRef.current,
                      uploadedHighWaterByIndexRef.current,
                    );
                    emitClipboardTransfer({
                      id: uploadTransferIdRef.current || `clip-up-${Date.now()}`,
                      direction: 'upload',
                      phase: 'error',
                      fileName: file.name,
                      fileCount: uploadedFilesRef.current.length || 1,
                      transferredBytes,
                      totalBytes,
                      percent,
                      message: errMessage,
                      error: errMessage,
                    });
                  });
              },
            ),
          );

          builder.extension(
            new mod.Extension(
              'file_contents_response_callback',
              (res: { streamId: number; isError?: boolean; data?: Uint8Array }) => {
                if (disposed) return;
                const state = pendingDownloadsRef.current.get(res.streamId);
                if (!state) return;
                pendingDownloadsRef.current.delete(res.streamId);
                const bridge = getRemoteDesktopBridge();
                const session = sessionRef.current;

                const abortDownload = async (msg: string) => {
                  if (state.saveStreamId && bridge) {
                    await bridge.saveClipboardFile({ action: 'abort', streamId: state.saveStreamId }).catch(() => {});
                  }
                  const pct = state.totalSize > 0
                    ? Math.min(100, Math.round((state.offset / state.totalSize) * 100))
                    : 0;
                  emitClipboardTransfer({
                    id: state.transferId,
                    direction: 'download',
                    phase: 'error',
                    fileName: state.file.name,
                    fileCount: 1,
                    transferredBytes: state.offset,
                    totalBytes: state.totalSize,
                    percent: pct,
                    message: msg,
                    error: msg,
                  });
                };

                if (res.isError) {
                  void abortDownload(`Failed to download ${state.file.name}`);
                  return;
                }

                const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(0);
                if (state.stage === 'size') {
                  if (bytes.byteLength < 8) {
                    void abortDownload(`Invalid file size for ${state.file.name}`);
                    return;
                  }
                  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
                  const totalSize = dv.getUint32(0, true) + dv.getUint32(4, true) * 0x100000000;
                  if (totalSize === 0 && state.saveStreamId && bridge) {
                    void bridge.saveClipboardFile({ action: 'finish', streamId: state.saveStreamId }).then(() => {
                      emitClipboardTransfer({
                        id: state.transferId,
                        direction: 'download',
                        phase: 'completed',
                        fileName: state.file.name,
                        fileCount: 1,
                        transferredBytes: 0,
                        totalBytes: 0,
                        percent: 100,
                        message: `Saved ${state.file.name}`,
                      });
                    });
                    return;
                  }
                  if (!session) {
                    void abortDownload(`Disconnected while preparing ${state.file.name}`);
                    return;
                  }
                  const nextStreamId = nextStreamIdRef.current++;
                  pendingDownloadsRef.current.set(nextStreamId, {
                    ...state,
                    stage: 'range',
                    totalSize,
                    offset: 0,
                    lastProgressEmitAt: Date.now(),
                  });
                  emitClipboardTransfer({
                    id: state.transferId,
                    direction: 'download',
                    phase: 'transferring',
                    fileName: state.file.name,
                    fileCount: 1,
                    transferredBytes: 0,
                    totalBytes: totalSize,
                    percent: 0,
                    message: `Downloading ${state.file.name}...`,
                  });
                  try {
                    session.invokeExtension(
                      new mod.Extension('request_file_contents', {
                        streamId: nextStreamId,
                        index: state.fileIndex,
                        flags: FILE_CONTENTS_FLAG_RANGE,
                        position: 0,
                        size: Math.min(FILE_CHUNK_SIZE, totalSize),
                        ...(state.clipDataId !== undefined ? { dataId: state.clipDataId } : {}),
                      }),
                    );
                  } catch {
                    pendingDownloadsRef.current.delete(nextStreamId);
                    void abortDownload(`Download interrupted for ${state.file.name}`);
                  }
                  return;
                }

                void (async () => {
                  if (!state.saveStreamId || !bridge) return;
                  if (bytes.byteLength > 0) {
                    const chunkRes = await bridge.saveClipboardFile({
                      action: 'chunk',
                      streamId: state.saveStreamId,
                      data: bytes,
                    });
                    if (!chunkRes?.ok) {
                      await abortDownload(chunkRes?.error || `Write error saving ${state.file.name}`);
                      return;
                    }
                  }
                  const nextOffset = state.offset + bytes.byteLength;
                  if (nextOffset >= state.totalSize || bytes.byteLength === 0) {
                    await bridge.saveClipboardFile({ action: 'finish', streamId: state.saveStreamId });
                    emitClipboardTransfer({
                      id: state.transferId,
                      direction: 'download',
                      phase: 'completed',
                      fileName: state.file.name,
                      fileCount: 1,
                      transferredBytes: state.totalSize || nextOffset,
                      totalBytes: state.totalSize || nextOffset,
                      percent: 100,
                      message: `Saved ${state.file.name}`,
                    });
                    return;
                  }
                  if (!sessionRef.current || disposed) {
                    await abortDownload(`Disconnected while saving ${state.file.name}`);
                    return;
                  }
                  const now = Date.now();
                  let nextProgressEmitAt = state.lastProgressEmitAt;
                  if (now - state.lastProgressEmitAt >= PROGRESS_THROTTLE_MS) {
                    nextProgressEmitAt = now;
                    const pct = state.totalSize > 0
                      ? Math.min(99, Math.round((nextOffset / state.totalSize) * 100))
                      : 0;
                    emitClipboardTransfer({
                      id: state.transferId,
                      direction: 'download',
                      phase: 'transferring',
                      fileName: state.file.name,
                      fileCount: 1,
                      transferredBytes: nextOffset,
                      totalBytes: state.totalSize,
                      percent: pct,
                      message: `Downloading ${state.file.name} (${pct}%)`,
                    });
                  }
                  const nextStreamId = nextStreamIdRef.current++;
                  pendingDownloadsRef.current.set(nextStreamId, {
                    ...state,
                    offset: nextOffset,
                    lastProgressEmitAt: nextProgressEmitAt,
                  });
                  try {
                    sessionRef.current.invokeExtension(
                      new mod.Extension('request_file_contents', {
                        streamId: nextStreamId,
                        index: state.fileIndex,
                        flags: FILE_CONTENTS_FLAG_RANGE,
                        position: nextOffset,
                        size: Math.min(FILE_CHUNK_SIZE, state.totalSize - nextOffset),
                        ...(state.clipDataId !== undefined ? { dataId: state.clipDataId } : {}),
                      }),
                    );
                  } catch {
                    pendingDownloadsRef.current.delete(nextStreamId);
                    await abortDownload(`Download interrupted for ${state.file.name}`);
                  }
                })();
              },
            ),
          );
        }

        let session: IronSession;
        try {
          session = await builder.connect();
        } catch (err) {
          if (disposed) return;
          const ironErr = err as { kind?: () => number; backtrace?: () => string; message?: string };
          const kind = typeof ironErr?.kind === 'function' ? ironErr.kind() : undefined;
          const msg = typeof ironErr?.backtrace === 'function'
            ? ironErr.backtrace()
            : err instanceof Error
              ? err.message
              : String(err);

          // CRITICAL: In `auto` mode, if negotiation fails BEFORE credentials are sent,
          // step through NLA -> TLS -> Standard RDP. NEVER auto-retry on WrongPassword /
          // LogonFailure / AccessDenied to prevent Windows NLA account lockout!
          const nextFallbackStage = resolveNextRdpAutoFallback({
            configuredMode: securityMode,
            currentStage: autoFallbackStage,
            isNegotiationFailure: kind === mod.IronErrorKind.NegotiationFailure,
            errorMessage: msg,
          });
          if (nextFallbackStage) {
            callbacksRef.current.onNegotiationFallbackNeeded?.(nextFallbackStage);
            return;
          }

          const isAuthError =
            kind === mod.IronErrorKind.WrongPassword
            || kind === mod.IronErrorKind.LogonFailure
            || kind === mod.IronErrorKind.AccessDenied;
          callbacksRef.current.onError({
            message: msg.split('\n')[0] || 'RDP connection failed',
            isAuthError,
            kind,
          });
          return;
        } finally {
          try { builder.free(); } catch { /* ignore */ }
        }

        if (disposed) {
          try { session.shutdown(); } catch { /* ignore */ }
          try { session.free(); } catch { /* ignore */ }
          return;
        }

        sessionRef.current = session;
        const size = session.desktopSize();
        const w = size.width || alignedW;
        const h = size.height || alignedH;
        try { size.free(); } catch { /* ignore */ }
        setRemoteSize({ width: w, height: h });
        setSessionConnectedSeq((seq) => seq + 1);
        callbacksRef.current.onConnected({
          width: w,
          height: h,
          encrypted: !enableStandardRdp,
          securityInfo: negotiatedSecurityInfo ?? undefined,
        });

        try {
          const termInfo = await session.run();
          if (!disposed) {
            callbacksRef.current.onDisconnected(termInfo?.reason?.() || undefined);
          }
          try { termInfo?.free?.(); } catch { /* ignore */ }
        } catch (runErr) {
          if (disposed) return;
          const ironErr = runErr as { kind?: () => number; backtrace?: () => string };
          const kind = typeof ironErr?.kind === 'function' ? ironErr.kind() : undefined;
          const msg = typeof ironErr?.backtrace === 'function'
            ? ironErr.backtrace()
            : runErr instanceof Error
              ? runErr.message
              : String(runErr);
          const isAuthError =
            kind === mod.IronErrorKind.WrongPassword
            || kind === mod.IronErrorKind.LogonFailure
            || kind === mod.IronErrorKind.AccessDenied;
          callbacksRef.current.onError({
            message: msg.split('\n')[0] || 'RDP session terminated',
            isAuthError,
            kind,
          });
        } finally {
          if (sessionRef.current === session) {
            sessionRef.current = null;
          }
          try { session.free(); } catch { /* ignore */ }
        }
      };

      // Defer WebSocket/IronRDP connect by a macrotask so React StrictMode's
      // synthetic unmount never opens a phantom socket that consumes the
      // one-time loopback WS token before the real mount connects.
      const startTimer = window.setTimeout(() => {
        if (!disposed) void start();
      }, 0);

      return () => {
        disposed = true;
        window.clearTimeout(startTimer);
        const session = sessionRef.current;
        sessionRef.current = null;
        if (session) {
          try { session.releaseAllInputs(); } catch { /* ignore */ }
          try { session.shutdown(); } catch { /* ignore */ }
        }
        audioPlayer?.dispose();
        audioPlayerRef.current = null;
        const bridge = getRemoteDesktopBridge();
        if (bridge?.rdpdrCleanup && propsRef.current.sessionId) {
          void bridge.rdpdrCleanup(propsRef.current.sessionId).catch(() => {});
        }
        for (const pending of pendingDownloads.values()) {
          if (pending.saveStreamId && bridge) {
            void bridge.saveClipboardFile({ action: 'abort', streamId: pending.saveStreamId }).catch(() => {});
          }
        }
        pendingDownloads.clear();
        uploadedHighWater.clear();
        uploadedFilesRef.current = [];
        remoteFilesRef.current = { files: [] };
        emitClipboardTransfer(null);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wsUrl, autoFallbackStage]);

    // Debounced dynamic resize via IronRDP Display Control channel
    useEffect(() => {
      if (displayMode !== 'dynamic') return undefined;
      if (fixedResolution || (monitorLayout && monitorLayout.length > 1)) return undefined;
      const container = containerRef.current;
      if (!container || typeof ResizeObserver === 'undefined') return undefined;
      let timerId: number | null = null;

      const scheduleResize = () => {
        if (timerId !== null) window.clearTimeout(timerId);
        timerId = window.setTimeout(() => {
          timerId = null;
          if (!propsRef.current.isVisible || !sessionRef.current) return;
          if (propsRef.current.fixedResolution || (propsRef.current.monitorLayout?.length ?? 0) > 1) return;
          const rect = container.getBoundingClientRect();
          const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const effectiveDpr = propsRef.current.highDpi ? Math.min(2, Math.max(1, rawDpr)) : 1;
          const scaleFactor = propsRef.current.highDpi
            ? Math.min(500, Math.max(100, Math.round(effectiveDpr * 100)))
            : 100;
          const rawW = Math.min(3840, Math.max(320, Math.floor(rect.width * effectiveDpr)));
          const rawH = Math.min(2160, Math.max(240, Math.floor(rect.height * effectiveDpr)));
          const targetW = rawW - (rawW % 2);
          const targetH = rawH - (rawH % 2);
          const currentSize = remoteSizeRef.current;
          const scaleChanged = lastSentScaleFactorRef.current !== null && lastSentScaleFactorRef.current !== scaleFactor;
          if (
            scaleChanged
            || Math.abs(targetW - currentSize.width) > 8
            || Math.abs(targetH - currentSize.height) > 8
          ) {
            lastSentScaleFactorRef.current = scaleFactor;
            try {
              sessionRef.current.resize(targetW, targetH, scaleFactor);
            } catch { /* ignore */ }
          }
        }, 200);
      };

      const observer = new ResizeObserver(scheduleResize);
      observer.observe(container);
      // Trigger immediately when switching into dynamic mode, toggling HiDPI, or right after connect
      scheduleResize();
      return () => {
        observer.disconnect();
        if (timerId !== null) window.clearTimeout(timerId);
      };
    }, [displayMode, fixedResolution, highDpi, monitorLayout, sessionConnectedSeq]);

    // Keep cached canvas/viewport DOMRect & container size in sync so high-frequency pointer moves avoid forced layout reads
    useEffect(() => {
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      const container = containerRef.current;
      const refreshRect = () => {
        const target = activeMonitorRectRef.current ? viewportRef.current : canvasRef.current;
        cachedCanvasRectRef.current = target?.getBoundingClientRect() ?? null;
        // containerSize is only consumed when slicing a single monitor from a multi-monitor desktop;
        // skipping state updates in single-monitor mode eliminates 60fps React re-renders during drag-resize.
        if (activeMonitorRectRef.current && container) {
          const cRect = container.getBoundingClientRect();
          if (cRect.width > 0 && cRect.height > 0) {
            setContainerSize((prev) => (
              Math.abs(prev.width - cRect.width) < 1 && Math.abs(prev.height - cRect.height) < 1
                ? prev
                : { width: cRect.width, height: cRect.height }
            ));
          }
        }
      };
      refreshRect();
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshRect) : null;
      if (observer && canvas) observer.observe(canvas);
      if (observer && viewport) observer.observe(viewport);
      if (observer && container) observer.observe(container);
      window.addEventListener('resize', refreshRect, { passive: true });
      container?.addEventListener('scroll', refreshRect, { passive: true });
      return () => {
        observer?.disconnect();
        window.removeEventListener('resize', refreshRect);
        container?.removeEventListener('scroll', refreshRect);
        if (pointerRafRef.current !== null) {
          window.cancelAnimationFrame(pointerRafRef.current);
          pointerRafRef.current = null;
        }
      };
    }, [activeMonitorRect, displayMode, isVisible, remoteSize.height, remoteSize.width]);

    const mapPointerCoords = useCallback((clientX: number, clientY: number, forceMeasure = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const slice = activeMonitorRectRef.current;
      const target = slice ? viewportRef.current : canvas;
      if (!target) return { x: 0, y: 0 };
      let rect = forceMeasure ? null : cachedCanvasRectRef.current;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        rect = target.getBoundingClientRect();
        cachedCanvasRectRef.current = rect;
      }
      return mapViewportToVirtualDesktopCoords(
        clientX,
        clientY,
        rect,
        { width: canvas.width, height: canvas.height },
        slice,
      );
    }, []);

    const flushPendingPointerMove = useCallback(() => {
      if (pointerRafRef.current !== null) {
        window.cancelAnimationFrame(pointerRafRef.current);
        pointerRafRef.current = null;
      }
      const pending = pendingPointerRef.current;
      if (!pending) return;
      pendingPointerRef.current = null;
      const lastSent = lastSentPointerRef.current;
      if (lastSent && lastSent.x === pending.x && lastSent.y === pending.y) return;
      lastSentPointerRef.current = pending;
      applyDeviceEvents((mod) => [mod.DeviceEvent.mouseMove(pending.x, pending.y)]);
    }, [applyDeviceEvents]);

    const handleMouseMove = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (propsRef.current.viewOnly) return;
        pendingPointerRef.current = mapPointerCoords(e.clientX, e.clientY);
        if (pointerRafRef.current === null) {
          pointerRafRef.current = window.requestAnimationFrame(flushPendingPointerMove);
        }
      },
      [flushPendingPointerMove, mapPointerCoords],
    );

    const handleMouseDown = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        imeInputRef.current?.focus({ preventScroll: true });
        audioPlayerRef.current?.resume();
        if (propsRef.current.viewOnly) return;
        e.preventDefault();
        if (pointerRafRef.current !== null) {
          window.cancelAnimationFrame(pointerRafRef.current);
          pointerRafRef.current = null;
        }
        pendingPointerRef.current = null;
        const { x, y } = mapPointerCoords(e.clientX, e.clientY, true);
        lastSentPointerRef.current = { x, y };
        applyDeviceEvents((mod) => [
          mod.DeviceEvent.mouseMove(x, y),
          mod.DeviceEvent.mouseButtonPressed(e.button),
        ]);
      },
      [applyDeviceEvents, mapPointerCoords],
    );

    const handleMouseUp = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (propsRef.current.viewOnly) return;
        e.preventDefault();
        if (pointerRafRef.current !== null) {
          window.cancelAnimationFrame(pointerRafRef.current);
          pointerRafRef.current = null;
        }
        pendingPointerRef.current = null;
        const { x, y } = mapPointerCoords(e.clientX, e.clientY);
        lastSentPointerRef.current = { x, y };
        applyDeviceEvents((mod) => [
          mod.DeviceEvent.mouseMove(x, y),
          mod.DeviceEvent.mouseButtonReleased(e.button),
        ]);
      },
      [applyDeviceEvents, mapPointerCoords],
    );

    const handleWheelNative = useCallback(
      (e: WheelEvent) => {
        if (propsRef.current.viewOnly) return;
        e.preventDefault();
        flushPendingPointerMove();
        const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
        const rawDelta = vertical ? -e.deltaY : e.deltaX;
        if (rawDelta === 0) return;
        applyDeviceEvents((mod) => {
          const unit =
            e.deltaMode === 1
              ? mod.RotationUnit.Line
              : e.deltaMode === 2
                ? mod.RotationUnit.Page
                : mod.RotationUnit.Pixel;
          const amount =
            unit === mod.RotationUnit.Pixel
              ? Math.sign(rawDelta) * Math.max(1, Math.min(120, Math.round(Math.abs(rawDelta))))
              : Math.round(rawDelta);
          return [mod.DeviceEvent.wheelRotations(vertical, amount, unit)];
        });
      },
      [applyDeviceEvents, flushPendingPointerMove],
    );

    const hasActiveMonitorSlice = Boolean(activeMonitorRect);
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      // Attach wheel listener with `{ passive: false }` so `preventDefault()` never logs
      // Chromium's "Unable to preventDefault inside passive event listener invocation".
      canvas.addEventListener('wheel', handleWheelNative, { passive: false });
      return () => {
        canvas.removeEventListener('wheel', handleWheelNative);
      };
    }, [handleWheelNative, hasActiveMonitorSlice]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (propsRef.current.keyboardGrabActive && isRemoteDesktopGrabReleaseChord(e.nativeEvent)) {
          e.preventDefault();
          e.stopPropagation();
          releaseAllInputs();
          callbacksRef.current.onRequestReleaseGrab();
          return;
        }
        if (propsRef.current.viewOnly) return;
        if (e.nativeEvent.isComposing || e.key === 'Process') return;

        const mapCmd = propsRef.current.mapCmdToCtrl;
        const isCmdMappedKey = mapCmd && (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.metaKey);

        if (!propsRef.current.keyboardGrabActive && !isCmdMappedKey && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
          return;
        }
        // When Cmd->Ctrl mapping is on (without keyboard grab), keep core app window/tab shortcuts local
        if (!propsRef.current.keyboardGrabActive && isCmdMappedKey && e.metaKey) {
          const code = e.code;
          if (code === 'KeyW' || code === 'KeyQ' || code === 'KeyT' || code === 'KeyN' || code === 'Comma' || code === 'KeyK') {
            return;
          }
        }

        const effectiveCode = mapCmd && (e.code === 'MetaLeft' || e.code === 'MetaRight')
          ? 'ControlLeft'
          : e.code;
        const scancode = domCodeToRdpScancode(effectiveCode);
        if (scancode === null) return;
        e.preventDefault();
        if (propsRef.current.keyboardGrabActive) {
          e.stopPropagation();
        }
        applyDeviceEvents((mod) => [mod.DeviceEvent.keyPressed(scancode)]);
      },
      [applyDeviceEvents, releaseAllInputs],
    );

    const handleKeyUp = useCallback(
      (e: React.KeyboardEvent) => {
        if (propsRef.current.keyboardGrabActive && e.code === 'AltRight') {
          const now = Date.now();
          if (now - lastAltRightUpRef.current < 350) {
            lastAltRightUpRef.current = 0;
            releaseAllInputs();
            callbacksRef.current.onRequestReleaseGrab();
            return;
          }
          lastAltRightUpRef.current = now;
        }
        if (propsRef.current.viewOnly) return;
        const effectiveCode = propsRef.current.mapCmdToCtrl && (e.code === 'MetaLeft' || e.code === 'MetaRight')
          ? 'ControlLeft'
          : e.code;
        const scancode = domCodeToRdpScancode(effectiveCode);
        if (scancode === null) return;
        e.preventDefault();
        applyDeviceEvents((mod) => [mod.DeviceEvent.keyReleased(scancode)]);
      },
      [applyDeviceEvents, releaseAllInputs],
    );

    const handleCompositionEnd = useCallback(
      (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        if (propsRef.current.viewOnly) return;
        const committed = e.data;
        if (committed) {
          applyDeviceEvents((mod) => {
            const events: IronDeviceEvent[] = [];
            for (const ch of committed) {
              events.push(mod.DeviceEvent.unicodePressed(ch));
              events.push(mod.DeviceEvent.unicodeReleased(ch));
            }
            return events;
          });
        }
        if (imeInputRef.current) {
          imeInputRef.current.value = '';
        }
      },
      [applyDeviceEvents],
    );

    const resetDragOverlay = useCallback(() => {
      dragDepthRef.current = 0;
      setDragOverlayState((prev) => (prev.active ? { active: false, itemCount: 0 } : prev));
    }, []);

    // Global reset prevents stuck drag overlay if user drops outside window or hits Esc.
    useEffect(() => {
      if (typeof window === 'undefined') return undefined;
      window.addEventListener('dragend', resetDragOverlay);
      window.addEventListener('drop', resetDragOverlay);
      window.addEventListener('blur', resetDragOverlay);
      return () => {
        window.removeEventListener('dragend', resetDragOverlay);
        window.removeEventListener('drop', resetDragOverlay);
        window.removeEventListener('blur', resetDragOverlay);
      };
    }, [resetDragOverlay]);

    const resolveDragOverlayMeta = useCallback(
      (dataTransfer: DataTransfer | null): { itemCount: number; blockedReason?: 'disabled' | 'view-only' } => {
        const items = dataTransfer?.items;
        let itemCount = 0;
        if (items && items.length > 0) {
          for (let i = 0; i < items.length; i += 1) {
            if (items[i].kind === 'file') itemCount += 1;
          }
        } else if (dataTransfer?.files?.length) {
          itemCount = dataTransfer.files.length;
        }
        const blockedReason: 'disabled' | 'view-only' | undefined = propsRef.current.viewOnly
          ? 'view-only'
          : !rdpConfig.clipboardFilesEnabled
            ? 'disabled'
            : undefined;
        return { itemCount, blockedReason };
      },
      [rdpConfig.clipboardFilesEnabled],
    );

    const handleDragEnter = useCallback(
      (e: React.DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        const { itemCount, blockedReason } = resolveDragOverlayMeta(e.dataTransfer);
        e.dataTransfer.dropEffect = blockedReason ? 'none' : 'copy';
        setDragOverlayState({ active: true, itemCount, blockedReason });
      },
      [resolveDragOverlayMeta],
    );

    const handleDragOver = useCallback(
      (e: React.DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        const { itemCount, blockedReason } = resolveDragOverlayMeta(e.dataTransfer);
        e.dataTransfer.dropEffect = blockedReason ? 'none' : 'copy';
        setDragOverlayState((prev) => (
          prev.active && prev.itemCount === itemCount && prev.blockedReason === blockedReason
            ? prev
            : { active: true, itemCount, blockedReason }
        ));
      },
      [resolveDragOverlayMeta],
    );

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
        resetDragOverlay();
      }
    }, [resetDragOverlay]);

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        resetDragOverlay();
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        if (!rdpConfig.clipboardFilesEnabled || propsRef.current.viewOnly) return;

        const validFiles: File[] = [];
        let skippedDirectory = false;
        const items = e.dataTransfer.items;
        if (items && items.length > 0) {
          for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            if (item.kind !== 'file') continue;
            const entry = getDataTransferItemEntry(item);
            if (entry?.isDirectory) {
              skippedDirectory = true;
              continue;
            }
            const file = item.getAsFile();
            if (file) validFiles.push(file);
          }
        } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          for (let i = 0; i < e.dataTransfer.files.length; i += 1) {
            const file = e.dataTransfer.files[i];
            if (file) validFiles.push(file);
          }
        }

        if (skippedDirectory) {
          toast.warning(
            tr(
              t,
              'remoteDesktop.clipboard.dropFolderUnsupported',
              'Folders are not supported over RDP clipboard. Use SFTP or archive them as a .zip file.',
            ),
          );
        }
        if (validFiles.length > 0) {
          void uploadLocalClipboardFiles(validFiles);
        }
      },
      [rdpConfig.clipboardFilesEnabled, resetDragOverlay, t, uploadLocalClipboardFiles],
    );

    const sliceViewportStyle: React.CSSProperties | undefined = (() => {
      if (!activeMonitorRect) return undefined;
      if (displayMode === 'stretch') {
        return { width: '100%', height: '100%', overflow: 'hidden', position: 'relative' };
      }
      if (displayMode === 'actual') {
        return {
          width: `${Math.round(activeMonitorRect.width)}px`,
          height: `${Math.round(activeMonitorRect.height)}px`,
          overflow: 'hidden',
          position: 'relative',
          flexShrink: 0,
        };
      }
      const cW = containerSize.width > 0 ? containerSize.width : activeMonitorRect.width;
      const cH = containerSize.height > 0 ? containerSize.height : activeMonitorRect.height;
      const scale = Math.min(cW / activeMonitorRect.width, cH / activeMonitorRect.height);
      return {
        width: `${Math.max(1, Math.floor(activeMonitorRect.width * scale))}px`,
        height: `${Math.max(1, Math.floor(activeMonitorRect.height * scale))}px`,
        overflow: 'hidden',
        position: 'relative',
        flexShrink: 0,
      };
    })();

    const canvasStyle: React.CSSProperties = (() => {
      const base: React.CSSProperties = {
        cursor: cursorCss,
        imageRendering: displayMode === 'actual' ? 'pixelated' : 'auto',
        transform: 'translateZ(0)',
      };
      if (activeMonitorRect) {
        const widthPct = (remoteSize.width / activeMonitorRect.width) * 100;
        const heightPct = (remoteSize.height / activeMonitorRect.height) * 100;
        const translateXPct = -(activeMonitorRect.left / remoteSize.width) * 100;
        const translateYPct = -(activeMonitorRect.top / remoteSize.height) * 100;
        return {
          ...base,
          display: 'block',
          width: `${widthPct}%`,
          height: `${heightPct}%`,
          maxWidth: 'none',
          maxHeight: 'none',
          transform: `translate(${translateXPct}%, ${translateYPct}%)`,
          transformOrigin: 'top left',
        };
      }
      if (displayMode === 'stretch') {
        return { ...base, width: '100%', height: '100%' };
      }
      if (displayMode === 'actual') {
        return { ...base, width: `${remoteSize.width}px`, height: `${remoteSize.height}px` };
      }
      return {
        ...base,
        maxWidth: '100%',
        maxHeight: '100%',
        width: 'auto',
        height: 'auto',
        objectFit: 'contain',
      };
    })();

    const canvasElement = (
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        onContextMenu={(e) => e.preventDefault()}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      />
    );

    return (
      <div
        ref={containerRef}
        className={cn(
          'relative flex h-full w-full flex-1 items-center justify-center bg-black outline-none',
          displayMode === 'actual' ? 'overflow-auto' : 'overflow-hidden',
        )}
        onMouseDown={() => imeInputRef.current?.focus({ preventScroll: true })}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <textarea
          ref={imeInputRef}
          aria-label="RDP keyboard input"
          className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => void syncLocalClipboardToRdp()}
          onBlur={releaseAllInputs}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onCompositionEnd={handleCompositionEnd}
          onInput={(e) => {
            const target = e.currentTarget;
            if (target.value) target.value = '';
          }}
        />
        {/* Keep <canvas> unconditionally wrapped in the same viewport div so switching
            activeMonitorIndex between 'all' and a single monitor NEVER unmounts <canvas>
            (IronRDP WASM binds renderCanvas to the original DOM element once at connect). */}
        <div
          ref={viewportRef}
          data-testid={activeMonitorRect ? 'rdp-monitor-slice-viewport' : undefined}
          style={
            activeMonitorRect
              ? sliceViewportStyle
              : {
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }
          }
        >
          {canvasElement}
        </div>
        {dragOverlayState.active && (
          <div
            data-testid="rdp-file-drop-overlay"
            data-drop-blocked={dragOverlayState.blockedReason ?? undefined}
            className={cn(
              'pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-2 backdrop-blur-[2px]',
              dragOverlayState.blockedReason ? 'bg-amber-500/12' : 'bg-blue-500/12',
            )}
          >
            <div
              className={cn(
                'flex h-full w-full items-center justify-center rounded-lg border-2 border-dashed',
                dragOverlayState.blockedReason ? 'border-amber-500/80' : 'border-blue-500/80',
              )}
            >
              <div className="flex max-w-sm flex-col items-center gap-2 rounded-xl border border-border/80 bg-background/95 px-5 py-4 text-center shadow-2xl">
                {dragOverlayState.blockedReason ? (
                  <>
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-500">
                      <AlertCircle size={20} />
                    </div>
                    <div className="text-xs font-semibold text-foreground">
                      {dragOverlayState.blockedReason === 'view-only'
                        ? tr(
                            t,
                            'remoteDesktop.clipboard.dropBlockedViewOnly',
                            'File drop is disabled in View-Only mode',
                          )
                        : tr(
                            t,
                            'remoteDesktop.clipboard.dropBlockedDisabled',
                            'Clipboard file transfer is disabled for this host',
                          )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/15 text-blue-500">
                      <UploadCloud size={20} />
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <span>
                        {tr(
                          t,
                          'remoteDesktop.clipboard.dropTitle',
                          'Drop files to send to remote clipboard (CLIPRDR)',
                        )}
                      </span>
                      {dragOverlayState.itemCount > 0 && (
                        <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-500">
                          {tr(
                            t,
                            'remoteDesktop.clipboard.dropFileCount',
                            '{count} file(s)',
                            { count: dragOverlayState.itemCount },
                          )}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {tr(
                        t,
                        'remoteDesktop.clipboard.dropSubtitle',
                        'After dropping, press Ctrl+V inside the remote desktop to paste',
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
));
