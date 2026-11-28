import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  permilleToFramebufferCoord,
  resolveChordToVncKeysyms,
  resolveKeyToVncKeysym,
  type RemoteDesktopAction,
} from '../../domain/remoteDesktopActionCodec';
import {
  captureFrameFromCanvas,
  type RemoteDesktopCaptureRequest,
  type RemoteDesktopProviderFrame,
} from '../../infrastructure/remoteDesktop/remoteDesktopSnapshotRegistry';
import { cn } from '../../lib/utils';
import {
  domCodeToQemuKeycode,
  domEventToVncKeysym,
  textToVncKeysymSequence,
  unicodeCharToVncKeysym,
  VNC_SPECIAL_CHORDS,
  type RemoteDesktopSpecialKeyId,
} from './vncKeymap';
import {
  isRemoteDesktopGrabReleaseChord,
  type RemoteDesktopCanvasHandle,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopQualityPreset,
  type RemoteDesktopRecordingCaptureHandle,
} from './remoteDesktopHelpers';
import {
  captureCanvasThumbnailJpeg,
  createStableCanvasCaptureStream,
} from './remoteDesktopVideoCapture';

// VNC Binary WebSocket Opcodes (must match electron/bridges/remoteDesktopBridge.cjs)
const S2C = {
  READY: 0x01,
  RAW_RGBA: 0x02,
  COPY_RECT: 0x03,
  JPEG: 0x04,
  CURSOR: 0x05,
  DESKTOP_SIZE: 0x06,
  CLIPBOARD: 0x07,
  BELL: 0x08,
  DESKTOP_NAME: 0x09,
  ERROR: 0x0a,
  FRAME_SYNC: 0x0b,
  CAPABILITIES: 0x0c,
} as const;

const C2S = {
  POINTER: 0x10,
  KEY: 0x11,
  QEMU_KEY: 0x12,
  RESIZE: 0x13,
  CLIPBOARD: 0x14,
  REFRESH: 0x15,
  PAUSE: 0x16,
  SET_ENCODINGS: 0x17,
  SET_READ_ONLY: 0x18,
  XVP: 0x19,
} as const;

export interface VncCapabilities {
  extendedDesktopSize?: boolean;
  unicodeClipboard?: boolean;
  extendedClipboard?: boolean;
  qemuExtendedKeyEvent?: boolean;
  continuousUpdates?: boolean;
  fence?: boolean;
  xvp?: boolean;
}

