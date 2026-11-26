import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
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
} from './remoteDesktopHelpers';

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
} as const;

const C2S = {
  POINTER: 0x10,
  KEY: 0x11,
  QEMU_KEY: 0x12,
  RESIZE: 0x13,
  CLIPBOARD: 0x14,
  REFRESH: 0x15,
  PAUSE: 0x16,
} as const;

export interface VncCanvasViewProps {
  wsUrl: string;
  isVisible: boolean;
  displayMode: RemoteDesktopDisplayMode;
  viewOnly: boolean;
  clipboardSyncEnabled: boolean;
  showRemoteCursor: boolean;
  keyboardGrabActive: boolean;
  onRequestReleaseGrab: () => void;
  onConnected: (info: {
    width: number;
    height: number;
    name?: string;
    securityName?: string;
    encrypted?: boolean;
  }) => void;
  onDesktopResize: (size: { width: number; height: number }) => void;
  onDesktopName?: (name: string) => void;
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

export const VncCanvasView = React.memo(forwardRef<RemoteDesktopCanvasHandle, VncCanvasViewProps>(
  function VncCanvasView(
    {
      wsUrl,
      isVisible,
      displayMode,
      viewOnly,
      clipboardSyncEnabled,
      showRemoteCursor,
      keyboardGrabActive,
      onRequestReleaseGrab,
      onConnected,
      onDesktopResize,
      onDesktopName,
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
    const lastCursorCacheRef = useRef<{ key: string; css: string } | null>(null);
    const cachedCanvasRectRef = useRef<DOMRect | null>(null);
    const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);
    const pointerRafRef = useRef<number | null>(null);
    const lastSentPointerRef = useRef<{ x: number; y: number; buttons: number } | null>(null);
    const imeInputRef = useRef<HTMLTextAreaElement | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const supportsRef = useRef<{ extendedDesktopSize?: boolean; qemuExtendedKeyEvent?: boolean }>({});
    const pressedKeysRef = useRef<Map<string, { keysym: number; keycode: number | null }>>(new Map());
    const buttonsMaskRef = useRef(0);
    const lastPointerPosRef = useRef({ x: 0, y: 0 });
    const lastRemoteClipboardRef = useRef('');
    const lastAltRightUpRef = useRef(0);
    const paintChainRef = useRef<Promise<void>>(Promise.resolve());
    const frameCountRef = useRef(0);
    const lastReportedFpsRef = useRef<number | null>(null);
    const [remoteSize, setRemoteSize] = useState<{ width: number; height: number }>({ width: 1280, height: 800 });
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
      onDesktopResize,
      onDesktopName,
      onFpsChange,
      onError,
      onDisconnected,
      onRequestReleaseGrab,
    });
    callbacksRef.current = {
      onConnected,
      onDesktopResize,
      onDesktopName,
      onFpsChange,
      onError,
      onDisconnected,
      onRequestReleaseGrab,
    };

    const propsRef = useRef({ viewOnly, clipboardSyncEnabled, showRemoteCursor, isVisible, keyboardGrabActive });
    propsRef.current = { viewOnly, clipboardSyncEnabled, showRemoteCursor, isVisible, keyboardGrabActive };

    const sendBinary = useCallback((frame: Uint8Array) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }, []);

