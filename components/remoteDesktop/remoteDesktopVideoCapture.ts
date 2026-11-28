import type { RemoteDesktopRecordingCaptureHandle } from './remoteDesktopHelpers';

export const MAX_RECORDING_VIDEO_WIDTH = 1920;
export const MAX_RECORDING_VIDEO_HEIGHT = 1080;
export const DEFAULT_THUMBNAIL_MAX_WIDTH = 320;
export const DEFAULT_THUMBNAIL_MAX_HEIGHT = 240;
export const DEFAULT_THUMBNAIL_JPEG_QUALITY = 0.72;

/**
 * Compute even-aligned output dimensions capped within `maxWidth x maxHeight`
 * while preserving the source aspect ratio. Capping at 1080p avoids burning
 * 4x GPU/CPU/RAM when recording HiDPI / 4K remote desktop canvases in Electron.
 */
export function computeRecordingCanvasDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = MAX_RECORDING_VIDEO_WIDTH,
  maxHeight = MAX_RECORDING_VIDEO_HEIGHT,
): { width: number; height: number } {
  const safeW = Number.isFinite(sourceWidth) && sourceWidth > 0 ? Math.floor(sourceWidth) : 1280;
  const safeH = Number.isFinite(sourceHeight) && sourceHeight > 0 ? Math.floor(sourceHeight) : 720;
  const scale = Math.min(1, maxWidth / safeW, maxHeight / safeH);
  const rawW = Math.max(2, Math.floor(safeW * scale));
  const rawH = Math.max(2, Math.floor(safeH * scale));
  return {
    width: rawW - (rawW % 2),
    height: rawH - (rawH % 2),
  };
}

/**
 * Compute aspect-fit destination rectangle for blitting a (potentially resized)
 * source canvas onto a fixed-size recording staging canvas.
 */
export function computeAspectFitRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { dx: number; dy: number; dw: number; dh: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { dx: 0, dy: 0, dw: Math.max(0, targetWidth), dh: Math.max(0, targetHeight) };
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const dw = Math.max(1, Math.round(sourceWidth * scale));
  const dh = Math.max(1, Math.round(sourceHeight * scale));
  const dx = Math.floor((targetWidth - dw) / 2);
  const dy = Math.floor((targetHeight - dh) / 2);
  return { dx, dy, dw, dh };
}

/**
 * Create a resize-safe, fixed-cadence recording capture handle backed by an
 * offscreen staging `<canvas>`.
 *
 * Why a staging canvas instead of direct `sourceCanvas.captureStream(fps)`:
 * 1. Dynamic RDP resize mutates `sourceCanvas.width`/`height` mid-session,
 *    which can break Chromium's VP8/VP9 MediaRecorder or corrupt keyframes.
 * 2. Capping to <= 1080p keeps Electron memory & encoder CPU bounded on 4K/HiDPI.
 * 3. Blitting frame 0 synchronously guarantees non-empty recordings even when
 *    the remote desktop is completely idle/static.
 * 4. `dispose()` explicitly stops intervals, stops all MediaStreamTracks,
 *    releases audio keepalive, and zeroes `stagingCanvas.width/height` so
 *    Skia/GPU backing memory is freed immediately.
 */