export interface VncCanvasViewProps {
  wsUrl: string;
  isVisible: boolean;
  displayMode: RemoteDesktopDisplayMode;
  viewOnly: boolean;
  clipboardSyncEnabled: boolean;
  showRemoteCursor: boolean;
  mapCmdToCtrl?: boolean;
  keyboardGrabActive: boolean;
  onRequestReleaseGrab: () => void;
  onConnected: (info: {
    width: number;
    height: number;
    name?: string;
    securityName?: string;
    encrypted?: boolean;
    supportsDynamicResize?: boolean;
    supportsXvp?: boolean;
  }) => void;
  onCapabilitiesChange?: (supports: VncCapabilities) => void;
  onDesktopResize: (size: { width: number; height: number }) => void;
  onDesktopName?: (name: string) => void;
  onBell?: () => void;
  onFpsChange?: (fps: number) => void;
  onError: (error: { code?: string; message: string; isAuthError?: boolean }) => void;
  onDisconnected: (reason?: string) => void;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function buildPointerFrame(x: number, y: number, buttons: number): Uint8Array {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  buf[0] = C2S.POINTER;
  view.setUint16(1, Math.max(0, Math.min(65535, Math.round(x))), false);
  view.setUint16(3, Math.max(0, Math.min(65535, Math.round(y))), false);
  buf[5] = buttons & 0xff;
  return buf;
}

function buildKeyFrame(keysym: number, down: boolean): Uint8Array {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  buf[0] = C2S.KEY;
  view.setUint32(1, keysym >>> 0, false);
  buf[5] = down ? 1 : 0;
  return buf;
}

function buildQemuKeyFrame(keysym: number, keycode: number, down: boolean): Uint8Array {
  const buf = new Uint8Array(10);
  const view = new DataView(buf.buffer);
  buf[0] = C2S.QEMU_KEY;
  view.setUint32(1, keysym >>> 0, false);
  view.setUint32(5, keycode >>> 0, false);
  buf[9] = down ? 1 : 0;
  return buf;
}

function buildResizeFrame(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  buf[0] = C2S.RESIZE;
  view.setUint16(1, Math.max(1, Math.min(8192, Math.round(width))), false);
  view.setUint16(3, Math.max(1, Math.min(8192, Math.round(height))), false);
  return buf;
}

function buildClipboardFrame(text: string): Uint8Array {
  const bytes = textEncoder.encode(text);
  const buf = new Uint8Array(1 + bytes.byteLength);
  buf[0] = C2S.CLIPBOARD;
  buf.set(bytes, 1);
  return buf;
}

function buildPauseFrame(paused: boolean): Uint8Array {
  return new Uint8Array([C2S.PAUSE, paused ? 1 : 0]);
}

function buildRefreshFrame(incremental: boolean): Uint8Array {
  return new Uint8Array([C2S.REFRESH, incremental ? 1 : 0]);
}

function buildSetEncodingsFrame(quality: RemoteDesktopQualityPreset): Uint8Array {
  const bytes = textEncoder.encode(quality);
  const buf = new Uint8Array(1 + bytes.byteLength);
  buf[0] = C2S.SET_ENCODINGS;
  buf.set(bytes, 1);
  return buf;
}

function buildSetReadOnlyFrame(readOnly: boolean): Uint8Array {
  return new Uint8Array([C2S.SET_READ_ONLY, readOnly ? 1 : 0]);
}

function buildXvpFrame(action: 'shutdown' | 'reboot' | 'reset'): Uint8Array {
  const bytes = textEncoder.encode(action);
  const buf = new Uint8Array(1 + bytes.byteLength);
  buf[0] = C2S.XVP;
  buf.set(bytes, 1);
  return buf;
}

const MAX_CURSOR_CACHE_ENTRIES = 24;
const MAX_CSS_CURSOR_DIM = 128;

export const VncCanvasView = React.memo(forwardRef<RemoteDesktopCanvasHandle, VncCanvasViewProps>(
  function VncCanvasView(
    {
      wsUrl,
      isVisible,
      displayMode,
      viewOnly,
      clipboardSyncEnabled,
      showRemoteCursor,
      mapCmdToCtrl = false,
      keyboardGrabActive,
      onRequestReleaseGrab,
      onConnected,
      onCapabilitiesChange,
      onDesktopResize,
      onDesktopName,
      onBell,
      onFpsChange,
      onError,
      onDisconnected,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const cursorCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const cursorCacheRef = useRef<Map<string, string>>(new Map());
    const lastRemoteCursorCssRef = useRef<string>('default');
    const cachedCanvasRectRef = useRef<DOMRect | null>(null);
    const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);
    const pointerRafRef = useRef<number | null>(null);
    const lastSentPointerRef = useRef<{ x: number; y: number; buttons: number } | null>(null);
    const wheelAccumRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const imeInputRef = useRef<HTMLTextAreaElement | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const supportsRef = useRef<VncCapabilities>({});
    const [dynamicResizeReadySeq, setDynamicResizeReadySeq] = useState(0);
    const pressedKeysRef = useRef<Map<string, { keysym: number; keycode: number | null }>>(new Map());
    const buttonsMaskRef = useRef(0);
    const lastPointerPosRef = useRef({ x: 0, y: 0 });
    const lastRemoteClipboardRef = useRef('');
    const lastAltRightUpRef = useRef(0);
    const paintChainRef = useRef<Promise<void>>(Promise.resolve());
    const frameCountRef = useRef(0);
    const lastReportedFpsRef = useRef<number | null>(null);
    const [remoteSize, setRemoteSize] = useState<{ width: number; height: number }>({ width: 1280, height: 800 });
    const remoteSizeRef = useRef(remoteSize);
    remoteSizeRef.current = remoteSize;
    const [cursorCss, setCursorCss] = useState<string>('default');

    const getCanvasContext = useCallback((): CanvasRenderingContext2D | null => {
      const canvas = canvasRef.current;
      if (!canvas) {
        ctxRef.current = null;
        return null;
      }
      if (!ctxRef.current || ctxRef.current.canvas !== canvas) {
        ctxRef.current = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
      }
      return ctxRef.current;
    }, []);

    // Keep latest callbacks in refs so WS effect never tears down on re-renders.
    const callbacksRef = useRef({
      onConnected,
      onCapabilitiesChange,
      onDesktopResize,
      onDesktopName,
      onBell,
      onFpsChange,
      onError,
      onDisconnected,
      onRequestReleaseGrab,
    });
    callbacksRef.current = {
      onConnected,
      onCapabilitiesChange,
      onDesktopResize,
      onDesktopName,
      onBell,
      onFpsChange,
      onError,
      onDisconnected,
      onRequestReleaseGrab,
    };

    const propsRef = useRef({
      viewOnly,
      clipboardSyncEnabled,
      showRemoteCursor,
      mapCmdToCtrl,
      isVisible,
      keyboardGrabActive,
    });
    propsRef.current = {
      viewOnly,
      clipboardSyncEnabled,
      showRemoteCursor,
      mapCmdToCtrl,
      isVisible,
      keyboardGrabActive,
    };

    const sendBinary = useCallback((frame: Uint8Array) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }, []);

    const sendKeyRaw = useCallback(
      (keysym: number, keycode: number | null, down: boolean, bypassViewOnly = false) => {
        if (!bypassViewOnly && propsRef.current.viewOnly) return;
        if (supportsRef.current.qemuExtendedKeyEvent && keycode !== null) {
          sendBinary(buildQemuKeyFrame(keysym, keycode, down));
        } else {
          sendBinary(buildKeyFrame(keysym, down));
        }
      },
      [sendBinary],
    );

    const releaseAllInputs = useCallback(() => {
      for (const entry of pressedKeysRef.current.values()) {
        // Always bypass viewOnly when releasing keys that were already pressed.
        sendKeyRaw(entry.keysym, entry.keycode, false, true);
      }
      pressedKeysRef.current.clear();
      if (buttonsMaskRef.current !== 0) {
        buttonsMaskRef.current = 0;
        const { x, y } = lastPointerPosRef.current;
        sendBinary(buildPointerFrame(x, y, 0));
      }
    }, [sendBinary, sendKeyRaw]);

    const sendSpecialKey = useCallback(
      (id: RemoteDesktopSpecialKeyId) => {
        if (propsRef.current.viewOnly) return;
        const chord = VNC_SPECIAL_CHORDS[id];
        if (!chord || chord.length === 0) return;
        for (const sym of chord) {
          sendBinary(buildKeyFrame(sym, true));
        }
        for (let i = chord.length - 1; i >= 0; i -= 1) {
          sendBinary(buildKeyFrame(chord[i], false));
        }
      },
      [sendBinary],
    );

    const typeText = useCallback(
      (text: string) => {
        if (propsRef.current.viewOnly || !text) return;
        const keysyms = textToVncKeysymSequence(text);
        for (const sym of keysyms) {
          sendBinary(buildKeyFrame(sym, true));
          sendBinary(buildKeyFrame(sym, false));
        }
      },
      [sendBinary],
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
          protocol: 'vnc',
        });
      },
      [],
    );

    const getCanvasRect = useCallback((): DOMRect | null => {
      return canvasRef.current?.getBoundingClientRect() ?? null;
    }, []);

    const captureThumbnailJpeg = useCallback(async (): Promise<Uint8Array | null> => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      return captureCanvasThumbnailJpeg(canvas);
    }, []);

    const getCaptureStream = useCallback((fps: number): MediaStream | null => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      if (typeof canvas.captureStream !== 'function') return null;
      try {
        return canvas.captureStream(fps);
      } catch {
        return null;
      }
    }, []);

    const createRecordingCapture = useCallback(
      (fps: number): RemoteDesktopRecordingCaptureHandle | null => {
        const canvas = canvasRef.current;
        if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
        return createStableCanvasCaptureStream(canvas, fps);
      },
      [],
    );

    const focusInput = useCallback(() => {
      imeInputRef.current?.focus({ preventScroll: true });
    }, []);

    // Sync local clipboard to VNC server on focus or manual request
    const syncLocalClipboardToServer = useCallback((force = false) => {
      if ((!force && !propsRef.current.clipboardSyncEnabled) || propsRef.current.viewOnly) return;
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text && (force || text !== lastRemoteClipboardRef.current)) {
            lastRemoteClipboardRef.current = text;
            sendBinary(buildClipboardFrame(text));
          }
        })
        .catch(() => {});
    }, [sendBinary]);

    const syncClipboardNow = useCallback(() => syncLocalClipboardToServer(true), [syncLocalClipboardToServer]);

    const requestRefresh = useCallback(() => {
      sendBinary(buildRefreshFrame(false));
    }, [sendBinary]);

    const resizeToPreset = useCallback(
      (width: number, height: number) => {
        if (!supportsRef.current.extendedDesktopSize) return;
        const targetW = Math.max(320, Math.min(8192, Math.round(width)));
        const targetH = Math.max(240, Math.min(8192, Math.round(height)));
        sendBinary(buildResizeFrame(targetW, targetH));
      },
      [sendBinary],
    );

    const setQuality = useCallback(
      (quality: RemoteDesktopQualityPreset) => {
        sendBinary(buildSetEncodingsFrame(quality));
      },
      [sendBinary],
    );

    const sendXvpAction = useCallback(
      (action: 'shutdown' | 'reboot' | 'reset') => {
        if (propsRef.current.viewOnly) return;
        if (!supportsRef.current.xvp) return;
        sendBinary(buildXvpFrame(action));
      },
      [sendBinary],
    );

    const performAiAction = useCallback(
      async (action: RemoteDesktopAction, options?: { signal?: AbortSignal }): Promise<void> => {
        const signal = options?.signal;
        if (signal?.aborted) return;
        if (propsRef.current.viewOnly) {
          throw new Error('VNC session is in view-only mode.');
        }
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error('VNC session is not connected.');
        }
        const isCancelled = () => Boolean(
          signal?.aborted
          || propsRef.current.viewOnly
          || wsRef.current !== ws
          || ws.readyState !== WebSocket.OPEN,
        );
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
        const fbW = Math.max(1, canvas?.width || remoteSizeRef.current.width || 1280);
        const fbH = Math.max(1, canvas?.height || remoteSizeRef.current.height || 800);

        const glidePointerTo = async (targetX: number, targetY: number) => {
          if (isCancelled()) return;
          const prev = lastPointerPosRef.current;
          const dx = targetX - prev.x;
          const dy = targetY - prev.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 6) {
            lastPointerPosRef.current = { x: targetX, y: targetY };
            sendBinary(buildPointerFrame(targetX, targetY, 0));
            return;
          }
          const steps = Math.max(6, Math.min(14, Math.round(dist / 85) + 5));
          const stepDelay = 14;
          for (let step = 1; step <= steps; step += 1) {
            if (isCancelled()) return;
            const t = step / steps;
            const eased = 1 - Math.pow(1 - t, 3);
            const ix = Math.round(prev.x + dx * eased);
            const iy = Math.round(prev.y + dy * eased);
            lastPointerPosRef.current = { x: ix, y: iy };
            sendBinary(buildPointerFrame(ix, iy, 0));
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
            const btnBit = action.button === 'right' ? 4 : action.button === 'middle' ? 2 : 1;
            const clickCount = action.clickCount ?? 1;
            await glidePointerTo(x, y);
            if (isCancelled()) return;
            const modSyms: number[] = [];
            for (const mod of action.modifiers ?? []) {
              const sym = resolveKeyToVncKeysym(mod);
              if (sym !== null) modSyms.push(sym);
            }
            let buttonHeld = false;
            let modsHeld = false;
            try {
              for (const sym of modSyms) {
                sendBinary(buildKeyFrame(sym, true));
              }
              modsHeld = modSyms.length > 0;
              for (let i = 0; i < clickCount; i += 1) {
                if (isCancelled()) break;
                if (i > 0) {
                  await sleep(45);
                  if (isCancelled()) break;
                }
                sendBinary(buildPointerFrame(x, y, btnBit));
                buttonHeld = true;
                await sleep(24);
                sendBinary(buildPointerFrame(x, y, 0));
                buttonHeld = false;
              }
            } finally {
              if (buttonHeld) {
                const pos = lastPointerPosRef.current;
                sendBinary(buildPointerFrame(pos.x, pos.y, 0));
              }
              if (modsHeld) {
                for (let i = modSyms.length - 1; i >= 0; i -= 1) {
                  sendBinary(buildKeyFrame(modSyms[i], false));
                }
              }
            }
            return;
          }

          case 'drag': {
            const startX = permilleToFramebufferCoord(action.fromX, fbW);
            const startY = permilleToFramebufferCoord(action.fromY, fbH);
            const endX = permilleToFramebufferCoord(action.toX, fbW);
            const endY = permilleToFramebufferCoord(action.toY, fbH);
            const btnBit = action.button === 'right' ? 4 : 1;
            const steps = Math.max(6, Math.min(40, Math.round(action.steps ?? 12)));
            await glidePointerTo(startX, startY);
            if (isCancelled()) return;
            await sleep(20);
            if (isCancelled()) return;
            let buttonHeld = false;
            try {
              sendBinary(buildPointerFrame(startX, startY, btnBit));
              buttonHeld = true;
              for (let step = 1; step <= steps; step += 1) {
                if (isCancelled()) break;
                await sleep(16);
                if (isCancelled()) break;
                const t = step / steps;
                const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                const ix = Math.round(startX + (endX - startX) * eased);
                const iy = Math.round(startY + (endY - startY) * eased);
                lastPointerPosRef.current = { x: ix, y: iy };
                sendBinary(buildPointerFrame(ix, iy, btnBit));
              }
              if (!isCancelled()) {
                await sleep(18);
              }
              if (!isCancelled()) {
                lastPointerPosRef.current = { x: endX, y: endY };
                sendBinary(buildPointerFrame(endX, endY, 0));
                buttonHeld = false;
              }
            } finally {
              if (buttonHeld) {
                const pos = lastPointerPosRef.current;
                sendBinary(buildPointerFrame(pos.x, pos.y, 0));
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
            if (dy !== 0) {
              const bit = dy < 0 ? 8 : 16;
              const ticks = Math.max(1, Math.min(20, Math.round(Math.abs(dy) / 100) || 1));
              for (let i = 0; i < ticks; i += 1) {
                if (isCancelled()) break;
                if (i > 0) await sleep(18);
                if (isCancelled()) break;
                sendBinary(buildPointerFrame(x, y, bit));
                sendBinary(buildPointerFrame(x, y, 0));
              }
            }
            if (dx !== 0) {
              const bit = dx < 0 ? 32 : 64;
              const ticks = Math.max(1, Math.min(20, Math.round(Math.abs(dx) / 100) || 1));
              for (let i = 0; i < ticks; i += 1) {
                if (isCancelled()) break;
                if (i > 0) await sleep(18);
                if (isCancelled()) break;
                sendBinary(buildPointerFrame(x, y, bit));
                sendBinary(buildPointerFrame(x, y, 0));
              }
            }
            return;
          }

          case 'type': {
            if (isCancelled()) return;
            const keysyms = textToVncKeysymSequence(action.text);
            for (const sym of keysyms) {
              if (isCancelled()) break;
              sendBinary(buildKeyFrame(sym, true));
              sendBinary(buildKeyFrame(sym, false));
            }
            return;
          }

          case 'key': {
            if (isCancelled()) return;
            const chord = resolveChordToVncKeysyms(action.key);
            if (!chord || chord.length === 0) {
              throw new Error(`Unsupported VNC key chord: ${action.key}`);
            }
            for (const sym of chord) {
              sendBinary(buildKeyFrame(sym, true));
            }
            try {
              await sleep(20);
            } finally {
              for (let i = chord.length - 1; i >= 0; i -= 1) {
                sendBinary(buildKeyFrame(chord[i], false));
              }
            }
            return;
          }
        }
      },
      [sendBinary],
    );

    useImperativeHandle(
      ref,
      () => ({
        sendSpecialKey,
        typeText,
        releaseAllInputs,
        captureScreenshot,
        captureThumbnailJpeg,
        captureFrame,
        getCanvasRect,
        getCaptureStream,
        createRecordingCapture,
        focusInput,
        syncClipboardNow,
        requestRefresh,
        resizeToPreset,
        setQuality,
        sendXvpAction,
        performAiAction,
      }),
      [
        captureFrame,
        captureScreenshot,
        captureThumbnailJpeg,
        createRecordingCapture,
        focusInput,
        getCanvasRect,
        getCaptureStream,
        performAiAction,
        releaseAllInputs,
        requestRefresh,
        resizeToPreset,
        sendSpecialKey,
        sendXvpAction,
        setQuality,
        syncClipboardNow,
        typeText,
      ],
    );

    // FPS telemetry ticker (skips hidden tabs and deduplicates unchanged values)
    useEffect(() => {
      const timer = window.setInterval(() => {
        const frames = frameCountRef.current;
        frameCountRef.current = 0;
        if (!propsRef.current.isVisible) return;
        if (lastReportedFpsRef.current === frames) return;
        lastReportedFpsRef.current = frames;
        callbacksRef.current.onFpsChange?.(frames);
      }, 1000);
      return () => window.clearInterval(timer);
    }, []);

    // Pause / resume server updates when tab visibility toggles
    useEffect(() => {
      sendBinary(buildPauseFrame(!isVisible));
      if (!isVisible) {
        releaseAllInputs();
      }
    }, [isVisible, releaseAllInputs, sendBinary]);

    // Sync viewOnly live to backend and release any held inputs when entering view-only mode
    useEffect(() => {
      if (viewOnly) {
        releaseAllInputs();
      }
      sendBinary(buildSetReadOnlyFrame(viewOnly));
    }, [releaseAllInputs, sendBinary, viewOnly]);

    // Sync remote cursor CSS immediately when showRemoteCursor toggles
    useEffect(() => {
      setCursorCss(showRemoteCursor ? lastRemoteCursorCssRef.current : 'default');
    }, [showRemoteCursor]);

    // Sync local clipboard when returning from another OS app while this tab is visible
    useEffect(() => {
      if (!isVisible) return undefined;
      const onWinFocus = () => {
        syncLocalClipboardToServer(false);
      };
      window.addEventListener('focus', onWinFocus);
      return () => window.removeEventListener('focus', onWinFocus);
    }, [isVisible, syncLocalClipboardToServer]);

    // Resize canvas helper (clears backing buffer on dimension change)
    const resizeBackingCanvas = useCallback((width: number, height: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      setRemoteSize({ width: canvas.width, height: canvas.height });
      callbacksRef.current.onDesktopResize({ width: canvas.width, height: canvas.height });
    }, []);

    // Main WebSocket connection lifecycle
    useEffect(() => {
      let disposed = false;
      let reportedError = false;
      let ws: WebSocket | null = null;
      paintChainRef.current = Promise.resolve();

      // Defer WebSocket creation by a macrotask so React StrictMode's synthetic
      // unmount cancels cleanly without consuming the one-time loopback token.
      const connectTimer = window.setTimeout(() => {
        if (disposed) return;
        const socket = new WebSocket(wsUrl);
        socket.binaryType = 'arraybuffer';
        ws = socket;
        wsRef.current = socket;
        attachSocketHandlers(socket);
      }, 0);

      const attachSocketHandlers = (ws: WebSocket) => {
      let pendingAsyncPaints = 0;

      // Fast path: paint synchronous rects (RAW_RGBA / COPY_RECT) directly with zero Promise
      // allocation whenever no async createImageBitmap decode is in flight, while preserving
      // strict RFB painter's order whenever a JPEG decode is queued ahead of them.
      const enqueueSyncPaint = (fn: () => void) => {
        if (pendingAsyncPaints === 0) {
          try {
            fn();
          } catch {
            // ignore transient canvas errors
          }
          return;
        }
        paintChainRef.current = paintChainRef.current
          .then(() => fn())
          .catch(() => {});
      };

      const enqueueAsyncPaint = (fn: () => Promise<void>) => {
        pendingAsyncPaints += 1;
        paintChainRef.current = paintChainRef.current
          .then(() => fn())
          .catch(() => {})
          .finally(() => {
            pendingAsyncPaints = Math.max(0, pendingAsyncPaints - 1);
          });
      };

      ws.onmessage = (event) => {
        if (disposed || !(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.byteLength < 1) return;
        const view = new DataView(event.data);
        const opcode = bytes[0];

        switch (opcode) {
          case S2C.READY: {
            try {
              const info = JSON.parse(textDecoder.decode(bytes.subarray(1))) as {
                width?: number;
                height?: number;
                name?: string;
                securityName?: string;
                supports?: VncCapabilities;
              };
              const caps = info.supports ?? {};
              supportsRef.current = caps;
              const w = Math.max(1, Number(info.width) || 1280);
              const h = Math.max(1, Number(info.height) || 800);
              enqueueSyncPaint(() => {
                if (disposed) return;
                resizeBackingCanvas(w, h);
              });
              const secName = info.securityName || '';
              const encrypted = /tls|x509|vencrypt|ra2|ard/i.test(secName);
              callbacksRef.current.onConnected({
                width: w,
                height: h,
                name: info.name,
                securityName: secName,
                encrypted,
                supportsDynamicResize: Boolean(caps.extendedDesktopSize),
                supportsXvp: Boolean(caps.xvp),
              });
              if (caps.extendedDesktopSize) {
                setDynamicResizeReadySeq((n) => n + 1);
              }
              ws.send(buildSetReadOnlyFrame(propsRef.current.viewOnly));
              if (!propsRef.current.isVisible) {
                ws.send(buildPauseFrame(true));
              }
            } catch {
              // ignore malformed READY
            }
            break;
          }

          case S2C.CAPABILITIES: {
            try {
              const msg = JSON.parse(textDecoder.decode(bytes.subarray(1))) as {
                supports?: VncCapabilities;
              };
              if (msg.supports) {
                const hadDynamic = Boolean(supportsRef.current.extendedDesktopSize);
                supportsRef.current = { ...supportsRef.current, ...msg.supports };
                callbacksRef.current.onCapabilitiesChange?.(supportsRef.current);
                if (!hadDynamic && supportsRef.current.extendedDesktopSize) {
                  setDynamicResizeReadySeq((n) => n + 1);
                }
              }
            } catch {
              // ignore malformed CAPABILITIES
            }
            break;
          }

          case S2C.RAW_RGBA: {
            if (bytes.byteLength < 9) break;
            const x = view.getUint16(1, false);
            const y = view.getUint16(3, false);
            const w = view.getUint16(5, false);
            const h = view.getUint16(7, false);
            const expectedLen = w * h * 4;
            if (w === 0 || h === 0 || bytes.byteLength < 9 + expectedLen) break;
            // Zero-copy view over the owned WebSocket ArrayBuffer
            const pixelView = new Uint8ClampedArray(event.data, 9, expectedLen);
            enqueueSyncPaint(() => {
              if (disposed) return;
              const ctx = getCanvasContext();
              if (!ctx) return;
              const imgData = new ImageData(pixelView, w, h);
              ctx.putImageData(imgData, x, y);
            });
            break;
          }

          case S2C.COPY_RECT: {
            if (bytes.byteLength < 13) break;
            const x = view.getUint16(1, false);
            const y = view.getUint16(3, false);
            const w = view.getUint16(5, false);
            const h = view.getUint16(7, false);
            const srcX = view.getUint16(9, false);
            const srcY = view.getUint16(11, false);
            if (w === 0 || h === 0) break;
            enqueueSyncPaint(() => {
              if (disposed) return;
              const canvas = canvasRef.current;
              const ctx = getCanvasContext();
              if (!canvas || !ctx) return;
              ctx.drawImage(canvas, srcX, srcY, w, h, x, y, w, h);
            });
            break;
          }

          case S2C.JPEG: {
            if (bytes.byteLength < 9) break;
            const x = view.getUint16(1, false);
            const y = view.getUint16(3, false);
            const w = view.getUint16(5, false);
            const h = view.getUint16(7, false);
            if (w === 0 || h === 0) break;
            const jpegBlob = new Blob([bytes.subarray(9)], { type: 'image/jpeg' });
            const bitmapPromise = createImageBitmap(jpegBlob).catch(() => null);
            // Always run callback so `bitmap.close()` is guaranteed even if disposed mid-decode!
            enqueueAsyncPaint(async () => {
              const bitmap = await bitmapPromise;
              if (!bitmap) return;
              try {
                if (disposed) return;
                const ctx = getCanvasContext();
                if (!ctx) return;
                ctx.drawImage(bitmap, x, y, w, h);
              } finally {
                bitmap.close();
              }
            });
            break;
          }

          case S2C.CURSOR: {
            if (bytes.byteLength < 9) break;
            const rawHotX = view.getUint16(1, false);
            const rawHotY = view.getUint16(3, false);
            const w = view.getUint16(5, false);
            const h = view.getUint16(7, false);
            if (w === 0 || h === 0) {
              lastRemoteCursorCssRef.current = 'none';
              if (propsRef.current.showRemoteCursor) {
                setCursorCss((prev) => (prev === 'none' ? prev : 'none'));
              }
              break;
            }
            const expectedLen = w * h * 4;
            if (bytes.byteLength < 9 + expectedLen) break;
            // Fast FNV-1a fingerprint + 24-entry LRU cache avoids PNG re-encoding churn
            let hash = 0x811c9dc5;
            for (let i = 9; i < 9 + expectedLen; i += 4) {
              hash ^= bytes[i] ^ (bytes[i + 1] << 8) ^ (bytes[i + 2] << 16) ^ (bytes[i + 3] << 24);
              hash = Math.imul(hash, 0x01000193);
            }
            const cursorKey = `${w}x${h}:${rawHotX},${rawHotY}:${hash >>> 0}`;
            const cachedCss = cursorCacheRef.current.get(cursorKey);
            if (cachedCss) {
              // Refresh LRU recency
              cursorCacheRef.current.delete(cursorKey);
              cursorCacheRef.current.set(cursorKey, cachedCss);
              lastRemoteCursorCssRef.current = cachedCss;
              if (propsRef.current.showRemoteCursor) {
                setCursorCss((prev) => (prev === cachedCss ? prev : cachedCss));
              }
              break;
            }
            const scale = Math.max(w, h) > MAX_CSS_CURSOR_DIM
              ? MAX_CSS_CURSOR_DIM / Math.max(w, h)
              : 1;
            const outW = Math.max(1, Math.round(w * scale));
            const outH = Math.max(1, Math.round(h * scale));
            const hotX = Math.max(0, Math.min(outW - 1, Math.round(rawHotX * scale)));
            const hotY = Math.max(0, Math.min(outH - 1, Math.round(rawHotY * scale)));

            const offscreen = cursorCanvasRef.current ?? document.createElement('canvas');
            cursorCanvasRef.current = offscreen;
            if (offscreen.width !== outW) offscreen.width = outW;
            if (offscreen.height !== outH) offscreen.height = outH;
            const offCtx = offscreen.getContext('2d');
            if (offCtx) {
              const imgData = new ImageData(new Uint8ClampedArray(event.data, 9, expectedLen), w, h);
              if (scale === 1) {
                offCtx.putImageData(imgData, 0, 0);
              } else {
                const tmp = document.createElement('canvas');
                tmp.width = w;
                tmp.height = h;
                tmp.getContext('2d')?.putImageData(imgData, 0, 0);
                offCtx.clearRect(0, 0, outW, outH);
                offCtx.drawImage(tmp, 0, 0, outW, outH);
              }
              const url = offscreen.toDataURL('image/png');
              const css = `url("${url}") ${hotX} ${hotY}, auto`;
              if (cursorCacheRef.current.size >= MAX_CURSOR_CACHE_ENTRIES) {
                const oldestKey = cursorCacheRef.current.keys().next().value;
                if (oldestKey !== undefined) cursorCacheRef.current.delete(oldestKey);
              }
              cursorCacheRef.current.set(cursorKey, css);
              lastRemoteCursorCssRef.current = css;
              if (propsRef.current.showRemoteCursor) {
                setCursorCss((prev) => (prev === css ? prev : css));
              }
            }
            break;
          }

          case S2C.DESKTOP_SIZE: {
            if (bytes.byteLength < 5) break;
            const w = view.getUint16(1, false);
            const h = view.getUint16(3, false);
            if (w > 0 && h > 0) {
              enqueueSyncPaint(() => {
                if (disposed) return;
                resizeBackingCanvas(w, h);
              });
            }
            break;
          }

          case S2C.CLIPBOARD: {
            if (!propsRef.current.clipboardSyncEnabled) break;
            const text = textDecoder.decode(bytes.subarray(1));
            lastRemoteClipboardRef.current = text;
            void navigator.clipboard?.writeText(text).catch(() => {});
            break;
          }

          case S2C.BELL: {
            callbacksRef.current.onBell?.();
            break;
          }

          case S2C.DESKTOP_NAME: {
            const name = textDecoder.decode(bytes.subarray(1));
            callbacksRef.current.onDesktopName?.(name);
            break;
          }

          case S2C.ERROR: {
            try {
              const err = JSON.parse(textDecoder.decode(bytes.subarray(1))) as {
                code?: string;
                message?: string;
              };
              const msg = err.message || 'VNC session error';
              const isAuthError = /auth|password|credential|denied|rejected|security/i.test(
                `${err.code || ''} ${msg}`,
              );
              reportedError = true;
              callbacksRef.current.onError({ code: err.code, message: msg, isAuthError });
            } catch {
              reportedError = true;
              callbacksRef.current.onError({ message: 'VNC protocol error' });
            }
            break;
          }

          case S2C.FRAME_SYNC: {
            frameCountRef.current += 1;
            break;
          }

          default:
            break;
        }
      };

      ws.onerror = () => {
        if (disposed || reportedError) return;
        reportedError = true;
        callbacksRef.current.onError({ message: 'VNC WebSocket connection failed' });
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        wsRef.current = null;
        callbacksRef.current.onDisconnected(ev.reason || undefined);
      };
      };

      const cursorCache = cursorCacheRef.current;
      return () => {
        disposed = true;
        window.clearTimeout(connectTimer);
        paintChainRef.current = Promise.resolve();
        cursorCache.clear();
        cursorCanvasRef.current = null;
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (ws) {
          try {
            ws.close();
          } catch { /* ignore */ }
        }
      };
    }, [getCanvasContext, resizeBackingCanvas, wsUrl]);

    // Keep cached canvas DOMRect in sync so high-frequency pointer moves avoid forced layout reads
    useEffect(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const refreshRect = () => {
        cachedCanvasRectRef.current = canvasRef.current?.getBoundingClientRect() ?? null;
      };
      refreshRect();
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshRect) : null;
      if (observer && canvas) observer.observe(canvas);
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
    }, [displayMode, isVisible, remoteSize.height, remoteSize.width]);

    // Debounced dynamic resize when container size changes (uses remoteSizeRef to prevent resize loops)
    useEffect(() => {
      if (displayMode !== 'dynamic') return undefined;
      const container = containerRef.current;
      if (!container || typeof ResizeObserver === 'undefined') return undefined;
      let timerId: number | null = null;

      const scheduleResize = () => {
        if (timerId !== null) window.clearTimeout(timerId);
        timerId = window.setTimeout(() => {
          timerId = null;
          if (!propsRef.current.isVisible || propsRef.current.viewOnly) return;
          if (!supportsRef.current.extendedDesktopSize) return;
          const rect = container.getBoundingClientRect();
          const targetW = Math.max(320, Math.floor(rect.width));
          const targetH = Math.max(240, Math.floor(rect.height));
          const cur = remoteSizeRef.current;
          if (Math.abs(targetW - cur.width) > 8 || Math.abs(targetH - cur.height) > 8) {
            sendBinary(buildResizeFrame(targetW, targetH));
          }
        }, 250);
      };

      const observer = new ResizeObserver(scheduleResize);
      observer.observe(container);
      scheduleResize();
      return () => {
        observer.disconnect();
        if (timerId !== null) window.clearTimeout(timerId);
      };
    }, [displayMode, dynamicResizeReadySeq, sendBinary]);

    const mapPointerCoords = useCallback((clientX: number, clientY: number, forceMeasure = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      let rect = forceMeasure ? null : cachedCanvasRectRef.current;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        rect = canvas.getBoundingClientRect();
        cachedCanvasRectRef.current = rect;
      }
      if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round(((clientX - rect.left) / rect.width) * canvas.width)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round(((clientY - rect.top) / rect.height) * canvas.height)));
      return { x, y };
    }, []);

    const flushPendingPointerMove = useCallback(() => {
      if (pointerRafRef.current !== null) {
        window.cancelAnimationFrame(pointerRafRef.current);
        pointerRafRef.current = null;
      }
      const pending = pendingPointerRef.current;
      if (!pending) return;
      pendingPointerRef.current = null;
      const buttons = buttonsMaskRef.current;
      const lastSent = lastSentPointerRef.current;
      if (lastSent && lastSent.x === pending.x && lastSent.y === pending.y && lastSent.buttons === buttons) {
        return;
      }
      lastSentPointerRef.current = { x: pending.x, y: pending.y, buttons };
      sendBinary(buildPointerFrame(pending.x, pending.y, buttons));
    }, [sendBinary]);

    const updateButtonBit = (button: number, down: boolean) => {
      let bit = 0;
      if (button === 0) bit = 1;
      else if (button === 1) bit = 2;
      else if (button === 2) bit = 4;
      if (!bit) return;
      if (down) buttonsMaskRef.current |= bit;
      else buttonsMaskRef.current &= ~bit;
    };

    const handleMouseMove = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (propsRef.current.viewOnly) return;
        // Reconcile button mask against actual DOM `e.buttons` in case release occurred outside canvas
        const domMask =
          ((e.buttons & 1) ? 1 : 0)
          | ((e.buttons & 4) ? 2 : 0)
          | ((e.buttons & 2) ? 4 : 0);
        if (buttonsMaskRef.current !== domMask) {
          buttonsMaskRef.current = domMask;
        }
        const pos = mapPointerCoords(e.clientX, e.clientY);
        lastPointerPosRef.current = pos;
        pendingPointerRef.current = pos;
        if (pointerRafRef.current === null) {
          pointerRafRef.current = window.requestAnimationFrame(flushPendingPointerMove);
        }
      },
      [flushPendingPointerMove, mapPointerCoords],
    );

    // Release stuck mouse buttons if the user drags outside the canvas and releases
    useEffect(() => {
      const onWindowMouseUp = () => {
        if (buttonsMaskRef.current === 0) return;
        buttonsMaskRef.current = 0;
        const { x, y } = lastPointerPosRef.current;
        lastSentPointerRef.current = { x, y, buttons: 0 };
        sendBinary(buildPointerFrame(x, y, 0));
      };
      window.addEventListener('mouseup', onWindowMouseUp);
      return () => window.removeEventListener('mouseup', onWindowMouseUp);
    }, [sendBinary]);

    const handleMouseDown = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        imeInputRef.current?.focus({ preventScroll: true });
        if (propsRef.current.viewOnly) return;
        e.preventDefault();
        if (pointerRafRef.current !== null) {
          window.cancelAnimationFrame(pointerRafRef.current);
          pointerRafRef.current = null;
        }
        pendingPointerRef.current = null;
        const pos = mapPointerCoords(e.clientX, e.clientY, true);
        lastPointerPosRef.current = pos;
        updateButtonBit(e.button, true);
        lastSentPointerRef.current = { x: pos.x, y: pos.y, buttons: buttonsMaskRef.current };
        sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current));
      },
      [mapPointerCoords, sendBinary],
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
        const pos = mapPointerCoords(e.clientX, e.clientY);
        lastPointerPosRef.current = pos;
        updateButtonBit(e.button, false);
        lastSentPointerRef.current = { x: pos.x, y: pos.y, buttons: buttonsMaskRef.current };
        sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current));
      },
      [mapPointerCoords, sendBinary],
    );

    const handleWheelNative = useCallback(
      (e: WheelEvent) => {
        if (propsRef.current.viewOnly) return;
        e.preventDefault();
        flushPendingPointerMove();
        const pos = mapPointerCoords(e.clientX, e.clientY);
        lastPointerPosRef.current = pos;
        // Accumulate high-resolution pixel deltas (e.g. macOS trackpads) so 1px inertia events
        // do not fire full discrete RFB wheel button clicks on every frame.
        const THRESHOLD_PX = 40;
        const emitAxisTicks = (delta: number, axis: 'x' | 'y', negBit: number, posBit: number) => {
          if (delta === 0) return;
          if (e.deltaMode !== 0) {
            // Line or page wheel mouse: emit discrete tick directly
            const bit = delta < 0 ? negBit : posBit;
            sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current | bit));
            sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current));
            return;
          }
          const next = wheelAccumRef.current[axis] + delta;
          const ticks = Math.trunc(next / THRESHOLD_PX);
          wheelAccumRef.current[axis] = next - ticks * THRESHOLD_PX;
          if (ticks === 0) return;
          const bit = ticks < 0 ? negBit : posBit;
          const count = Math.min(5, Math.abs(ticks));
          for (let i = 0; i < count; i += 1) {
            sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current | bit));
            sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current));
          }
        };
        if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          emitAxisTicks(e.deltaY, 'y', 8, 16);
        } else {
          emitAxisTicks(e.deltaX, 'x', 32, 64);
        }
      },
      [flushPendingPointerMove, mapPointerCoords, sendBinary],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      canvas.addEventListener('wheel', handleWheelNative, { passive: false });
      return () => {
        canvas.removeEventListener('wheel', handleWheelNative);
      };
    }, [handleWheelNative]);

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

        // When keyboard grab is inactive, let standard app shortcuts (Cmd/Ctrl+W/T/K/1-9, etc.) pass through.
        if (!propsRef.current.keyboardGrabActive && !isCmdMappedKey && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
          return;
        }
        if (!propsRef.current.keyboardGrabActive && isCmdMappedKey && e.metaKey) {
          const code = e.code;
          if (code === 'KeyW' || code === 'KeyQ' || code === 'KeyT' || code === 'KeyN' || code === 'Comma' || code === 'KeyK') {
            return;
          }
        }

        const isMetaKey = mapCmd && (e.code === 'MetaLeft' || e.code === 'MetaRight');
        const keysym = isMetaKey ? 0xffe3 : domEventToVncKeysym(e.nativeEvent);
        if (keysym === null) return;
        e.preventDefault();
        if (propsRef.current.keyboardGrabActive) {
          e.stopPropagation();
        }
        const keycode = domCodeToQemuKeycode(isMetaKey ? 'ControlLeft' : e.code);
        pressedKeysRef.current.set(e.code || e.key, { keysym, keycode });
        sendKeyRaw(keysym, keycode, true);
      },
      [releaseAllInputs, sendKeyRaw],
    );

    const handleKeyUp = useCallback(
      (e: React.KeyboardEvent) => {
        // Double-tap Right Alt / Option releases Keyboard Grab
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
        const trackedKey = e.code || e.key;
        const tracked = pressedKeysRef.current.get(trackedKey);
        if (tracked) {
          pressedKeysRef.current.delete(trackedKey);
          e.preventDefault();
          sendKeyRaw(tracked.keysym, tracked.keycode, false);
          return;
        }
        // Only send key-up for keys that were actually pressed while focused on this canvas
      },
      [releaseAllInputs, sendKeyRaw],
    );

    const handleCompositionEnd = useCallback(
      (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        if (propsRef.current.viewOnly) return;
        const committed = e.data;
        if (committed) {
          for (const ch of committed) {
            const sym = unicodeCharToVncKeysym(ch);
            if (sym !== null) {
              sendBinary(buildKeyFrame(sym, true));
              sendBinary(buildKeyFrame(sym, false));
            }
          }
        }
        if (imeInputRef.current) {
          imeInputRef.current.value = '';
        }
      },
      [sendBinary],
    );

    const canvasStyle: React.CSSProperties = (() => {
      const base: React.CSSProperties = {
        cursor: showRemoteCursor ? cursorCss : 'default',
        imageRendering: displayMode === 'actual' ? 'pixelated' : 'auto',
        transform: 'translateZ(0)',
      };
      if (displayMode === 'stretch') {
        return { ...base, width: '100%', height: '100%' };
      }
      if (displayMode === 'actual') {
        return { ...base, width: `${remoteSize.width}px`, height: `${remoteSize.height}px` };
      }
      // fit or dynamic
      return {
        ...base,
        maxWidth: '100%',
        maxHeight: '100%',
        width: 'auto',
        height: 'auto',
        objectFit: 'contain',
      };
    })();

    return (
      <div
        ref={containerRef}
        className={cn(
          'relative flex h-full w-full flex-1 items-center justify-center bg-black outline-none',
          displayMode === 'actual' ? 'overflow-auto' : 'overflow-hidden',
        )}
        onMouseDown={() => imeInputRef.current?.focus({ preventScroll: true })}
      >
        <textarea
          ref={imeInputRef}
          aria-label="VNC keyboard input"
          className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => syncLocalClipboardToServer(false)}
          onBlur={releaseAllInputs}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onCompositionEnd={handleCompositionEnd}
          onInput={(e) => {
            // Clear non-IME characters so the hidden textarea stays empty
            const target = e.currentTarget;
            if (target.value) target.value = '';
          }}
        />
        <canvas
          ref={canvasRef}
          style={canvasStyle}
          onContextMenu={(e) => e.preventDefault()}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        />
      </div>
    );
  },
));