    const sendKeyRaw = useCallback(
      (keysym: number, keycode: number | null, down: boolean) => {
        if (propsRef.current.viewOnly) return;
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
        sendKeyRaw(entry.keysym, entry.keycode, false);
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

    const requestRefresh = useCallback(() => {
      sendBinary(buildRefreshFrame(false));
    }, [sendBinary]);

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
        requestRefresh,
      }),
      [
        captureFrame,
        captureScreenshot,
        getCanvasRect,
        getCaptureStream,
        releaseAllInputs,
        requestRefresh,
        sendSpecialKey,
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

    // Resize canvas helper preserving previous contents
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
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const enqueuePaint = (fn: () => void | Promise<void>) => {
        paintChainRef.current = paintChainRef.current
          .then(() => {
            if (disposed) return;
            return fn();
          })
          .catch(() => {});
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
                supports?: { extendedDesktopSize?: boolean; qemuExtendedKeyEvent?: boolean };
              };
              supportsRef.current = info.supports ?? {};
              const w = Math.max(1, Number(info.width) || 1280);
              const h = Math.max(1, Number(info.height) || 800);
              resizeBackingCanvas(w, h);
              const secName = info.securityName || '';
              const encrypted = /tls|x509|vencrypt|ra2|ard/i.test(secName);
              callbacksRef.current.onConnected({
                width: w,
                height: h,
                name: info.name,
                securityName: secName,
                encrypted,
              });
              if (!propsRef.current.isVisible) {
                ws.send(buildPauseFrame(true));
              }
            } catch {
              // ignore malformed READY
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
            enqueuePaint(() => {
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
            enqueuePaint(() => {
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
            enqueuePaint(async () => {
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
            const hotX = view.getUint16(1, false);
            const hotY = view.getUint16(3, false);
            const w = view.getUint16(5, false);
            const h = view.getUint16(7, false);
            if (!propsRef.current.showRemoteCursor) {
              setCursorCss((prev) => (prev === 'default' ? prev : 'default'));
              break;
            }
            if (w === 0 || h === 0) {
              setCursorCss((prev) => (prev === 'none' ? prev : 'none'));
              break;
            }
            const expectedLen = w * h * 4;
            if (bytes.byteLength < 9 + expectedLen) break;
            // Fast FNV-1a fingerprint avoids re-encoding identical remote cursor bitmaps
            let hash = 0x811c9dc5;
            for (let i = 9; i < 9 + expectedLen; i += 4) {
              hash ^= bytes[i] ^ (bytes[i + 1] << 8) ^ (bytes[i + 2] << 16) ^ (bytes[i + 3] << 24);
              hash = Math.imul(hash, 0x01000193);
            }
            const cursorKey = `${w}x${h}:${hotX},${hotY}:${hash >>> 0}`;
            if (lastCursorCacheRef.current?.key === cursorKey) {
              const cachedCss = lastCursorCacheRef.current.css;
              setCursorCss((prev) => (prev === cachedCss ? prev : cachedCss));
              break;
            }
            const offscreen = cursorCanvasRef.current ?? document.createElement('canvas');
            cursorCanvasRef.current = offscreen;
            if (offscreen.width !== w) offscreen.width = w;
            if (offscreen.height !== h) offscreen.height = h;
            const offCtx = offscreen.getContext('2d');
            if (offCtx) {
              const imgData = new ImageData(new Uint8ClampedArray(event.data, 9, expectedLen), w, h);
              offCtx.putImageData(imgData, 0, 0);
              const url = offscreen.toDataURL('image/png');
              const css = `url("${url}") ${hotX} ${hotY}, auto`;
              lastCursorCacheRef.current = { key: cursorKey, css };
              setCursorCss((prev) => (prev === css ? prev : css));
            }
            break;
          }

          case S2C.DESKTOP_SIZE: {
            if (bytes.byteLength < 5) break;
            const w = view.getUint16(1, false);
            const h = view.getUint16(3, false);
            if (w > 0 && h > 0) {
              enqueuePaint(() => {
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

      return () => {
        disposed = true;
        wsRef.current = null;
        try {
          ws.close();
        } catch { /* ignore */ }
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

    // Debounced dynamic resize when container size changes
    useEffect(() => {
      if (displayMode !== 'dynamic') return undefined;
      const container = containerRef.current;
      if (!container || typeof ResizeObserver === 'undefined') return undefined;
      let timerId: number | null = null;

      const scheduleResize = () => {
        if (timerId !== null) window.clearTimeout(timerId);
        timerId = window.setTimeout(() => {
          timerId = null;
          if (!propsRef.current.isVisible) return;
          if (!supportsRef.current.extendedDesktopSize) return;
          const rect = container.getBoundingClientRect();
          const targetW = Math.max(320, Math.floor(rect.width));
          const targetH = Math.max(240, Math.floor(rect.height));
          if (Math.abs(targetW - remoteSize.width) > 8 || Math.abs(targetH - remoteSize.height) > 8) {
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
    }, [displayMode, remoteSize.height, remoteSize.width, sendBinary]);

    // Sync local clipboard to VNC server on focus when enabled
    const syncLocalClipboardToServer = useCallback(() => {
      if (!propsRef.current.clipboardSyncEnabled || propsRef.current.viewOnly) return;
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text && text !== lastRemoteClipboardRef.current) {
            lastRemoteClipboardRef.current = text;
            sendBinary(buildClipboardFrame(text));
          }
        })
        .catch(() => {});
    }, [sendBinary]);

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
        const pos = mapPointerCoords(e.clientX, e.clientY);
        lastPointerPosRef.current = pos;
        pendingPointerRef.current = pos;
        if (pointerRafRef.current === null) {
          pointerRafRef.current = window.requestAnimationFrame(flushPendingPointerMove);
        }
      },
      [flushPendingPointerMove, mapPointerCoords],
    );

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

    const handleWheel = useCallback(
      (e: React.WheelEvent<HTMLCanvasElement>) => {
        if (propsRef.current.viewOnly) return;
        e.preventDefault();
        flushPendingPointerMove();
        const pos = mapPointerCoords(e.clientX, e.clientY);
        lastPointerPosRef.current = pos;
        let wheelBit = 0;
        if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          wheelBit = e.deltaY < 0 ? 8 : e.deltaY > 0 ? 16 : 0;
        } else {
          wheelBit = e.deltaX < 0 ? 32 : e.deltaX > 0 ? 64 : 0;
        }
        if (wheelBit === 0) return;
        sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current | wheelBit));
        sendBinary(buildPointerFrame(pos.x, pos.y, buttonsMaskRef.current));
      },
      [flushPendingPointerMove, mapPointerCoords, sendBinary],
    );

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

        // When keyboard grab is inactive, let standard app shortcuts (Cmd/Ctrl+W/T/K/1-9, etc.) pass through.
        if (!propsRef.current.keyboardGrabActive && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
          return;
        }

        const keysym = domEventToVncKeysym(e.nativeEvent);
        if (keysym === null) return;
        e.preventDefault();
        if (propsRef.current.keyboardGrabActive) {
          e.stopPropagation();
        }
        const keycode = domCodeToQemuKeycode(e.code);
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
        const keysym = domEventToVncKeysym(e.nativeEvent);
        if (keysym === null) return;
        e.preventDefault();
        sendKeyRaw(keysym, domCodeToQemuKeycode(e.code), false);
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
          onFocus={syncLocalClipboardToServer}
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
          onWheel={handleWheel}
        />
      </div>
    );
  },
));
