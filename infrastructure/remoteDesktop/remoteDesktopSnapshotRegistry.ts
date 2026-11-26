export type RemoteDesktopSnapshotQuality = 'standard' | 'high';
export type RemoteDesktopCaptureSource = 'ai-tool' | 'user-snip' | 'user-full';
export type RemoteDesktopImageMediaType = 'image/jpeg' | 'image/png';

export interface RemoteDesktopCropRect {
  /** Normalized permille coordinates (0..1000) of the natural framebuffer. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RemoteDesktopCaptureRequest {
  quality?: RemoteDesktopSnapshotQuality;
  crop?: RemoteDesktopCropRect;
  source?: RemoteDesktopCaptureSource;
  format?: RemoteDesktopImageMediaType;
}

export interface RemoteDesktopProviderFrame {
  /** Base64 image data (data URL prefixes are automatically stripped if present). */
  base64Data: string;
  mediaType: RemoteDesktopImageMediaType;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  crop?: RemoteDesktopCropRect;
  /** Optional tiny preview data URL (e.g. <= 200px) for lightweight UI thumbnails. */
  previewDataUrl?: string;
  protocol?: 'vnc' | 'rdp';
  hostLabel?: string;
  hostname?: string;
}

export type RemoteDesktopSnapshotProvider = (
  options?: RemoteDesktopCaptureRequest,
) => Promise<RemoteDesktopProviderFrame | null> | RemoteDesktopProviderFrame | null;

export interface RemoteDesktopFrameMetadata {
  captureId: string;
  sessionId: string;
  protocol?: 'vnc' | 'rdp';
  hostLabel?: string;
  hostname?: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  crop?: RemoteDesktopCropRect;
  mediaType: RemoteDesktopImageMediaType;
  byteLength: number;
  capturedAt: number;
  source: RemoteDesktopCaptureSource;
  previewDataUrl?: string;
}

export interface CapturedRemoteDesktopFrame extends RemoteDesktopFrameMetadata {
  base64Data: string;
}

export type RemoteDesktopFrameCaptureFailureCode =
  | 'PRIVACY_BLOCKED'
  | 'UNAVAILABLE'
  | 'INVALID_CROP'
  | 'CAPTURE_FAILED';

export type RemoteDesktopFrameCaptureResult =
  | ({ ok: true } & RemoteDesktopFrameMetadata)
  | {
      ok: false;
      code: RemoteDesktopFrameCaptureFailureCode;
      error: string;
    };

export interface RemoteDesktopCaptureEvent {
  captureId: string;
  sessionId: string;
  source: RemoteDesktopCaptureSource;
  crop?: RemoteDesktopCropRect;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  timestamp: number;
}

export interface RemoteDesktopCaptureGeometry {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  outWidth: number;
  outHeight: number;
  mediaType: RemoteDesktopImageMediaType;
  jpegQuality: number;
  crop?: RemoteDesktopCropRect;
}

export const MAX_REMOTE_DESKTOP_CACHED_FRAMES = 8;
const STANDARD_MAX_EDGE = 1280;
const HIGH_MAX_EDGE = 1920;
const PNG_CROP_MAX_WIDTH = 640;
const PNG_CROP_MAX_HEIGHT = 480;
const PREVIEW_MAX_EDGE = 200;

const providers = new Map<string, RemoteDesktopSnapshotProvider>();
const aiReadBlockedSessions = new Set<string>();
const aiReadBlockedListeners = new Map<string, Set<(blocked: boolean) => void>>();
const captureEventListeners = new Map<string, Set<(event: RemoteDesktopCaptureEvent) => void>>();
const captureCache = new Map<string, CapturedRemoteDesktopFrame>();

let captureSeq = 0;

function nextCaptureId(): string {
  captureSeq += 1;
  return `rdcap-${Date.now().toString(36)}-${captureSeq}`;
}

