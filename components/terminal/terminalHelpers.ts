import type { DragEvent, PointerEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";

import type { TerminalContextReader } from "../../domain/terminalContextRead";
import type { TerminalSessionExitEvent } from "../../application/state/resolveTerminalSessionExitIntent";
import { resolveSessionTabTitle } from "../../domain/sessionTabTitle";
import { logger } from "../../lib/logger";
import { getDropEntryLocalPath, type DropEntry } from "../../lib/sftpFileUtils";
import { normalizeLineEndings } from "../../lib/utils";
import { resolveSnippetMultiLineRunMode } from "../../domain/snippetRunMode";
import type {
  Host,
  Identity,
  KnownHost,
  KeyBinding,
  SerialConfig,
  SSHKey,
  Snippet,
  TerminalSession,
  TerminalSettings,
  TerminalTheme,
} from "../../types";
import type { KittyKeyboardBroadcastInput } from "./runtime/kittyKeyboardBroadcast";
import type { TerminalCwdChangeMeta } from "./sftpCwd";

export const MAX_CONNECTION_LOG_DATA_CHARS = 1_000_000;
export const AUTO_RUN_SNIPPET_LINE_DELAY_MS = 250;

export interface TerminalBroadcastInputOptions {
  noAutoRun?: boolean;
  lineDelayMs?: number;
  kittyKeyboardInput?: KittyKeyboardBroadcastInput;
  kittyKeyboardTargetSessionIds?: string[];
}

export { resolveSessionTabTitle };

/**
 * Extract unique root paths from drop entries for local terminal path insertion.
 * For nested files, extracts the root folder path; for single files, uses the full path.
 * Paths with spaces are quoted.
 */
export function extractRootPathsFromDropEntries(dropEntries: DropEntry[]): string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const entry of dropEntries) {
    const fullPath = getDropEntryLocalPath(entry);
    if (!fullPath) continue;

    const pathParts = entry.relativePath.split("/");

    if (pathParts.length > 1) {
      const rootFolderName = pathParts[0];
      const separator = fullPath.includes("\\") ? "\\" : "/";

      const rootFolderIndex = fullPath.lastIndexOf(separator + rootFolderName + separator);
      const altRootFolderIndex = fullPath.lastIndexOf(separator + rootFolderName);
      const folderStartIndex = rootFolderIndex !== -1
        ? rootFolderIndex + 1
        : (altRootFolderIndex !== -1 ? altRootFolderIndex + 1 : -1);

      if (folderStartIndex !== -1) {
        const folderEndIndex = folderStartIndex + rootFolderName.length;
        const folderPath = fullPath.substring(0, folderEndIndex);

        if (!seenPaths.has(folderPath)) {
          paths.push(folderPath.includes(" ") ? `"${folderPath}"` : folderPath);
          seenPaths.add(folderPath);
        }
      }
    } else if (!seenPaths.has(fullPath)) {
      paths.push(fullPath.includes(" ") ? `"${fullPath}"` : fullPath);
      seenPaths.add(fullPath);
    }
  }

  return paths;
}

/**
 * Extract unique paths from clipboard file entries for local terminal path insertion.
 * Uses each entry's path directly (directories included). Paths with spaces are quoted.
 */
export function extractRootPathsFromClipboardFiles(
  files: Array<{ path: string; name: string; isDirectory: boolean; size?: number }>,
): string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    const fullPath = file.path;
    if (!fullPath || seenPaths.has(fullPath)) continue;

    paths.push(fullPath.includes(" ") ? `"${fullPath}"` : fullPath);
    seenPaths.add(fullPath);
  }

  return paths;
}

