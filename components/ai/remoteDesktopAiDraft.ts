import type { UploadedFile } from '../../infrastructure/ai/types';
import type {
  RemoteDesktopCropRect,
  RemoteDesktopImageMediaType,
} from '../../infrastructure/remoteDesktop/remoteDesktopSnapshotRegistry';

export const REMOTE_SCREEN_FILENAME_PREFIX = 'remote-screen-';

export interface RemoteDesktopScreenshotDraftPayload {
  /** Remote desktop session ID (used to route to the owning AI panel/tab). */
  sessionId: string;
  /** Optional workspace ID when the remote desktop belongs to a workspace. */
  workspaceId?: string;
  /** Raw base64 payload (or data URL — prefix is stripped automatically). */
  base64Data: string;
  mediaType: RemoteDesktopImageMediaType;
  filename?: string;
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  crop?: RemoteDesktopCropRect;
  hostLabel?: string;
  protocol?: 'vnc' | 'rdp';
}

export interface RemoteDesktopQuickPromptSpec {
  id: 'explainError' | 'diagnoseUi' | 'summarizeScreen';
  labelKey: string;
}

export const REMOTE_DESKTOP_QUICK_PROMPTS: readonly RemoteDesktopQuickPromptSpec[] = [
  { id: 'explainError', labelKey: 'ai.vision.quickPrompt.explainError' },
  { id: 'diagnoseUi', labelKey: 'ai.vision.quickPrompt.diagnoseUi' },
  { id: 'summarizeScreen', labelKey: 'ai.vision.quickPrompt.summarizeScreen' },
];

type RemoteScreenDraftListener = (payload: RemoteDesktopScreenshotDraftPayload) => void;

const draftListeners = new Set<RemoteScreenDraftListener>();

function stripBase64Prefix(value: string): string {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIndex !== -1) {
    return trimmed.slice(commaIndex + 1).trim();
  }
  return trimmed;
}

export function buildRemoteDesktopScreenshotFilename(
  payload: Pick<RemoteDesktopScreenshotDraftPayload, 'filename' | 'protocol' | 'crop' | 'width' | 'height' | 'mediaType'>,
): string {
  if (payload.filename && payload.filename.startsWith(REMOTE_SCREEN_FILENAME_PREFIX)) {
    return payload.filename;
  }
  const proto = payload.protocol ?? 'desktop';
  const kind = payload.crop ? 'snip' : 'full';
  const dims = payload.width && payload.height ? `-${payload.width}x${payload.height}` : '';
  const ext = payload.mediaType === 'image/png' ? 'png' : 'jpg';
  return `${REMOTE_SCREEN_FILENAME_PREFIX}${proto}-${kind}${dims}.${ext}`;
}

export function isRemoteDesktopScreenshotFile(
  file: Pick<UploadedFile, 'filename' | 'mediaType'>,
): boolean {
  return Boolean(
    file.mediaType?.startsWith('image/')
    && file.filename?.startsWith(REMOTE_SCREEN_FILENAME_PREFIX),
  );
}

/**
 * Convert a captured remote desktop screenshot payload into a browser `File`
 * ready to pass directly into `AIChatSidePanel`'s existing `addFiles([file])`.
 */
export function createRemoteDesktopScreenshotFile(
  payload: RemoteDesktopScreenshotDraftPayload,
): File {
  const base64 = stripBase64Prefix(payload.base64Data);
  const binary = typeof atob === 'function'
    ? atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const filename = buildRemoteDesktopScreenshotFilename(payload);
  return new File([bytes], filename, { type: payload.mediaType });
}

/**
 * Convert a captured remote desktop screenshot payload directly into an
 * `UploadedFile` record for draft state updates when `FileReader` is bypassed.
 */
export function createRemoteDesktopUploadedFile(
  payload: RemoteDesktopScreenshotDraftPayload,
  id?: string,
): UploadedFile {
  const base64Data = stripBase64Prefix(payload.base64Data);
  const filename = buildRemoteDesktopScreenshotFilename(payload);
  return {
    id: id || `remote-screen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    filename,
    dataUrl: `data:${payload.mediaType};base64,${base64Data}`,
    base64Data,
    mediaType: payload.mediaType,
  };
}

/**
 * Pub/sub helper so `TerminalLayer` / `RemoteDesktopPane` can hand a captured
 * full-screen or region-snip screenshot directly to the active AI chat draft.
 */
export function dispatchAddRemoteScreenToAI(payload: RemoteDesktopScreenshotDraftPayload): void {
  for (const listener of draftListeners) {
    try {
      listener(payload);
    } catch {
      // Ignore subscriber errors.
    }
  }
}

export function subscribeAddRemoteScreenToAI(
  listener: RemoteScreenDraftListener,
): () => void {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}