function stripDataUrlPrefix(input: string): string {
  const trimmed = input.trim();
  const commaIndex = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIndex !== -1) {
    return trimmed.slice(commaIndex + 1).trim();
  }
  return trimmed;
}

function estimateBase64ByteLength(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function putCachedFrame(frame: CapturedRemoteDesktopFrame): void {
  if (captureCache.has(frame.captureId)) {
    captureCache.delete(frame.captureId);
  }
  captureCache.set(frame.captureId, frame);
  while (captureCache.size > MAX_REMOTE_DESKTOP_CACHED_FRAMES) {
    const oldestKey = captureCache.keys().next().value;
    if (oldestKey === undefined) break;
    captureCache.delete(oldestKey);
  }
}

export function normalizeRemoteDesktopCrop(
  crop: Partial<RemoteDesktopCropRect> | undefined,
): { crop?: RemoteDesktopCropRect; error?: string } {
  if (!crop) return { crop: undefined };
  const { x, y, width, height } = crop;
  if (
    typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof width !== 'number' || !Number.isFinite(width)
    || typeof height !== 'number' || !Number.isFinite(height)
  ) {
    return { error: 'Crop coordinates (cropX, cropY, cropWidth, cropHeight) must all be finite numbers in 0..1000.' };
  }
  const nx = Math.round(x);
  const ny = Math.round(y);
  const nw = Math.round(width);
  const nh = Math.round(height);
  if (nx < 0 || ny < 0 || nx >= 1000 || ny >= 1000 || nw <= 0 || nh <= 0) {
    return { error: 'Crop coordinates must satisfy 0 <= x,y < 1000 and width,height > 0.' };
  }
  const clampedWidth = Math.min(nw, 1000 - nx);
  const clampedHeight = Math.min(nh, 1000 - ny);
  if (clampedWidth <= 0 || clampedHeight <= 0) {
    return { error: 'Crop region falls outside the 0..1000 desktop bounds.' };
  }
  return {
    crop: {
      x: nx,
      y: ny,
      width: clampedWidth,
      height: clampedHeight,
    },
  };
}

export function parseFlatRemoteDesktopCropParams(params: {
  cropX?: unknown;
  cropY?: unknown;
  cropWidth?: unknown;
  cropHeight?: unknown;
}): { crop?: RemoteDesktopCropRect; error?: string } {
  const values = [params.cropX, params.cropY, params.cropWidth, params.cropHeight];
  const definedCount = values.filter((v) => v !== undefined && v !== null).length;
  if (definedCount === 0) return { crop: undefined };
  if (definedCount !== 4) {
    return {
      error: 'All four crop coordinates (cropX, cropY, cropWidth, cropHeight) must be provided together.',
    };
  }
  return normalizeRemoteDesktopCrop({
    x: Number(params.cropX),
    y: Number(params.cropY),
    width: Number(params.cropWidth),
    height: Number(params.cropHeight),
  });
}

export function normalizeRemoteDesktopQuality(value: unknown): RemoteDesktopSnapshotQuality {
  return typeof value === 'string' && value.trim().toLowerCase() === 'high' ? 'high' : 'standard';
}

export function computeRemoteDesktopCaptureGeometry(
  naturalWidth: number,
  naturalHeight: number,
  options?: {
    quality?: RemoteDesktopSnapshotQuality;
    crop?: RemoteDesktopCropRect;
    format?: RemoteDesktopImageMediaType;
    maxWidth?: number;
  },
): RemoteDesktopCaptureGeometry | null {
  if (
    !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)
    || naturalWidth <= 0 || naturalHeight <= 0
  ) {
    return null;
  }
  const natW = Math.round(naturalWidth);
  const natH = Math.round(naturalHeight);
  const quality = options?.quality ?? 'standard';
  const maxEdge = options?.maxWidth && options.maxWidth > 0
    ? Math.round(options.maxWidth)
    : quality === 'high' ? HIGH_MAX_EDGE : STANDARD_MAX_EDGE;

  let sx = 0;
  let sy = 0;
  let sw = natW;
  let sh = natH;
  let normalizedCrop: RemoteDesktopCropRect | undefined;

  if (options?.crop) {
    const parsed = normalizeRemoteDesktopCrop(options.crop);
    if (parsed.error || !parsed.crop) return null;
    normalizedCrop = parsed.crop;
    sx = Math.min(natW - 1, Math.max(0, Math.floor((normalizedCrop.x / 1000) * natW)));
    sy = Math.min(natH - 1, Math.max(0, Math.floor((normalizedCrop.y / 1000) * natH)));
    sw = Math.max(1, Math.min(natW - sx, Math.round((normalizedCrop.width / 1000) * natW)));
    sh = Math.max(1, Math.min(natH - sy, Math.round((normalizedCrop.height / 1000) * natH)));
  }

  // Never upscale; cropped regions smaller than maxEdge stay at 1:1 native pixels.
  const longest = Math.max(sw, sh);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const outWidth = Math.max(1, Math.round(sw * scale));
  const outHeight = Math.max(1, Math.round(sh * scale));

  // Auto-upgrade small cropped regions to lossless PNG for razor-sharp dialog/log text.
  const defaultMediaType: RemoteDesktopImageMediaType =
    normalizedCrop && outWidth <= PNG_CROP_MAX_WIDTH && outHeight <= PNG_CROP_MAX_HEIGHT
      ? 'image/png'
      : 'image/jpeg';
  const mediaType = options?.format ?? defaultMediaType;
  const jpegQuality = quality === 'high' ? 0.92 : 0.80;

  return {
    sx,
    sy,
    sw,
    sh,
    outWidth,
    outHeight,
    mediaType,
    jpegQuality,
    crop: normalizedCrop,
  };
}