export interface TerminalProps {
  host: Host;
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  snippetPackages?: string[];
  /** Minimal toolbar for popup terminals (compose, search, snippets only). */
  compactToolbar?: boolean;
  /** Line timestamps are unavailable in popup terminals that stream shell output without timestamp metadata. */
  lineTimestampsAvailable?: boolean;
  /** Compact/popup path: delete snippets against the caller's vault hook. */
  onDeleteSnippets?: (ids: ReadonlySet<string>) => void;
  chainHosts?: Host[];
  appearanceTheme?: TerminalTheme;
  knownHosts?: KnownHost[];
  isVisible: boolean;
  /** Changes when split-pane bounds update; triggers xterm refit after tab switches. */
  paneLayoutKey?: string;
  inWorkspace?: boolean;
  isResizing?: boolean;
  isFocusMode?: boolean;
  isPaneMagnified?: boolean;
  isFocused?: boolean;
  /**
   * Split-pane keyboard ownership for disconnected-dialog focus claims.
   * `false` = visible unfocused split sibling (must not claim body/document focus).
   * Omit outside split mode (solo / focus / popup).
   */
  isFocusedPane?: boolean;
  fontFamilyId: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  followAppTerminalTheme?: boolean;
  accentMode?: "theme" | "custom";
  customAccent?: string;
  terminalSettings?: TerminalSettings;
  sessionId: string;
  workspaceId?: string;
  restoreState?: TerminalSession["restoreState"];
  /** Secondary windows hydrate their own vault state outside the main snapshot store. */
  vaultInitializedOverride?: boolean;
  pendingInitialCwd?: string;
  shellType?: TerminalSession["shellType"];
  lastCwd?: string;
  restoreTerminalCwd?: boolean;
  startupCommand?: string;
  noAutoRun?: boolean;
  multiLineRunMode?: Snippet["multiLineRunMode"];
  pendingScriptId?: string;
  pendingScript?: Snippet;
  // When this tab was created from a connected SSH session, the id of the
  // source session whose authenticated connection should be reused for a new
  // shell channel — skipping a second MFA prompt (issue #1204).
  reuseConnectionFromSessionId?: string;
  // Duplicate Session marker: never borrow a live/parked pooled transport —
  // always dial a fresh connection (fresh auth).
  requireFreshConnection?: boolean;
  /**
   * Attach to an already-running backend session (same PTY) instead of starting
   * a new one. Used by the AI silent-session observe popup. Must not close the
   * backend session on unmount.
   */
  attachExistingSession?: boolean;
  /** Ephemeral grant required for attach-session IPC. */
  attachAuthorization?: string;
  /** Registers the async handoff that must finish before an attach popup closes. */
  onAttachClosePreparationChange?: (prepare: (() => Promise<void>) | null) => void;
  serialConfig?: SerialConfig;
  hotkeyScheme?: "disabled" | "mac" | "pc";
  disableTerminalFontZoom?: boolean;
  keyBindings?: KeyBinding[];
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onTerminalFontSizeChange?: (fontSize: number) => void;
  onStatusChange?: (sessionId: string, status: TerminalSession["status"]) => void;
  onSessionExit?: (sessionId: string, evt: TerminalSessionExitEvent) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onUpdateHost?: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onExpandToFocus?: () => void;
  onTogglePaneMagnification?: () => void;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onCommandSubmitted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onOpenSftp?: (
    host: Host,
    initialPath?: string,
    pendingUploadEntries?: DropEntry[],
    originSessionId?: string,
    sourceSessionId?: string,
  ) => void;
  onTerminalCwdChange?: (sessionId: string, cwd: string | null, meta?: TerminalCwdChangeMeta) => void;
  onTerminalTitleChange?: (sessionId: string, title: string | null) => void;
  onTerminalBell?: (sessionId: string) => void;
  onTerminalOutput?: (sessionId: string, chunk: string) => void;
  onTerminalContextReaderChange?: (sessionId: string, reader: TerminalContextReader | null) => void;
  onOpenScripts?: () => void;
  onOpenHistory?: () => void;
  onOpenTheme?: () => void;
  onOpenSystem?: () => void;
  isBroadcastEnabled?: boolean;
  onToggleBroadcast?: () => void;
  onToggleComposeBar?: () => void;
  isWorkspaceComposeBarOpen?: boolean;
  onBroadcastInput?: (
    data: string,
    sourceSessionId: string,
    options?: TerminalBroadcastInputOptions,
  ) => string[] | void;
  onSnippetExecutorChange?: (
    sessionId: string,
    executor: ((
      command: string,
      noAutoRun?: boolean,
      options?: {
        broadcast?: boolean;
        multiLineRunMode?: Snippet["multiLineRunMode"];
        focus?: boolean;
      },
    ) => boolean | Promise<boolean>) | null,
  ) => void;
  onBroadcastInterruptPriorityChange?: (
    sessionId: string,
    prioritize: (() => void) | null,
  ) => void;
  onProgrammaticCommandLogRewriteChange?: (
    sessionId: string,
    queueRewrite: ((rewrite: ProgrammaticCommandLogRewrite) => void) | null,
  ) => void;
  sessionLog?: { enabled: boolean; directory: string; format: "txt" | "raw" | "html"; timestampsEnabled?: boolean };
  sshDebugLogEnabled?: boolean;
  sudoAutofillPassword?: string;
  /** Host + keychain password identities for picker mode (#2156). */
  sudoAutofillCandidates?: import("./runtime/terminalSudoAutofill").SudoPasswordAutofillCandidate[];
  showSelectionAIAction?: boolean;
  onAddSelectionToAI?: (sessionId: string, selection: string) => void;
  /** Override display name for the pane title bar (customName || hostLabel) */
  sessionDisplayName?: string;
  /** Open rename dialog for this session */
  onRename?: () => void;
  /** Detach this session from its workspace to a standalone tab */
  onDetach?: () => void;
  onStartSessionDrag?: (sessionId: string) => void;
  onEndSessionDrag?: () => void;
  onDetachPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onDetachDragStart?: (e: DragEvent) => void;
  onDetachDragEnd?: (e: DragEvent) => void;
}