export function createStableCanvasCaptureStream(
  sourceCanvas: HTMLCanvasElement,
  fps: number,
  options?: {
    audioStream?: MediaStream | null;
    onReleaseAudio?: () => void;
    maxWidth?: number;
    maxHeight?: number;
  },
): RemoteDesktopRecordingCaptureHandle | null {
  if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0 || typeof document === 'undefined') {
    options?.onReleaseAudio?.();
    return null;
  }

  const stagingCanvas = document.createElement('canvas');
  if (typeof stagingCanvas.captureStream !== 'function') {
    options?.onReleaseAudio?.();
    return null;
  }

  const { width, height } = computeRecordingCanvasDimensions(
    sourceCanvas.width,
    sourceCanvas.height,
    options?.maxWidth,
    options?.maxHeight,
  );
  stagingCanvas.width = width;
  stagingCanvas.height = height;

  const ctx = stagingCanvas.getContext('2d', { alpha: false });
  if (!ctx) {
    stagingCanvas.width = 0;
    stagingCanvas.height = 0;
    options?.onReleaseAudio?.();
    return null;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';

  let lastSrcW = 0;
  let lastSrcH = 0;
  let disposed = false;

  const drawCurrentFrame = () => {
    if (disposed) return;
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (sw <= 0 || sh <= 0) return;
    try {
      if (sw === width && sh === height) {
        ctx.drawImage(sourceCanvas, 0, 0, width, height);
        lastSrcW = sw;
        lastSrcH = sh;
        return;
      }
      const { dx, dy, dw, dh } = computeAspectFitRect(sw, sh, width, height);
      // Clear letterbox bars whenever source dimensions change and do not fill target completely.
      if ((dx > 0 || dy > 0 || dw < width || dh < height) && (sw !== lastSrcW || sh !== lastSrcH)) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(sourceCanvas, 0, 0, sw, sh, dx, dy, dw, dh);
      lastSrcW = sw;
      lastSrcH = sh;
    } catch {
      // Source canvas may be mid-resize or detached; skip this tick safely.
    }
  };

  // Paint frame 0 immediately so static desktops produce valid keyframes.
  drawCurrentFrame();

  const safeFps = Number.isFinite(fps) && fps > 0 ? Math.min(30, Math.max(1, fps)) : 10;
  let videoStream: MediaStream;
  try {
    videoStream = stagingCanvas.captureStream(safeFps);
  } catch {
    stagingCanvas.width = 0;
    stagingCanvas.height = 0;
    options?.onReleaseAudio?.();
    return null;
  }

  const clonedAudioTracks: MediaStreamTrack[] = [];
  const attachedAudioTracks: MediaStreamTrack[] = [];
  let outputStream: MediaStream = videoStream;
  const sourceAudioTracks = options?.audioStream?.getAudioTracks?.() ?? [];
  if (sourceAudioTracks.length > 0 && typeof MediaStream !== 'undefined') {
    for (const track of sourceAudioTracks) {
      try {
        if (typeof track.clone === 'function') {
          const cloned = track.clone();
          clonedAudioTracks.push(cloned);
          attachedAudioTracks.push(cloned);
        } else {
          attachedAudioTracks.push(track);
        }
      } catch {
        // Ignore unusable audio track
      }
    }
    if (attachedAudioTracks.length > 0) {
      try {
        outputStream = new MediaStream([...videoStream.getVideoTracks(), ...attachedAudioTracks]);
      } catch {
        for (const track of clonedAudioTracks) {
          try { track.stop(); } catch { /* ignore */ }
        }
        clonedAudioTracks.length = 0;
        outputStream = videoStream;
      }
    }
  }

  const intervalMs = Math.max(33, Math.round(1000 / safeFps));
  const timerId = window.setInterval(drawCurrentFrame, intervalMs);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(timerId);
    try {
      // Stop only tracks owned by this capture (staging video tracks + cloned audio tracks),
      // never a shared audio destination track if clone() was unavailable.
      for (const track of videoStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      for (const track of clonedAudioTracks) {
        try { track.stop(); } catch { /* ignore */ }
      }
    } catch {
      // ignore
    }
    // Immediately release Chromium/Skia GPU backing texture.
    try {
      stagingCanvas.width = 0;
      stagingCanvas.height = 0;
    } catch {
      // ignore
    }
    try {
      options?.onReleaseAudio?.();
    } catch {
      // ignore
    }
  };

  return {
    stream: outputStream,
    width,
    height,
    dispose,
  };
}

/**
 * Capture a compact JPEG thumbnail (<= 320px wide) from a remote desktop
 * canvas, freeing the temporary canvas GPU buffer immediately in `finally`.
 */
export async function captureCanvasThumbnailJpeg(
  sourceCanvas: HTMLCanvasElement,
  options?: { maxWidth?: number; maxHeight?: number; quality?: number },
): Promise<Uint8Array | null> {
  if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) return null;
  if (typeof document === 'undefined') return null;

  const maxWidth = options?.maxWidth ?? DEFAULT_THUMBNAIL_MAX_WIDTH;
  const maxHeight = options?.maxHeight ?? DEFAULT_THUMBNAIL_MAX_HEIGHT;
  const quality = options?.quality ?? DEFAULT_THUMBNAIL_JPEG_QUALITY;
  const scale = Math.min(1, maxWidth / sourceCanvas.width, maxHeight / sourceCanvas.height);
  const w = Math.max(2, Math.round(sourceCanvas.width * scale));
  const h = Math.max(2, Math.round(sourceCanvas.height * scale));

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = w;
  thumbCanvas.height = h;
  try {
    const ctx = thumbCanvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        thumbCanvas.toBlob((result) => resolve(result), 'image/jpeg', quality);
      } catch {
        resolve(null);
      }
    });
    if (!blob || blob.size === 0) return null;
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  } finally {
    // Free GPU texture immediately without waiting for GC.
    try {
      thumbCanvas.width = 0;
      thumbCanvas.height = 0;
    } catch {
      // ignore
    }
  }
}