/**
 * Browser helper: crop directly from a live `<canvas>` framebuffer at native
 * resolution before any downscaling, with optional tiny preview thumbnail.
 */
export function captureFrameFromCanvas(
  canvas: HTMLCanvasElement,
  options?: RemoteDesktopCaptureRequest & {
    maxWidth?: number;
    protocol?: 'vnc' | 'rdp';
    hostLabel?: string;
    hostname?: string;
    includePreview?: boolean;
  },
): RemoteDesktopProviderFrame | null {
  const naturalWidth = canvas.width;
  const naturalHeight = canvas.height;
  const geom = computeRemoteDesktopCaptureGeometry(naturalWidth, naturalHeight, options);
  if (!geom || typeof document === 'undefined') return null;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = geom.outWidth;
  outCanvas.height = geom.outHeight;
  const ctx = outCanvas.getContext('2d');
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, geom.sx, geom.sy, geom.sw, geom.sh, 0, 0, geom.outWidth, geom.outHeight);

  const dataUrl = geom.mediaType === 'image/png'
    ? outCanvas.toDataURL('image/png')
    : outCanvas.toDataURL('image/jpeg', geom.jpegQuality);
  const base64Data = stripDataUrlPrefix(dataUrl);
  if (!base64Data) return null;

  let previewDataUrl: string | undefined;
  if (options?.includePreview) {
    const previewScale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(geom.outWidth, geom.outHeight));
    const pw = Math.max(1, Math.round(geom.outWidth * previewScale));
    const ph = Math.max(1, Math.round(geom.outHeight * previewScale));
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = pw;
    previewCanvas.height = ph;
    const pctx = previewCanvas.getContext('2d');
    if (pctx) {
      pctx.drawImage(outCanvas, 0, 0, pw, ph);
      previewDataUrl = previewCanvas.toDataURL('image/jpeg', 0.65);
    }
  }

  return {
    base64Data,
    mediaType: geom.mediaType,
    width: geom.outWidth,
    height: geom.outHeight,
    naturalWidth,
    naturalHeight,
    crop: geom.crop,
    previewDataUrl,
    protocol: options?.protocol,
    hostLabel: options?.hostLabel,
    hostname: options?.hostname,
  };
}