export function formatNetSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) {
    return `${bytesPerSec}B/s`;
  } else if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)}K/s`;
  } else if (bytesPerSec < 1024 * 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)}M/s`;
  } else {
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(1)}G/s`;
  }
}

export function shouldShowTerminalConnectionDialog({
  status,
  isLocalConnection,
  isSerialConnection,
  isDisconnectedDialogDismissed,
  disconnectedNoticeMode,
  hasEverConnected,
  restoreState,
  isReconnectActive,
  requiresUserInput,
  hideConnectingDialogForConnectionReuse,
}: {
  status: TerminalSession["status"];
  isLocalConnection: boolean;
  isSerialConnection: boolean;
  isDisconnectedDialogDismissed: boolean;
  disconnectedNoticeMode?: TerminalSettings["disconnectedNoticeMode"];
  hasEverConnected?: boolean;
  restoreState?: TerminalSession["restoreState"];
  isReconnectActive?: boolean;
  requiresUserInput?: boolean;
  hideConnectingDialogForConnectionReuse?: boolean;
}): boolean {
  return status !== "connected"
    && !(!!hideConnectingDialogForConnectionReuse && status === "connecting")
    && !((isLocalConnection || isSerialConnection) && status === "connecting")
    && !shouldShowTerminalDisconnectedNotice({
      status,
      disconnectedNoticeMode,
      hasEverConnected,
      restoreState,
      isReconnectActive,
      requiresUserInput,
    })
    && !(status === "disconnected" && isDisconnectedDialogDismissed);
}

export function shouldShowTerminalDisconnectedNotice({
  status,
  disconnectedNoticeMode,
  hasEverConnected,
  restoreState,
  isReconnectActive,
  requiresUserInput,
}: {
  status: TerminalSession["status"];
  disconnectedNoticeMode?: TerminalSettings["disconnectedNoticeMode"];
  hasEverConnected?: boolean;
  restoreState?: TerminalSession["restoreState"];
  isReconnectActive?: boolean;
  requiresUserInput?: boolean;
}): boolean {
  const isDisconnectedOrReconnecting = status === "disconnected"
    || (status === "connecting" && isReconnectActive === true);
  return isDisconnectedOrReconnecting
    && disconnectedNoticeMode === "terminal"
    && hasEverConnected === true
    && restoreState !== "restored-disconnected"
    && requiresUserInput !== true;
}

/**
 * Dialog-local Enter reconnect while the disconnected overlay owns focus.
 * Leave native activation to focused buttons/links (Retry / Close / logs).
 */
export function shouldReconnectDisconnectedDialogOnEnterKey({
  key,
  enabled,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
  isComposing,
  target,
}: {
  key: string;
  enabled: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
}): boolean {
  if (!enabled || key !== "Enter") return false;
  if (altKey || ctrlKey || metaKey || shiftKey || isComposing) return false;
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return true;
  return !target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [role='textbox']");
}

const DIALOG_INTERACTIVE_FOCUS_SELECTOR =
  "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [role='textbox']";

/**
 * Resolve the local terminal tree for focus claim/restore.
 * Main panes expose `data-session-id`; popup terminals (TerminalPopupPage) do not,
 * so walk up from the dialog until we find the sibling xterm textarea.
 */
export function resolveDisconnectedDialogTerminalRoot(
  dialogNode: Element | null,
  sessionRoot?: Element | null,
): Element | null {
  if (sessionRoot) return sessionRoot;
  if (!dialogNode) return null;
  let node: Element | null = dialogNode.parentElement;
  while (node) {
    if (node.querySelector("textarea.xterm-helper-textarea")) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Only park focus on the disconnected overlay when it is safe:
 * - focus is already lost (body / null) AND this pane may own keyboard focus, or
 * - focus still belongs to this terminal/session tree.
 * Never steal from another pane, side panel, or app chrome.
 *
 * `isFocusedPane === false` means an unfocused split sibling: document-level
 * focus loss must not let that pane claim Enter-reconnect focus.
 * Omit / true outside split contention (solo, focus mode, popup).
 */
export function shouldClaimDisconnectedDialogFocus({
  activeElement,
  dialogNode,
  sessionRoot,
  documentBody,
  documentElement,
  isFocusedPane,
}: {
  activeElement: Element | null;
  dialogNode: HTMLElement;
  sessionRoot: Element | null;
  documentBody?: Element | null;
  documentElement?: Element | null;
  isFocusedPane?: boolean;
}): boolean {
  if (!activeElement || activeElement === documentBody || activeElement === documentElement) {
    return isFocusedPane !== false;
  }
  if (typeof HTMLElement !== "undefined" && !(activeElement instanceof HTMLElement)) {
    return isFocusedPane !== false;
  }
  const active = activeElement as HTMLElement;
  if (dialogNode.contains(active)) {
    // Already on the sink or a dialog control — do not yank off buttons.
    if (active !== dialogNode && active.closest(DIALOG_INTERACTIVE_FOCUS_SELECTOR)) {
      return false;
    }
    // Sink already focused.
    return active !== dialogNode;
  }
  const terminalRoot = resolveDisconnectedDialogTerminalRoot(dialogNode, sessionRoot);
  if (terminalRoot?.contains(active)) {
    return true;
  }
  return false;
}

/**
 * Whether cleanup should hand focus back to xterm.
 * Skip while the overlay node is still in the document — Enter-reconnect may
 * have ended into connecting / auth / host-key without unmounting the dialog.
 */
export function shouldRestoreDisconnectedDialogTerminalFocus(
  dialogNode: HTMLElement | null,
): boolean {
  if (!dialogNode) return false;
  return !dialogNode.isConnected;
}

/**
 * After the overlay unmounts, return focus to this session's xterm if we still own it.
 *
 * Body/html focus after unmount is treated as ownership only when this pane may
 * own keyboard focus (`isFocusedPane !== false`). Unfocused split siblings must
 * not redirect input after a background reconnect completes.
 * If the dialog node still holds focus, restore regardless of the pane flag.
 */
export function restoreTerminalFocusFromDisconnectedDialog({
  activeElement,
  dialogNode,
  sessionRoot,
  documentBody,
  documentElement,
  isFocusedPane,
}: {
  activeElement: Element | null;
  dialogNode: HTMLElement | null;
  sessionRoot: Element | null;
  documentBody?: Element | null;
  documentElement?: Element | null;
  isFocusedPane?: boolean;
}): boolean {
  if (!dialogNode) return false;
  // When React removes the focused overlay, the browser parks focus on body/html
  // before passive-effect cleanup runs — treat that as still owning focus only
  // for the focused pane (or solo / popup where isFocusedPane is omitted).
  const focusLostToDocument =
    !activeElement
    || activeElement === documentBody
    || activeElement === documentElement;
  if (focusLostToDocument) {
    if (isFocusedPane === false) return false;
  } else if (
    activeElement !== dialogNode
    && !dialogNode.contains(activeElement)
  ) {
    return false;
  }
  const terminalRoot = resolveDisconnectedDialogTerminalRoot(dialogNode, sessionRoot);
  if (!terminalRoot) return false;
  const textarea = terminalRoot.querySelector("textarea.xterm-helper-textarea");
  if (!(textarea instanceof HTMLElement)) return false;
  textarea.focus({ preventScroll: true });
  return true;
}

export function shouldDelayAutoRunSnippetInput(
  data: string,
  opts: { noAutoRun?: boolean; multiLineRunMode?: Snippet["multiLineRunMode"] },
): boolean {
  if (opts.noAutoRun) return false;
  if (resolveSnippetMultiLineRunMode(opts.multiLineRunMode) === "paste") return false;
  const normalized = normalizeLineEndings(String(data ?? "")).replace(/\r/g, "\n");
  const withoutSubmitEnter = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutSubmitEnter.includes("\n");
}

export function shouldHideConnectingDialogForConnectionReuse({
  reuseConnectionFromSessionId,
  host,
  connectionReuseFellBack,
}: {
  reuseConnectionFromSessionId?: string;
  host: Host;
  connectionReuseFellBack: boolean;
}): boolean {
  return !!reuseConnectionFromSessionId
    && !connectionReuseFellBack
    && !host.x11Forwarding
    && !host.moshEnabled
    && !host.etEnabled;
}

type XTermWithPrivateRenderService = XTerm & {
  _core?: {
    _renderService?: {
      _renderRows?: (start: number, end: number) => void;
    };
  };
};

export function forceSyncRenderAfterResize(term: XTerm): void {
  const renderService = (term as XTermWithPrivateRenderService)._core?._renderService;
  const renderRows = renderService?._renderRows;
  if (typeof renderRows !== "function") return;

  const endRow = term.rows - 1;
  if (endRow < 0) return;

  try {
    renderRows.call(renderService, 0, endRow);
  } catch (err) {
    logger.warn("Sync render after resize failed", err);
  }
}

type XTermWithPrivateViewport = XTerm & {
  _core?: {
    _viewport?: {
      scrollToLine?: (line: number, disableSmoothScroll?: boolean) => void;
      _sync?: () => void;
    };
  };
};

/**
 * Re-align the DOM scroll position with the buffer's viewport row.
 *
 * xterm's reflow adjusts the buffer's viewport row (ydisp) during resize, but
 * the scrollable viewport keeps its stale pixel offset. Any subsequent
 * relative scroll (wheel, scrollToLine) then applies its delta twice — once
 * against the buffer and once against the stale DOM offset — drifting the
 * reading position (all the way to the top while shrinking, #3299). Snapping
 * the viewport back to the buffer row before a relative restore removes the
 * desync.
 */
export function alignTerminalViewportScroll(term: XTerm): void {
  const viewport = (term as XTermWithPrivateViewport)._core?._viewport;
  const scrollToLine = viewport?.scrollToLine;
  if (typeof scrollToLine !== "function") return;

  // After a resize, xterm only refreshes the viewport's scroll dimensions on
  // its queued render callback. Setting a scroll position against the stale
  // dimensions gets clamped to the old maximum while xterm records the
  // requested row, so the queued sync then assumes the position was already
  // applied and the DOM offset stays stale — the next wheel scroll jumps
  // upward by the resize delta. Sync the dimensions now, before positioning.
  // If synchronized output (DECSET 2026) is active, _sync() above is a no-op
  // that merely defers DOM scroll updates until the mode ends; positioning
  // here would still record the requested row as _latestYDisp against the
  // stale dimensions, and the deferred sync would then see
  // ydisp === _latestYDisp and skip repositioning, leaving a stale DOM
  // offset. Leave positioning to that deferred sync instead: after reflow the
  // buffer's ydisp differs from the recorded _latestYDisp, so it repositions
  // with fresh dimensions on its own.
  if (typeof viewport._sync === "function") {
    try {
      viewport._sync.call(viewport);
    } catch (err) {
      logger.warn("Sync viewport dimensions after resize failed", err);
    }
  }
  if (term.modes?.synchronizedOutputMode) return;

  try {
    scrollToLine.call(viewport, term.buffer.active.viewportY, true);
  } catch (err) {
    logger.warn("Align viewport scroll after resize failed", err);
  }
}

/** Defer the whole fit while xterm keeps the visible frame frozen (DECSET 2026). */
export function createSynchronizedOutputFitScheduler() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    dispose,
    defer(term: XTerm, fit: () => void): boolean {
      dispose();
      if (!term.modes.synchronizedOutputMode) return false;
      // Arms xterm's own synchronized-output timeout even if the program
      // only enabled the mode without writing visible content afterward.
      term.refresh(0, Math.max(0, term.rows - 1));
      timer = setTimeout(() => {
        timer = undefined;
        // The caller re-enters safeFit and checks the mode again, including
        // when another synchronized frame started before this retry.
        fit();
      }, 32);
      return true;
    },
  };
}

type ReflowAnchorCell = {
  getCode(): number;
  /**
   * 0 only for the second cell of a wide glyph that sits on this row;
   * structural wrap padding cells (and ordinary empty cells) have width 1.
   */
  getWidth?(): number;
};

type ReflowAnchorBufferLine = {
  isWrapped?: boolean;
  length?: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell?(x: number, cell?: ReflowAnchorCell): ReflowAnchorCell | undefined;
};

type ReflowAnchorBuffer = {
  length: number;
  baseY: number;
  viewportY: number;
  /**
   * Cursor row within the screen (0-based), so the cursor's absolute buffer
   * row is `baseY + cursorY`. Real xterm buffers expose it; hand-built test
   * buffers may omit it.
   */
  cursorY?: number;
  getLine(y: number): ReflowAnchorBufferLine | undefined;
};

export type TerminalReflowScrollAnchor = {
  /** Buffer row where the logical line under the viewport top starts. */
  startRow: number;
  /** Characters of the logical line above the viewport top row. */
  charOffset: number;
  /** Prefix of the logical line's joined text, used to re-locate it after reflow. */
  textPrefix: string;
  /**
   * Prefix of the first non-blank logical line after the anchor line,
   * skipping any run of blank logical lines (they keep their row count
   * across rewrap, so the skipped run cannot re-position the context line).
   * A blank anchor line has empty text, so without this context every blank
   * line matches and the resolver would land on whichever blank line is
   * nearest the stale row. Null when no non-blank logical line follows.
   */
  contextSuffix: string | null;
  /**
   * Text of the logical line starting at the captured viewport row — the
   * continuation the reader was actually looking at. Equal to `textPrefix`
   * when the viewport top row is the logical line's start. When scrollback
   * trim removes the line's leading physical rows during a column shrink,
   * `textPrefix` can no longer match while the viewed characters survive
   * later in the line; the resolver re-locates them through this text.
   * Optional so hand-built anchors (tests) work without it.
   */
  viewedText?: string;
  /**
   * Joined length of the whole anchored logical line, when the line fits
   * within `REFLOW_ANCHOR_LINE_LENGTH_CHARS`. Rewrap trim removes only
   * leading content, so comparing this with the surviving line's length
   * derives exactly how many leading characters were trimmed — both the
   * captured `charOffset` and the re-located viewed window must move back by
   * that amount. Content matching alone cannot recover it when the window
   * repeats within the line (a long run of one character re-matches at the
   * stale pre-trim offset, scrolling the viewport too far down). Optional so
   * hand-built anchors (tests) work without it.
   */
  lineLength?: number;
};

// Enough characters to tell neighboring output apart (timestamps, prompts,
// command echoes) without scanning whole paragraphs of wrapped rows.
const REFLOW_ANCHOR_TEXT_PREFIX_CHARS = 256;
// Following-line identity that disambiguates blank or repeated anchor lines.
const REFLOW_ANCHOR_CONTEXT_CHARS = 96;
// Cap on how much of the anchored logical line is measured to derive the
// scrollback-trim delta; longer lines fall back to content-only re-location.
// The bound keeps a pathological single line from turning every resize into
// an unbounded O(line) scan, while still measuring any realistic wrapped
// line exactly: content matching alone cannot recover the trim delta when
// the viewed window repeats within the line, so the exact length is the
// only disambiguator and a too-tight cap would silently drop it.
const REFLOW_ANCHOR_LINE_LENGTH_CHARS = 262_144;

const reflowAnchorLogicalLineStart = (buffer: ReflowAnchorBuffer, row: number): number => {
  let start = Math.max(0, Math.min(row, buffer.length - 1));
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  return start;
};

/**
 * Text of one physical row as it participates in a joined logical line.
 *
 * Real trailing spaces on a wrapped row are content: another feature may have
 * cached the row untrimmed via `translateToString(false)` (the autocomplete and
 * prompt parsers do), so a `true` call is satisfied from that cache with
 * `trimEnd()` and drops those spaces. After a reflow the same characters can
 * sit mid-line, making the captured prefix and offset disagree with the
 * re-joined line. Trim only the final physical row of the logical line, where
 * trailing whitespace is viewport padding rather than wrapped content.
 *
 * The final-row trim must still bypass xterm's canonical string cache: a
 * canonical `true` request is served from a cached untrimmed value with
 * `trimEnd()`, which drops real typed spaces, while a fresh translation cuts
 * only the trailing null cells. A column shrink can move typed trailing
 * spaces from the old final row onto a newly wrapped row, where the
 * post-resize translation preserves them — dropping them at capture would
 * make the captured prefix and line length disagree with the re-joined line,
 * so resolution returns null and restoring the stale row jumps. Rows without
 * a cell length (hand-built tests) keep the plain trimmed translation.
 *
 * On a wrapped row, xterm's wide-character wrap padding is structural, not
 * content: when a double-width glyph does not fit at the end of a row, xterm
 * leaves the last cell as a null cell (codepoint 0) and draws the glyph on the
 * next row. Rewrap moves that boundary, so the padding cell must not take part
 * in the joined text — only cells with no codepoint at all are dropped here,
 * while typed spaces (codepoint 32) are kept.
 */
const reflowAnchorRowText = (
  buffer: ReflowAnchorBuffer,
  row: number,
): string => {
  const line = buffer.getLine(row);
  if (!line) return "";
  const isWrappedRow = buffer.getLine(row + 1)?.isWrapped === true;
  const lineLength = typeof line.length === "number" ? line.length : undefined;
  if (!isWrappedRow) {
    if (lineLength === undefined) return line.translateToString(true);
    // Passing an explicit endColumn bypasses xterm's canonical string cache,
    // so a cached untrimmed value cannot reach the trim and drop real typed
    // trailing spaces. The fresh trimmed translation still cuts trailing null
    // cells (viewport padding) while keeping typed spaces as content.
    return line.translateToString(true, 0, lineLength);
  }
  if (lineLength === undefined || !line.getCell) {
    // Fallback for buffer lines without cell access: keep the full untrimmed
    // row rather than risk the trimmed-cache path dropping real spaces.
    return line.translateToString(false);
  }
  // Passing an explicit endColumn bypasses xterm's canonical string cache, so
  // this stays a fresh untrimmed translation even when another feature cached
  // the row.
  const text = line.translateToString(false, 0, lineLength);
  // A trailing null cell is structural wide-character wrap padding only when
  // the glyph that did not fit actually starts the following wrapped row. A
  // null ahead of a normal-width continuation is an erased or skipped cell
  // that renders as a real blank: stripping it would make an anchor captured
  // from "abc " + "Z" read as "abcZ" while a wider rewrap yields "abc Z", so
  // the resolver could no longer re-locate the content.
  const nextFirstCell = buffer.getLine(row + 1)?.getCell?.(0);
  if (!nextFirstCell || nextFirstCell.getWidth?.() !== 2) return text;
  // Exactly one trailing cell can be structural: a double-width glyph wraps
  // only from the row's final column, so xterm nulls just that last cell. Null
  // cells further back come from tabs, cursor-forward moves, or erases; xterm
  // preserves them as real blanks during reflow, so stripping them would make
  // an anchor captured from "abc  " + "中Z" read as "abc中Z" while a wider
  // rewrap joins the same content as "abc 中Z", and the resolver would fall
  // back to the stale row.
  const lastCell = line.getCell(lineLength - 1);
  // A width-0 cell is the second half of a wide glyph that occupies this row's
  // final columns (xterm writes it as codepoint 0, width 0). It is content:
  // `translateToString` skips it in the forward iteration, so it contributes no
  // character and must not be sliced off — slicing it would delete the glyph
  // itself (or half of an emoji surrogate pair).
  const paddingCells =
    lastCell && lastCell.getCode() === 0 && lastCell.getWidth?.() !== 0 ? 1 : 0;
  // The single structural null cell renders as exactly one space, so slicing
  // one character removes precisely the structural padding.
  return paddingCells > 0 ? text.slice(0, text.length - paddingCells) : text;
};

const reflowAnchorJoinTextPrefix = (
  buffer: ReflowAnchorBuffer,
  startRow: number,
  maxChars: number,
): string => {
  let text = "";
  let row = startRow;
  while (row < buffer.length && text.length < maxChars) {
    const line = buffer.getLine(row);
    if (!line) break;
    if (row > startRow && !line.isWrapped) break;
    text += reflowAnchorRowText(buffer, row);
    row += 1;
  }
  return text.slice(0, maxChars);
};

/**
 * Joined length of the whole logical line starting at `row`, measuring rows
 * exactly like the capture-side prefix and offset do. Stops once `maxChars`
 * is reached (the caller treats that as "too long to measure"), so a
 * pathological single line cannot turn every resize into an O(line) scan.
 */
const reflowAnchorLogicalLineLength = (
  buffer: ReflowAnchorBuffer,
  row: number,
  maxChars: number,
): number => {
  let length = 0;
  let r = row;
  while (r < buffer.length) {
    const line = buffer.getLine(r);
    if (!line) break;
    if (r > row && !line.isWrapped) break;
    length += reflowAnchorRowText(buffer, r).length;
    if (length >= maxChars) return length;
    r += 1;
  }
  return length;
};

/** First logical line strictly after the one starting at `row`, or null. */
const reflowAnchorNextLogicalLineStart = (
  buffer: ReflowAnchorBuffer,
  row: number,
): number | null => {
  let next = row + 1;
  while (next < buffer.length && buffer.getLine(next)?.isWrapped) next += 1;
  return next < buffer.length ? next : null;
};

/**
 * First logical line strictly after the one starting at `row` whose joined
 * text is non-empty, or null. A blank logical line is a single empty row at
 * every width, so a run of blank lines survives rewrap intact and cannot
 * re-position the lines after it relative to the anchor — skipping the run
 * is stable on both sides of the resize.
 */
const reflowAnchorNextNonBlankLogicalLineStart = (
  buffer: ReflowAnchorBuffer,
  row: number,
): number | null => {
  let next = reflowAnchorNextLogicalLineStart(buffer, row);
  while (next !== null && reflowAnchorJoinTextPrefix(buffer, next, 1) === "") {
    next = reflowAnchorNextLogicalLineStart(buffer, next);
  }
  return next;
};

/**
 * Capture what the reader is looking at before a fit-induced reflow.
 *
 * Restoring a pre-resize row index keeps the reading position only when rows
 * above the viewport keep their count. A column change rewraps the whole
 * scrollback, inserting rows above the viewport while shrinking (the reading
 * content slides down) and removing them while growing — restoring the stale
 * index then walks the viewport toward the top on every shrink step until it
 * lands there (#3299). Anchoring on the viewport top's content instead lets
 * the restore re-locate the same characters after the reflow. Returns null
 * when there is nothing above the viewport worth anchoring (top row, or the
 * pinned/alternate-screen case handled by the bottom-anchored restore).
 */
export function captureTerminalReflowScrollAnchor(
  buffer: ReflowAnchorBuffer,
): TerminalReflowScrollAnchor | null {
  const viewportY = buffer.viewportY;
  if (!Number.isFinite(viewportY) || viewportY <= 0 || viewportY > buffer.baseY) return null;

  const startRow = reflowAnchorLogicalLineStart(buffer, viewportY);
  let charOffset = 0;
  for (let row = startRow; row < viewportY; row += 1) {
    charOffset += reflowAnchorRowText(buffer, row).length;
  }
  const textPrefix = reflowAnchorJoinTextPrefix(buffer, startRow, REFLOW_ANCHOR_TEXT_PREFIX_CHARS);
  const viewedText = reflowAnchorJoinTextPrefix(buffer, viewportY, REFLOW_ANCHOR_TEXT_PREFIX_CHARS);
  // Identity beyond the anchor line itself: the first *non-blank* logical
  // line after it, skipping any run of blank lines. Scanning only to the
  // immediate follower would leave a blank anchor unanchored whenever the
  // next line is blank too, even though unique output further down pins the
  // position exactly (blank runs keep their row count across rewrap).
  const contextStart = reflowAnchorNextNonBlankLogicalLineStart(buffer, startRow);
  const contextSuffix = contextStart === null
    ? null
    : reflowAnchorJoinTextPrefix(buffer, contextStart, REFLOW_ANCHOR_CONTEXT_CHARS);
  // A blank anchor line with no non-blank line after it carries no identity
  // at all: every blank line would match, so re-locating by content cannot
  // beat the plain row restore. Return null and let the caller fall back to it.
  if (textPrefix === "" && contextSuffix === null) return null;
  const lineLength = reflowAnchorLogicalLineLength(buffer, startRow, REFLOW_ANCHOR_LINE_LENGTH_CHARS);
  return {
    startRow,
    charOffset,
    textPrefix,
    contextSuffix,
    viewedText,
    // Only a fully measured line supports the trim-delta derivation below.
    lineLength: lineLength < REFLOW_ANCHOR_LINE_LENGTH_CHARS ? lineLength : undefined,
  };
}

/**
 * Whether the anchor's context line — the first non-blank logical line after
 * the anchored one, starting at `contextRow` — contains the cursor.
 *
 * The pinned xterm configuration leaves `reflowCursorLine` at its false
 * default: reflow skips the cursor's logical line entirely, and the
 * post-reflow line resize then truncates each of its rows to the new column
 * count. The context line's joined text changes on a narrowing resize even
 * though the anchored line itself survived, so a captured `contextSuffix` for
 * that line can no longer match and requiring the exact match would reject
 * the surviving anchored line, falling back to the stale row index. Tolerate
 * a context mismatch when the context line is the cursor line: that position
 * still disambiguates the anchor, because only the logical line immediately
 * preceding the cursor line can claim it. (Blank lines skipped on the way to
 * the context line need no tolerance: truncation keeps a blank line blank.)
 */
const reflowAnchorContextIsCursorLine = (
  buffer: ReflowAnchorBuffer,
  contextRow: number,
): boolean => {
  const cursorY = buffer.cursorY;
  if (typeof cursorY !== "number" || !Number.isFinite(cursorY)) return false;
  const cursorRow = buffer.baseY + cursorY;
  if (cursorRow < contextRow) return false;
  let contextEnd = contextRow;
  while (contextEnd + 1 < buffer.length && buffer.getLine(contextEnd + 1)?.isWrapped) contextEnd += 1;
  return cursorRow <= contextEnd;
};

/** True when the logical line at `row` matches the anchor's captured identity. */
const reflowAnchorCandidateMatches = (
  buffer: ReflowAnchorBuffer,
  row: number,
  anchor: TerminalReflowScrollAnchor,
): boolean => {
  if (reflowAnchorJoinTextPrefix(buffer, row, REFLOW_ANCHOR_TEXT_PREFIX_CHARS) !== anchor.textPrefix) {
    return false;
  }
  const contextStart = reflowAnchorNextNonBlankLogicalLineStart(buffer, row);
  if (contextStart === null || anchor.contextSuffix === null) {
    return contextStart === null && anchor.contextSuffix === null;
  }
  return reflowAnchorJoinTextPrefix(buffer, contextStart, REFLOW_ANCHOR_CONTEXT_CHARS)
      === anchor.contextSuffix
    || reflowAnchorContextIsCursorLine(buffer, contextStart);
};

/**
 * `charOffset` adjusted for leading content a scrollback trim removed, or -1
 * when the adjustment cannot be validated.
 *
 * Trim removes only leading rows, so a partially trimmed logical line
 * survives at row 0 as a suffix of the captured one, beginning `trimChars`
 * characters into it; every captured offset within the line shrinks by that
 * amount. Comparing the captured line length with the surviving length
 * derives `trimChars` exactly, which content matching alone cannot do when
 * the anchored window repeats within the line (a long run of one character
 * would re-match at the stale pre-trim offset and scroll the viewport too
 * far down the surviving line). The derived position is validated against
 * the captured viewed text so a coincidental repeat cannot claim it.
 *
 * Only row 0 can be partially trimmed (trim removes from the buffer top), so
 * any other row — and any anchor without a captured line length, such as
 * hand-built test anchors — keeps the plain offset.
 */
const reflowAnchorTrimAdjustedCharOffset = (
  buffer: ReflowAnchorBuffer,
  row: number,
  anchor: TerminalReflowScrollAnchor,
): number => {
  const lineLength = anchor.lineLength;
  if (
    row !== 0 ||
    typeof lineLength !== "number" ||
    !Number.isFinite(lineLength) ||
    lineLength <= 0
  ) {
    return anchor.charOffset;
  }
  const survivingLength = reflowAnchorLogicalLineLength(
    buffer,
    0,
    REFLOW_ANCHOR_LINE_LENGTH_CHARS,
  );
  if (survivingLength >= REFLOW_ANCHOR_LINE_LENGTH_CHARS) return anchor.charOffset;
  const trimChars = Math.max(0, lineLength - survivingLength);
  const target = anchor.charOffset - trimChars;
  if (target < 0) return -1;
  const viewedText = typeof anchor.viewedText === "string" ? anchor.viewedText : "";
  if (viewedText !== "") {
    const text = reflowAnchorJoinTextPrefix(buffer, 0, target + viewedText.length);
    if (text.length < target + viewedText.length || !text.startsWith(viewedText, target)) {
      return -1;
    }
  }
  return target;
};

/**
 * In-line offset of the anchor's viewed characters within the logical line at
 * `row`, or -1 when the line does not contain them.
 *
 * Fallback identity for a partially trimmed logical line: a column shrink on
 * a full scrollback removes the line's leading physical rows, so its captured
 * `textPrefix` no longer matches anywhere while the characters the viewport
 * was showing (the viewed continuation) survive later in the line. When the
 * captured line length is known, the trim delta is derived exactly and the
 * viewed characters are required at `charOffset` minus that delta (see
 * `reflowAnchorTrimAdjustedCharOffset`). Without a captured length, rewrap is
 * only known to remove leading content, so the viewed text is searched from
 * the captured `charOffset` backwards and the closest such position wins —
 * which cannot distinguish the true position when the window repeats within
 * the line. The following-line identity check still applies so blank or
 * repeated continuations do not resolve to a nearby decoy.
 */
const reflowAnchorContinuationOffset = (
  buffer: ReflowAnchorBuffer,
  row: number,
  anchor: TerminalReflowScrollAnchor,
): number => {
  const viewedText = typeof anchor.viewedText === "string" ? anchor.viewedText : "";
  if (viewedText === "" || anchor.charOffset <= 0) return -1;
  const contextStart = reflowAnchorNextNonBlankLogicalLineStart(buffer, row);
  if (contextStart === null || anchor.contextSuffix === null) {
    if (contextStart !== null || anchor.contextSuffix !== null) return -1;
  } else if (
    reflowAnchorJoinTextPrefix(buffer, contextStart, REFLOW_ANCHOR_CONTEXT_CHARS)
      !== anchor.contextSuffix
    && !reflowAnchorContextIsCursorLine(buffer, contextStart)
  ) {
    return -1;
  }
  if (row === 0 && typeof anchor.lineLength === "number" && Number.isFinite(anchor.lineLength)) {
    return reflowAnchorTrimAdjustedCharOffset(buffer, row, anchor);
  }
  // A match starting at or before `charOffset` fits entirely within the first
  // `charOffset + viewedText.length` characters of the line.
  const text = reflowAnchorJoinTextPrefix(
    buffer,
    row,
    anchor.charOffset + viewedText.length,
  );
  return text.lastIndexOf(viewedText, anchor.charOffset);
};

/**
 * Re-locate the anchored reading position after a reflow.
 *
 * Returns the buffer row that now holds the captured characters, or null when
 * the anchored content is gone (e.g. trimmed from a full scrollback) so the
 * caller can fall back to the plain row restore.
 *
 * `hintRow` is the row a stable marker (one tracked by xterm through the
 * rewrap) points at after the resize. Rewrap shifts the anchored line by the
 * accumulated wrap delta of everything above it — tens of thousands of rows
 * for large scrollbacks — so scanning outward from the stale `anchor.startRow`
 * can cost O(scrollback) per resize frame. Seeding the same outward scan from
 * the marker row keeps it O(delta) around the true position; the full scan
 * from the stale row only runs as a fallback when the marker is unavailable
 * (scrollback trim disposes it) or its neighborhood no longer matches.
 */
export function resolveTerminalReflowScrollAnchor(
  buffer: ReflowAnchorBuffer,
  anchor: TerminalReflowScrollAnchor,
  hintRow?: number | null,
): number | null {
  const seedRow = typeof hintRow === "number" && Number.isFinite(hintRow)
    && hintRow >= 0 && hintRow < buffer.length
    ? hintRow
    : null;
  const primaryRow = (row: number): number =>
    reflowAnchorCandidateMatches(buffer, row, anchor)
      ? reflowAnchorTrimAdjustedCharOffset(buffer, row, anchor)
      : -1;
  // Continuation tracking only applies when the viewport started partway into
  // the logical line: otherwise trimming the line's start row removes the
  // viewed characters too, and the plain row fallback is correct.
  const trackContinuation = anchor.charOffset > 0
    && typeof anchor.viewedText === "string"
    && anchor.viewedText.length > 0;
  const resolveFrom = (from: number, onlyRow?: number): number | null => {
    const match = (row: number, base: (r: number) => number): number =>
      onlyRow === undefined || row === onlyRow ? base(row) : -1;
    const primary = reflowScanOutward(buffer, anchor, from, (row) =>
      match(row, primaryRow));
    if (primary !== null) return primary;
    if (!trackContinuation) return null;
    return reflowScanOutward(buffer, anchor, from, (row) =>
      match(row, (r) => reflowAnchorContinuationOffset(buffer, r, anchor)));
  };
  // A surviving marker is pinned to the viewed row or to the anchored
  // logical line's start, so it lives inside that line. In the continuation
  // case the marker can sit deep inside a long wrapped line, where a
  // repeating line/follower block below it is closer to the marker than the
  // original line's start is; a proximity scan seeded from the marker would
  // then jump into the duplicate even though the fallback from the stale
  // `anchor.startRow` selects the original. Constrain the seeded scan to the
  // marker's containing line, falling through to the stale-row scan when
  // that line no longer matches.
  const seededLine = seedRow !== null && trackContinuation
    ? reflowAnchorLogicalLineStart(buffer, seedRow)
    : undefined;
  if (seedRow !== null && seedRow !== anchor.startRow) {
    const seeded = resolveFrom(seedRow, seededLine);
    if (seeded !== null) return seeded;
  }
  return resolveFrom(anchor.startRow);
}

/**
 * Scan outward from `startRow`, checking the closest logical lines first and
 * stopping as soon as no remaining row can beat the best match. A tie at equal
 * distance resolves to the topmost row, matching a plain top-down scan.
 *
 * `matchRow` returns the in-line character offset that should end up at the
 * viewport top when `row` is the anchored logical line, or -1 for no match.
 */
const reflowScanOutward = (
  buffer: ReflowAnchorBuffer,
  anchor: TerminalReflowScrollAnchor,
  startRow: number,
  matchRow: (row: number) => number,
): number | null => {
  let bestRow = -1;
  let bestOffset = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  const maxDistance = Math.max(startRow, buffer.length - 1 - startRow);
  for (let distance = 0; distance <= maxDistance && distance <= bestDistance; distance += 1) {
    for (const row of distance === 0 ? [startRow] : [startRow - distance, startRow + distance]) {
      if (row < 0 || row >= buffer.length) continue;
      // A wrapped row continues the logical line above it, so it is matched at
      // its start — except row 0, which after a scrollback trim may begin
      // mid-logical-line with no start row left in the buffer.
      if (row > 0 && buffer.getLine(row)?.isWrapped) continue;
      const offset = matchRow(row);
      if (offset >= 0 && distance < bestDistance) {
        bestDistance = distance;
        bestRow = row;
        bestOffset = offset;
      }
    }
  }
  if (bestRow < 0) return null;

  // Rewrap moves the captured characters to a different row offset within the
  // logical line; walk the (new) row boundaries to the row holding them. Use
  // the same per-row text as the capture so real trailing spaces on wrapped
  // rows are counted identically on both sides.
  let targetRow = bestRow;
  let remaining = bestOffset;
  while (remaining > 0) {
    if (!buffer.getLine(targetRow) || !buffer.getLine(targetRow + 1)?.isWrapped) break;
    const rowLength = reflowAnchorRowText(buffer, targetRow).length;
    if (remaining < rowLength) break;
    remaining -= rowLength;
    targetRow += 1;
  }
  return Math.min(targetRow, buffer.baseY);
}
