import type { TerminalSettings } from "./models/terminal";

/** Compile-time kill switch for terminal hibernate (Settings > Terminal still controls user default). */
export const TERMINAL_HIBERNATE_ENABLED = true;

/** Default delay before hibernating a hidden tab (seconds). */
export const TERMINAL_HIBERNATE_DELAY_SEC_DEFAULT = 5;

export const TERMINAL_HIBERNATE_DELAY_SEC_MIN = 5;

export const TERMINAL_HIBERNATE_DELAY_SEC_MAX = 600;

/** Default delay in milliseconds (legacy constant for tests). */
export const TERMINAL_HIBERNATE_DELAY_MS = TERMINAL_HIBERNATE_DELAY_SEC_DEFAULT * 1000;

export function normalizeHibernateHiddenTabsDelaySec(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TERMINAL_HIBERNATE_DELAY_SEC_DEFAULT;
  }
  return Math.min(
    TERMINAL_HIBERNATE_DELAY_SEC_MAX,
    Math.max(TERMINAL_HIBERNATE_DELAY_SEC_MIN, Math.round(value)),
  );
}

export function resolveTerminalHibernateDelayMs(
  settings?: Pick<TerminalSettings, "hibernateHiddenTabsDelaySec"> | null,
): number {
  return normalizeHibernateHiddenTabsDelaySec(settings?.hibernateHiddenTabsDelaySec) * 1000;
}

export function resolveTerminalHibernateEnabled(
  settings?: Pick<TerminalSettings, "hibernateHiddenTabs"> | null,
): boolean {
  if (!TERMINAL_HIBERNATE_ENABLED) return false;
  return settings?.hibernateHiddenTabs === true;
}

export function resolveTerminalHibernateEnabledForProtocol(
  settings: Pick<TerminalSettings, "hibernateHiddenTabs"> | null | undefined,
  protocol: string | null | undefined,
): boolean {
  return protocol !== "local" && resolveTerminalHibernateEnabled(settings);
}

export function shouldKeepTerminalBackgroundWorkActive(
  settings: Pick<TerminalSettings, "hibernateHiddenTabs"> | null | undefined,
  protocol: string | null | undefined,
  isVisible: boolean,
): boolean {
  return isVisible || !resolveTerminalHibernateEnabledForProtocol(settings, protocol);
}

/** Block hibernate while a file transfer or drag-drop session is in progress. */
export function isTerminalFileTransferActive(options: {
  zmodemActive: boolean;
  ymodemInProgress: boolean;
  isDraggingOver: boolean;
}): boolean {
  return options.zmodemActive || options.ymodemInProgress || options.isDraggingOver;
}

/** Lines kept when snapshotting xterm scrollback before hibernate. */
export const TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES = 3_000;

/** Default chunk size for replaying hibernate snapshots without blocking the main thread. */
export const TERMINAL_HIBERNATE_REPLAY_CHUNK_BYTES_DEFAULT = 16 * 1024;

export const TERMINAL_HIBERNATE_REPLAY_CHUNK_BYTES_MIN = 4 * 1024;

export const TERMINAL_HIBERNATE_REPLAY_CHUNK_BYTES_MAX = 64 * 1024;

/** Hidden tabs whose xterm runtime is kept alive (WebGL suspended) before full hibernate. */
export const TERMINAL_HIBERNATE_KEEP_RENDERER_COUNT_DEFAULT = 2;

export const TERMINAL_HIBERNATE_KEEP_RENDERER_COUNT_MIN = 0;

export const TERMINAL_HIBERNATE_KEEP_RENDERER_COUNT_MAX = 12;

/** Max chars buffered in renderer while xterm is hibernated (post-snapshot output). */
export const TERMINAL_HIBERNATE_BUFFER_MAX_CHARS = 512 * 1024;

export function capHibernateBuffer(buffer: string, maxChars = TERMINAL_HIBERNATE_BUFFER_MAX_CHARS): string {
  if (buffer.length <= maxChars) return buffer;
  return buffer.slice(buffer.length - maxChars);
}

export function capHibernateBufferByLines(text: string, maxLines: number): string {
  if (maxLines <= 0 || text.length === 0) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

export function normalizeHibernateReplayChunkBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TERMINAL_HIBERNATE_REPLAY_CHUNK_BYTES_DEFAULT;
  }
  return Math.min(
    TERMINAL_HIBERNATE_REPLAY_CHUNK_BYTES_MAX,
    Math.max(TERMINAL_HIBERNATE_REPLAY_CHUNK_BYTES_MIN, Math.round(value)),
  );
}

export function normalizeHibernateKeepRendererCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TERMINAL_HIBERNATE_KEEP_RENDERER_COUNT_DEFAULT;
  }
  return Math.min(
    TERMINAL_HIBERNATE_KEEP_RENDERER_COUNT_MAX,
    Math.max(TERMINAL_HIBERNATE_KEEP_RENDERER_COUNT_MIN, Math.round(value)),
  );
}

export function resolveTerminalHibernateReplayChunkBytes(
  settings?: Pick<TerminalSettings, "hibernateReplayChunkBytes"> | null,
): number {
  return normalizeHibernateReplayChunkBytes(settings?.hibernateReplayChunkBytes);
}

export function resolveHibernateKeepRendererCount(
  settings?: Pick<TerminalSettings, "hibernateKeepRendererCount"> | null,
): number {
  return normalizeHibernateKeepRendererCount(settings?.hibernateKeepRendererCount);
}

export function resolveHibernateSkipAltScreen(
  settings?: Pick<TerminalSettings, "hibernateSkipAltScreen"> | null,
): boolean {
  return settings?.hibernateSkipAltScreen !== false;
}

export function resolveHibernatePreferWasmSerialize(
  settings?: Pick<TerminalSettings, "hibernatePreferWasmSerialize"> | null,
): boolean {
  return settings?.hibernatePreferWasmSerialize === true;
}

export function shouldSkipHibernateForAltScreen(
  alternateScreen: boolean,
  settings?: Pick<TerminalSettings, "hibernateSkipAltScreen"> | null,
): boolean {
  return alternateScreen && resolveHibernateSkipAltScreen(settings);
}

/** Snapshot + buffered output to replay when recreating xterm after hibernate. */
export type TerminalHibernateWakePayload = {
  /** Full serialized terminal state (legacy combined snapshot). */
  snapshot: string;
  /** Visible viewport rows for fast first paint during wake. */
  viewportSnapshot?: string;
  /** Older scrollback rows replayed lazily after viewport + pending. */
  scrollbackSnapshot?: string;
  pendingBuffer: string;
  /** True when the pane was hibernated while a full-screen app owned the alt buffer. */
  alternateScreen: boolean;
};