export function registerRemoteDesktopSnapshotProvider(
  sessionId: string,
  provider: RemoteDesktopSnapshotProvider,
): () => void {
  providers.set(sessionId, provider);
  return () => {
    if (providers.get(sessionId) === provider) {
      providers.delete(sessionId);
    }
  };
}

export function hasRemoteDesktopSnapshotProvider(sessionId: string): boolean {
  return providers.has(sessionId);
}

export function setRemoteDesktopAiReadBlocked(sessionId: string, blocked: boolean): void {
  const wasBlocked = aiReadBlockedSessions.has(sessionId);
  if (blocked) {
    aiReadBlockedSessions.add(sessionId);
  } else {
    aiReadBlockedSessions.delete(sessionId);
  }
  if (wasBlocked === blocked) return;
  const listeners = aiReadBlockedListeners.get(sessionId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(blocked);
    } catch {
      // Ignore subscriber errors.
    }
  }
}

export function isRemoteDesktopAiReadBlocked(sessionId: string): boolean {
  return aiReadBlockedSessions.has(sessionId);
}

export function subscribeRemoteDesktopAiReadBlocked(
  sessionId: string,
  listener: (blocked: boolean) => void,
): () => void {
  let set = aiReadBlockedListeners.get(sessionId);
  if (!set) {
    set = new Set();
    aiReadBlockedListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = aiReadBlockedListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) aiReadBlockedListeners.delete(sessionId);
  };
}

export function subscribeRemoteDesktopCaptureEvents(
  sessionId: string,
  callback: (event: RemoteDesktopCaptureEvent) => void,
): () => void {
  let set = captureEventListeners.get(sessionId);
  if (!set) {
    set = new Set();
    captureEventListeners.set(sessionId, set);
  }
  set.add(callback);
  return () => {
    const current = captureEventListeners.get(sessionId);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) captureEventListeners.delete(sessionId);
  };
}

function emitCaptureEvent(event: RemoteDesktopCaptureEvent): void {
  const listeners = captureEventListeners.get(event.sessionId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // UI listener errors must not abort frame capture.
    }
  }
}

export async function captureRemoteDesktopFrame(
  sessionId: string,
  options?: RemoteDesktopCaptureRequest,
): Promise<RemoteDesktopFrameCaptureResult> {
  const source: RemoteDesktopCaptureSource = options?.source ?? 'ai-tool';
  if (source === 'ai-tool' && isRemoteDesktopAiReadBlocked(sessionId)) {
    return {
      ok: false,
      code: 'PRIVACY_BLOCKED',
      error: 'AI screen reading is blocked for this remote desktop session by the privacy lock.',
    };
  }

  const normalized = normalizeRemoteDesktopCrop(options?.crop);
  if (normalized.error) {
    return {
      ok: false,
      code: 'INVALID_CROP',
      error: normalized.error,
    };
  }

  const provider = providers.get(sessionId);
  if (!provider) {
    return {
      ok: false,
      code: 'UNAVAILABLE',
      error: 'Remote desktop screen capture is unavailable for this session. Ensure it is connected and visible.',
    };
  }

  let rawFrame: RemoteDesktopProviderFrame | null;
  try {
    rawFrame = await provider({
      quality: options?.quality ?? 'standard',
      crop: normalized.crop,
      source,
      format: options?.format,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'CAPTURE_FAILED',
      error: err instanceof Error ? err.message : 'Failed to capture remote desktop frame.',
    };
  }

  if (!rawFrame || typeof rawFrame.base64Data !== 'string') {
    return {
      ok: false,
      code: 'CAPTURE_FAILED',
      error: 'Remote desktop frame buffer is currently empty.',
    };
  }

  const base64Data = stripDataUrlPrefix(rawFrame.base64Data);
  if (!base64Data) {
    return {
      ok: false,
      code: 'CAPTURE_FAILED',
      error: 'Remote desktop frame buffer returned empty image data.',
    };
  }

  const capturedAt = Date.now();
  const captureId = nextCaptureId();
  const metadata: RemoteDesktopFrameMetadata = {
    captureId,
    sessionId,
    protocol: rawFrame.protocol,
    hostLabel: rawFrame.hostLabel,
    hostname: rawFrame.hostname,
    width: rawFrame.width,
    height: rawFrame.height,
    naturalWidth: rawFrame.naturalWidth,
    naturalHeight: rawFrame.naturalHeight,
    ...(rawFrame.crop ?? normalized.crop ? { crop: rawFrame.crop ?? normalized.crop } : {}),
    mediaType: rawFrame.mediaType === 'image/png' ? 'image/png' : 'image/jpeg',
    byteLength: estimateBase64ByteLength(base64Data),
    capturedAt,
    source,
    ...(rawFrame.previewDataUrl ? { previewDataUrl: rawFrame.previewDataUrl } : {}),
  };

  putCachedFrame({ ...metadata, base64Data });

  emitCaptureEvent({
    captureId,
    sessionId,
    source,
    crop: metadata.crop,
    width: metadata.width,
    height: metadata.height,
    naturalWidth: metadata.naturalWidth,
    naturalHeight: metadata.naturalHeight,
    timestamp: capturedAt,
  });

  return {
    ok: true,
    ...metadata,
  };
}

/**
 * Store a frame returned from a detached pop-out window RPC into the local
 * bounded LRU cache so `toModelOutput` can resolve it by `captureId` without
 * keeping base64 in chat history.
 */
export function storeExternalCapturedRemoteDesktopFrame(
  input: Omit<CapturedRemoteDesktopFrame, 'captureId' | 'byteLength' | 'capturedAt' | 'source'> & {
    captureId?: string;
    capturedAt?: number;
    source?: RemoteDesktopCaptureSource;
  },
): RemoteDesktopFrameMetadata {
  const base64Data = stripDataUrlPrefix(input.base64Data);
  const metadata: RemoteDesktopFrameMetadata = {
    captureId: input.captureId || nextCaptureId(),
    sessionId: input.sessionId,
    protocol: input.protocol,
    hostLabel: input.hostLabel,
    hostname: input.hostname,
    width: input.width,
    height: input.height,
    naturalWidth: input.naturalWidth,
    naturalHeight: input.naturalHeight,
    ...(input.crop ? { crop: input.crop } : {}),
    mediaType: input.mediaType === 'image/png' ? 'image/png' : 'image/jpeg',
    byteLength: estimateBase64ByteLength(base64Data),
    capturedAt: input.capturedAt ?? Date.now(),
    source: input.source ?? 'ai-tool',
    ...(input.previewDataUrl ? { previewDataUrl: input.previewDataUrl } : {}),
  };
  putCachedFrame({ ...metadata, base64Data });
  return metadata;
}

export function getCapturedRemoteDesktopFrame(captureId: string): CapturedRemoteDesktopFrame | undefined {
  const existing = captureCache.get(captureId);
  if (!existing) return undefined;
  // Refresh LRU recency.
  captureCache.delete(captureId);
  captureCache.set(captureId, existing);
  return existing;
}

export function clearCapturedRemoteDesktopFramesForSession(sessionId: string): number {
  let removed = 0;
  for (const [id, frame] of captureCache.entries()) {
    if (frame.sessionId === sessionId) {
      captureCache.delete(id);
      removed += 1;
    }
  }
  return removed;
}

export function clearAllCapturedRemoteDesktopFrames(): void {
  captureCache.clear();
}

export function resetRemoteDesktopSnapshotRegistryForTests(): void {
  providers.clear();
  aiReadBlockedSessions.clear();
  aiReadBlockedListeners.clear();
  captureEventListeners.clear();
  captureCache.clear();
}
