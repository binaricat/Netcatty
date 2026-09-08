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
  /**
   * Characters the cell contributes to `translateToString` (a wide glyph's
   * first cell carries the whole glyph, combining marks included; null and
   * width-0 continuation cells contribute none). Real xterm cells expose it;
   * hand-built test cells may omit it.
   */
  getString?(): string;
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
   * Text of each physical row of the captured context line, cut so the rows
   * join to exactly `contextSuffix` (the last row is shortened where the
   * suffix's character cap falls mid-row). The cursor-line tolerance needs
   * these boundaries: a narrowing resize truncates the cursor line row by
   * row, so each surviving row is a prefix of the row captured at the same
   * position — comparing each surviving row against its own captured prefix
   * keeps the tolerance from accepting a duplicate whose rows merely appear
   * as ordered substrings of the captured text with arbitrary gaps between
   * them. Undefined for hand-built anchors (tests) and when the context
   * line's row count reaches `REFLOW_ANCHOR_MAX_LINE_ROWS` before the
   * captured suffix is covered; the row-wise tolerance then declines and
   * only the strict checks apply.
   */
  contextRowTexts?: string[];
  /**
   * True only with a null `contextSuffix`, and only when the capture's
   * follower lookup ended at `REFLOW_ANCHOR_MAX_LINE_CHARS` rather than at
   * the end of the buffer — a follower line existed but its identity was
   * dropped by the character bound. The bound counts the anchored line's own
   * characters, which a scrollback trim shrinks (it removes only leading
   * content), so the resolve side can find a follower the capture was over
   * the bound for. Without this flag the resolve's strict null-vs-found
   * comparison would reject the otherwise matching anchor and fall back to
   * the stale row, jumping the viewport. With it, the resolve treats the
   * follower as unidentified — the same text-only degradation the bound
   * already applies when both sides drop it — instead of a mismatch.
   * Undefined (falsy) for hand-built anchors (tests), which keep the strict
   * no-follower requirement.
   */
  contextDropped?: boolean;
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
   * within `REFLOW_ANCHOR_LINE_LENGTH_CHARS` and a scrollback trim could
   * reach the line during the pending resize (otherwise the plain offset is
   * exact and the measurement is skipped). Rewrap trim removes only
   * leading content, so comparing this with the surviving line's length
   * derives exactly how many leading characters were trimmed — both the
   * captured `charOffset` and the re-located viewed window must move back by
   * that amount. Content matching alone cannot recover it when the window
   * repeats within the line (a long run of one character re-matches at the
   * stale pre-trim offset, scrolling the viewport too far down). Optional so
   * hand-built anchors (tests) work without it.
   */
  lineLength?: number;
  /**
   * Whether the anchored logical line contained the cursor row at capture
   * time. With the pinned `reflowCursorLine: false` default such a line is
   * never rewrapped — a column change only truncates or null-pads its rows
   * in place — so its row indices survive the rewrap and a viewport-row
   * marker inside it still marks the viewed row. Any other wrapped line is
   * rewrapped, and a column shrink then appends the group's newly created
   * rows after the existing ones, leaving a marker inside the group at its
   * old within-line row while the viewed characters move deeper — so the
   * caller must not trust such a marker as a restore position. False also
   * covers a containment walk past its bound (unknown), which declines the
   * marker trust the same way. Optional so hand-built test anchors work
   * without it.
   */
  containsCursor?: boolean;
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
// Cap on how far back the capture walks a wrapped logical line to its start
// and how many physical rows the `charOffset` pass may translate. Each
// walk steps one physical row at a time, so a viewport inside a multi-megabyte
// wrapped line (minified JSON, base64) would otherwise repeat O(line)
// renderer-thread work on every column-changing fit frame. Beyond the cap the
// anchor is dropped (or its follower identity is dropped) and the fit falls
// back to the next-best restore.
const REFLOW_ANCHOR_MAX_LINE_ROWS = 2048;
// Cap on how far back the resolve-side walk from a surviving viewport-row
// marker to its containing logical line's start may go. The capture-side walk
// (`REFLOW_ANCHOR_MAX_LINE_ROWS`) bounds the pre-resize distance, but a column
// shrink rewraps that same prefix into up to `oldCols / newCols` times as many
// rows, so after a large shrink the marker can legitimately sit much deeper
// into the reflowed line than it did at capture. The bound leaves headroom for
// an 8x shrink (the marker row is then at most 8 * REFLOW_ANCHOR_MAX_LINE_ROWS
// rows from the line's start) while keeping the per-frame walk strictly
// bounded instead of traversing the whole supported scrollback. Beyond the
// bound the containing line is treated as unresolved: the seeded scan is
// skipped (an unconstrained scan from the marker would re-walk every
// continuation row it just declined to visit, and could jump into a duplicate
// line closer to the marker) and the resolver falls back to the stale-row
// scan, the same degradation it already uses when the seeded line no longer
// matches.
const REFLOW_ANCHOR_MARKER_LINE_WALK_ROWS = 16_384;
// Cap on how far the context lookup may scan a run of blank logical lines
// after the anchor before giving up. The bound counts only the blank rows
// between the anchored line's first follower and the context line: the
// anchored line's own continuation row count changes with rewrap, so
// including it would let the column change alone flip whether a captured
// context stays reachable. A blank logical line is a single empty row at
// every width, so the counted run keeps its row count across rewrap: capture
// and resolve therefore truncate at the same line and either both find the
// same non-blank context line or both report none — the bound cannot make
// the two sides disagree.
const REFLOW_ANCHOR_CONTEXT_SCAN_ROWS = 1024;
// Cap on how many joined characters the forward walk to the next logical line
// may cross before the follower identity is dropped. The bound counts
// characters, not physical rows: a row count is reflow-variable (the same
// logical line occupies more rows at a narrower width), so a column change
// alone could push the line past a row bound between capture and resolve and
// drop a captured follower context there, rejecting the otherwise unchanged
// anchor. Joined characters survive rewrap unchanged — the cursor's own line
// can only lose characters to row truncation, never gain them — so once a
// line fits the bound at capture it still fits at resolve. The reverse does
// not hold under scrollback trim: the count starts at the anchored line
// itself, and trim removes the line's leading characters, so a line over the
// bound at capture can fall under it at resolve and present a follower the
// capture dropped. Capture records that case (`contextDropped`) and the
// resolve side degrades to text-only identity instead of rejecting the
// anchor over the mismatch. The value matches
// REFLOW_ANCHOR_LINE_LENGTH_CHARS, the cap already accepted for whole-line
// measurement, so any line whose follower stays reachable is also a line
// whose length could have been measured anyway.
const REFLOW_ANCHOR_MAX_LINE_CHARS = 262_144;
// Cap on how far the cursor-line containment check may walk the context
// line's wrapped rows toward the cursor. The walk already stops at the cursor
// row, but a multi-megabyte cursor line (minified JSON, base64) puts the
// cursor tens of thousands of wrapped rows below the context line's start,
// and every column-changing fit re-runs the walk once per candidate follower
// match — renderer-thread work every other reflow scan here caps. Beyond the
// bound the containment answer is reported as unknown and the cursor-line
// tolerance is declined (the strict checks and the plain fallbacks apply);
// a context line that ends within the bound still gets the exact answer. The
// value matches REFLOW_ANCHOR_MAX_LINE_ROWS, the per-frame row cap the
// capture-side walks already accept, so no scan of this kind exceeds that
// order of work per fit frame.
const REFLOW_ANCHOR_CURSOR_LINE_WALK_ROWS = REFLOW_ANCHOR_MAX_LINE_ROWS;

/**
 * Start row of the logical line containing `row`, or undefined when that walk
 * exceeds `maxRows` physical rows. Bounded: after a large column shrink a
 * surviving marker can sit tens of thousands of rows into the reflowed line,
 * and this walk runs on every resolve — the bound keeps it from stepping
 * through nearly the whole scrollback per divider-drag frame (see
 * `REFLOW_ANCHOR_MARKER_LINE_WALK_ROWS`).
 */
const reflowAnchorLogicalLineStart = (
  buffer: ReflowAnchorBuffer,
  row: number,
  maxRows: number,
): number | undefined => {
  let start = Math.max(0, Math.min(row, buffer.length - 1));
  while (start > 0 && buffer.getLine(start)?.isWrapped) {
    if (row - start >= maxRows) return undefined;
    start--;
  }
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

/**
 * First logical line strictly after the one starting at `row`, or null.
 *
 * Bounded (`maxChars`, counted in joined characters): the walk crosses every
 * continuation row of the line at `row` just to find where it ends, so a
 * viewport near the top of a very long wrapped line would otherwise repeat an
 * O(line) scan on every resize frame — even when nothing else is measured (a
 * column grow, or the trim-delta skip). Counting characters instead of rows
 * keeps the bound reflow-invariant: a row count changes with the column
 * width, so a column change alone could push the line past the bound between
 * capture and resolve and make a captured follower context vanish there,
 * rejecting the otherwise unchanged anchor. The count must cover the whole
 * logical line: the line's first physical row is part of it, and its length
 * changes with the column count, so excluding it would leave the count
 * reflow-variable — a wide first row at capture and a narrow one at resolve
 * could push the same line past the bound on one side only. Characters
 * survive rewrap unchanged, so both sides either find the same follower or
 * both drop it. Every wrapped row exists only because content overflowed onto
 * it, so each visited row contributes at least one character and the walk
 * costs O(maxChars) row translations. Beyond the bound the follower identity
 * is dropped on both sides: capture records no context and resolve reports
 * none, so they stay consistent and the anchor degrades to its own text.
 *
 * The one asymmetry the bound cannot absorb on its own is scrollback trim:
 * the count starts at the anchored line itself, and a partial trim removes
 * the line's *leading* characters, shrinking the count without touching the
 * follower. A line over the bound at capture can therefore fall under it at
 * resolve, and the resolve would then present a follower the capture never
 * identified. Callers learn about that case through `boundDropped` (see
 * `TerminalReflowScrollAnchor.contextDropped`) instead of being able to
 * distinguish it from a genuine end-of-buffer.
 */
type ReflowAnchorNextLineLookup = {
  /** Start row of the next logical line, or null when there is none. */
  start: number | null;
  /**
   * True when the character bound — not the end of the buffer — ended the
   * lookup. A follower may still exist past the bound; the caller must not
   * read `start: null` as "no follower exists" in that case.
   */
  boundDropped: boolean;
};

const reflowAnchorNextLogicalLineStart = (
  buffer: ReflowAnchorBuffer,
  row: number,
  maxChars: number,
): ReflowAnchorNextLineLookup => {
  let next = row + 1;
  let chars = reflowAnchorRowText(buffer, row).length;
  if (chars > maxChars) return { start: null, boundDropped: true };
  while (next < buffer.length && buffer.getLine(next)?.isWrapped) {
    chars += reflowAnchorRowText(buffer, next).length;
    if (chars > maxChars) return { start: null, boundDropped: true };
    next += 1;
  }
  return { start: next < buffer.length ? next : null, boundDropped: false };
};

/**
 * First logical line strictly after the one starting at `row` whose joined
 * text is non-empty, or null. A blank logical line is a single empty row at
 * every width, so a run of blank lines survives rewrap intact and cannot
 * re-position the lines after it relative to the anchor — skipping the run
 * is stable on both sides of the resize. `boundDropped` propagates the
 * character-bound outcome of any walk involved (see
 * `reflowAnchorNextLogicalLineStart`): the row bound below truncates
 * identically on both sides, but a scrollback trim can move the anchored
 * line under the character bound between capture and resolve, so resolve
 * must be able to tell "no follower" from "follower past the bound".
 */
const reflowAnchorNextNonBlankLogicalLineStart = (
  buffer: ReflowAnchorBuffer,
  row: number,
): ReflowAnchorNextLineLookup => {
  // Bounded (REFLOW_ANCHOR_CONTEXT_SCAN_ROWS) so a long run of blank lines
  // after the anchor cannot turn every column-changing fit into an O(run)
  // scan. The bound counts only the blank rows between the anchored line's
  // first follower and the context line: the anchored line's own continuation
  // rows also lie between the anchor and that follower, and their count
  // changes with the pending rewrap, so measuring from the anchor row would
  // let the column change alone flip whether a captured context stays
  // reachable (the anchored line growing past the bound on one side of the
  // resize would drop the context there and reject the surviving anchor even
  // with no intervening blanks). Blank logical lines are single empty rows at
  // every width, so measuring from the first follower keeps capture and
  // resolve truncating at the same line (see the constant's comment).
  const first = reflowAnchorNextLogicalLineStart(buffer, row, REFLOW_ANCHOR_MAX_LINE_CHARS);
  if (first.start === null) return first;
  let next = first.start;
  while (
    next - first.start <= REFLOW_ANCHOR_CONTEXT_SCAN_ROWS
    && reflowAnchorJoinTextPrefix(buffer, next, 1) === ""
  ) {
    const following = reflowAnchorNextLogicalLineStart(buffer, next, REFLOW_ANCHOR_MAX_LINE_CHARS);
    if (following.start === null) return following;
    next = following.start;
  }
  return next - first.start <= REFLOW_ANCHOR_CONTEXT_SCAN_ROWS
    ? { start: next, boundDropped: false }
    : { start: null, boundDropped: false };
};

/**
 * Row/column bounds of the pending resize, used to skip the whole-line
 * measurement when no scrollback trim can reach the anchored line. xterm's
 * buffer keeps at most `newRows + scrollback` rows (`Buffer._getCorrectBufferLength`),
 * trimming from the top beyond that — once before the rewrap (row reduction)
 * and again while a column shrink inserts wrapped rows.
 */
export type TerminalReflowTrimLimits = {
  /** Rows xterm keeps before trimming from the buffer top: newRows + scrollback. */
  maxRows: number;
  /** Terminal columns before the pending resize. */
  oldCols: number;
  /** Terminal columns after the pending resize. */
  newCols: number;
};

/**
 * Whether a scrollback trim can eat into the anchored logical line during the
 * pending resize, i.e. whether the captured whole-line length could ever be
 * needed by the trim-delta derivation.
 *
 * xterm trims only from the buffer top, and only past `maxRows`. A row
 * reduction trims `length - maxRows` rows before the rewrap. A column shrink
 * rewrap adds at most `length * oldCols / newCols` rows: each physical row of
 * `c` cells (`c ≤ oldCols`) rewraps into `ceil(c / newCols)` rows, so it adds
 * `ceil(c / newCols) - 1 ≤ (c - 1) / newCols` rows (empty rows add none), and
 * the total added rows are bounded by `length * oldCols / newCols`. The
 * anchored line is partially trimmed — the only case the captured length
 * disambiguates — only when the worst-case overflow also covers the rows
 * above it. A column grow merges rows and never trims. When trim provably
 * cannot reach the line, the whole-line measurement (up to
 * `REFLOW_ANCHOR_LINE_LENGTH_CHARS` translated characters across thousands of
 * physical rows, on every resize frame) is pure overhead and the resolver's
 * plain offset is exact for an untrimmed line.
 */
const reflowAnchorTrimCanReachLine = (
  buffer: ReflowAnchorBuffer,
  startRow: number,
  limits: TerminalReflowTrimLimits,
): boolean => {
  if (!(limits.maxRows > 0) || !(limits.oldCols > 0) || !(limits.newCols > 0)) {
    // Unknown bounds: measure, keeping the unconditional previous behavior.
    return true;
  }
  // A row reduction trims from the buffer top before the rewrap runs.
  const rowTrim = Math.max(0, buffer.length - limits.maxRows);
  if (rowTrim > startRow) return true;
  // A column grow merges rows and never trims past the row reduction above.
  if (limits.newCols >= limits.oldCols) return false;
  const rowsAbove = Math.max(0, startRow - rowTrim);
  // Worst-case rewrap overflow; using the pre-trim length only overestimates.
  const worstOverflow = buffer.length
    + (buffer.length * limits.oldCols) / limits.newCols
    - limits.maxRows;
  return worstOverflow > rowsAbove;
};

/**
 * Per-row text of the context line's physical rows, cut so the rows join to
 * exactly the captured suffix (the last row is shortened where the character
 * cap falls mid-row). The cursor-line tolerance compares each surviving row
 * against the row captured at the same position, so the boundaries must join
 * to the captured identity — a mismatched pair would let the tolerance
 * validate text the strict checks reject. Undefined when the line's row
 * count reaches the walk bound before the captured suffix is covered: a
 * partial boundary list would no longer join to the suffix, so the row-wise
 * tolerance declines instead of trusting it.
 */
const reflowAnchorContextRowTexts = (
  buffer: ReflowAnchorBuffer,
  contextRow: number,
  maxChars: number,
): string[] | undefined => {
  const rows: string[] = [];
  let total = 0;
  let row = contextRow;
  while (total < maxChars) {
    if (rows.length >= REFLOW_ANCHOR_MAX_LINE_ROWS) return undefined;
    const line = buffer.getLine(row);
    if (!line || (row > contextRow && !line.isWrapped)) break;
    const text = reflowAnchorRowText(buffer, row);
    const take = Math.min(text.length, maxChars - total);
    rows.push(text.slice(0, take));
    total += take;
    row += 1;
  }
  return rows;
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
 *
 * `trimLimits` is optional so hand-built buffers (tests) keep the
 * unconditional measurement; when given, the whole-line measurement runs
 * only when a trim could reach the anchored line.
 */
export function captureTerminalReflowScrollAnchor(
  buffer: ReflowAnchorBuffer,
  trimLimits?: TerminalReflowTrimLimits,
): TerminalReflowScrollAnchor | null {
  const viewportY = buffer.viewportY;
  if (!Number.isFinite(viewportY) || viewportY <= 0 || viewportY > buffer.baseY) return null;

  // Bounded walk back to the logical-line start (REFLOW_ANCHOR_MAX_LINE_ROWS):
  // the walk and the charOffset pass below each translate one physical row per
  // step, so a viewport deep inside a multi-megabyte wrapped line would
  // otherwise repeat O(line) work on every column-changing fit frame. Beyond
  // the bound the anchor is dropped and the caller falls back to the plain
  // row restore.
  let startRow = viewportY;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) {
    if (viewportY - startRow >= REFLOW_ANCHOR_MAX_LINE_ROWS) return null;
    startRow -= 1;
  }
  // Bounded by construction: the loop covers the at-most
  // REFLOW_ANCHOR_MAX_LINE_ROWS physical rows between `startRow` and `viewportY`.
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
  const context = reflowAnchorNextNonBlankLogicalLineStart(buffer, startRow);
  const contextStart = context.start;
  const contextSuffix = contextStart === null
    ? null
    : reflowAnchorJoinTextPrefix(buffer, contextStart, REFLOW_ANCHOR_CONTEXT_CHARS);
  const contextRowTexts = contextStart === null || contextSuffix === null
    ? undefined
    : reflowAnchorContextRowTexts(buffer, contextStart, REFLOW_ANCHOR_CONTEXT_CHARS);
  // A blank anchor line with no non-blank line after it carries no identity
  // at all: every blank line would match, so re-locating by content cannot
  // beat the plain row restore. Return null and let the caller fall back to it.
  if (textPrefix === "" && contextSuffix === null) return null;
  // The whole-line measurement translates up to REFLOW_ANCHOR_LINE_LENGTH_CHARS
  // characters across thousands of physical rows and only feeds the trim-delta
  // derivation, so run it only when a trim could actually reach the line.
  let lineLength: number | undefined;
  if (!trimLimits || reflowAnchorTrimCanReachLine(buffer, startRow, trimLimits)) {
    const measured = reflowAnchorLogicalLineLength(buffer, startRow, REFLOW_ANCHOR_LINE_LENGTH_CHARS);
    lineLength = measured < REFLOW_ANCHOR_LINE_LENGTH_CHARS ? measured : undefined;
  }
  return {
    startRow,
    charOffset,
    textPrefix,
    contextSuffix,
    // True when the follower lookup hit the character bound rather than the
    // buffer end: a follower line existed but stayed unidentified, and the
    // resolve side must degrade to text-only matching instead of rejecting
    // the anchor over a follower the capture never captured (a scrollback
    // trim can move the line under the bound between capture and resolve).
    contextDropped: contextStart === null && context.boundDropped,
    // Undefined when the boundary list cannot cover the suffix; the row-wise
    // cursor-line tolerance then declines and only the strict checks apply.
    contextRowTexts,
    viewedText,
    // Only a fully measured line supports the trim-delta derivation below.
    lineLength,
    // Lets the caller trust a surviving viewport-row marker as a restore
    // position: only the cursor's own logical line (or the anchored line's
    // start row, which the caller checks directly) keeps a marker's row
    // pointing at the viewed characters through a column shrink.
    containsCursor: reflowAnchorLineContainsCursor(buffer, viewportY),
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
 *
 * Bounded: the walk from `contextRow` to the cursor row steps one physical
 * row at a time, so a very long cursor line would repeat O(distance) work per
 * candidate match on every column-changing fit. Past
 * `REFLOW_ANCHOR_CURSOR_LINE_WALK_ROWS` the answer is reported as `undefined`
 * (unknown) and every caller declines the cursor-line tolerance — a line that
 * ends, or reaches the cursor, within the bound still gets the exact answer.
 */
const reflowAnchorContextIsCursorLine = (
  buffer: ReflowAnchorBuffer,
  contextRow: number,
): boolean | undefined => {
  const cursorY = buffer.cursorY;
  if (typeof cursorY !== "number" || !Number.isFinite(cursorY)) return false;
  const cursorRow = buffer.baseY + cursorY;
  if (cursorRow < contextRow) return false;
  // Stop at the cursor row: the answer only depends on whether the context
  // line reaches it, so walking a very long wrapped line past the cursor to
  // its end would repeat an O(line) scan per candidate match for nothing.
  // Cap the walk at `REFLOW_ANCHOR_CURSOR_LINE_WALK_ROWS` physical rows: a
  // multi-megabyte cursor line puts the cursor tens of thousands of wrapped
  // rows below `contextRow`, and every column-changing fit re-runs the walk
  // for each candidate follower match. Returning `undefined` says the answer
  // is unknown — the caller declines the cursor-line tolerance instead of
  // paying the unbounded walk; a context line that ends (or reaches the
  // cursor) within the cap still gets the exact answer.
  let contextEnd = contextRow;
  while (
    contextEnd < cursorRow
    && contextEnd + 1 < buffer.length
    && buffer.getLine(contextEnd + 1)?.isWrapped
  ) {
    if (contextEnd - contextRow >= REFLOW_ANCHOR_CURSOR_LINE_WALK_ROWS) return undefined;
    contextEnd += 1;
  }
  return cursorRow <= contextEnd;
};

/**
 * Whether the logical line containing `viewportRow` also contains the cursor
 * row (`baseY + cursorY`).
 *
 * The viewport row is already known to sit inside the anchored line (the
 * capture walk reached it from the line's start), so the line contains the
 * cursor exactly when every row from the viewport down to the cursor is
 * wrapped. Past `REFLOW_ANCHOR_CURSOR_LINE_WALK_ROWS` physical rows the walk
 * is declined and the answer is reported as `false` — the same degradation
 * `reflowAnchorContextIsCursorLine` applies — because the caller uses this
 * to decide whether a viewport-row marker may be trusted as a restore
 * position, and an unverifiable line must not gain that trust (see
 * `TerminalReflowScrollAnchor.containsCursor`).
 */
const reflowAnchorLineContainsCursor = (
  buffer: ReflowAnchorBuffer,
  viewportRow: number,
): boolean => {
  const cursorY = buffer.cursorY;
  if (typeof cursorY !== "number" || !Number.isFinite(cursorY)) return false;
  const cursorRow = buffer.baseY + cursorY;
  if (cursorRow < viewportRow) return false;
  for (let row = viewportRow; row < cursorRow; row += 1) {
    if (row - viewportRow >= REFLOW_ANCHOR_CURSOR_LINE_WALK_ROWS) return false;
    if (buffer.getLine(row + 1)?.isWrapped !== true) return false;
  }
  return true;
};

/**
 * Whether the logical line starting at `contextRow` validates the anchor's
 * captured follower identity.
 *
 * The strict check compares the captured `contextSuffix` text. The
 * cursor-line tolerance (see `reflowAnchorContextIsCursorLine`) relaxes it
 * only for a follower that was truncated rather than rewrapped — and that
 * truncation removes trailing characters, so the surviving follower text must
 * be a prefix of the captured text. Requiring the prefix keeps the tolerance
 * from validating an unrelated duplicate of the anchored text that merely
 * happens to sit before the cursor line: its follower does not continue the
 * captured identity at all and stays rejected, while the candidate the
 * captured suffix was actually taken from still matches.
 */
const reflowAnchorFollowerMatches = (
  buffer: ReflowAnchorBuffer,
  contextRow: number,
  anchor: TerminalReflowScrollAnchor,
): boolean => {
  if (anchor.contextSuffix === null) return false;
  const text = reflowAnchorJoinTextPrefix(buffer, contextRow, REFLOW_ANCHOR_CONTEXT_CHARS);
  if (text === anchor.contextSuffix) return true;
  // The tolerance also declines when the containment walk exceeds its bound
  // (`undefined`): only the strict check above applies then, and the resolve
  // falls back to the plain row restore like any other unmatched anchor.
  if (text.length === 0 || reflowAnchorContextIsCursorLine(buffer, contextRow) !== true) {
    return false;
  }
  return anchor.contextSuffix.startsWith(text)
    || reflowAnchorTruncatedCursorRowsMatch(buffer, contextRow, anchor);
};

/**
 * Whether the cursor line's surviving physical rows account for the captured
 * follower text.
 *
 * The prefix tolerance only holds for a cursor line that occupies a single
 * physical row: truncation removes a tail, so the surviving joined text stays
 * a prefix of the captured one. A multi-row cursor line is truncated row by
 * row — every row keeps its leading characters while its tail past the new
 * column count vanishes between the rows — so the joined surviving text is no
 * longer a prefix of the captured one (`ABCDEFGHIJ` + `KLMNOPQRST` truncates
 * to `ABCDEFGH` + `KLMNOPQR`). Verify the rows individually instead, against
 * the captured row boundaries (`contextRowTexts`): the surviving row at each
 * captured position must be a prefix of the row captured there, because its
 * own truncation removes only its tail. A column grow is the one exception:
 * it does not reflow the cursor line but null-pads its rows, so the surviving
 * row can also extend the captured row by trailing null cells (verified by
 * cell code, since the padding renders as ordinary blanks). Without the
 * captured boundaries the
 * per-row identity cannot be verified — matching each row anywhere in the
 * captured text would let arbitrary gaps between the rows pass, so a
 * duplicate's wrapped prompt whose rows merely appear as ordered substrings
 * of the captured follower could validate it — and the tolerance declines.
 * The final captured row is the exception in both directions: the capture cap
 * may have cut it short mid-row, so the surviving row and the captured row
 * are both prefixes of the same original row and the shorter one must be a
 * prefix of the longer. Rows past the captured ones are unbounded (the
 * captured suffix is a bounded prefix of the old line) and go unverified.
 */
/**
 * Cell column of `line` where its first `charCount` characters — as counted
 * by `reflowAnchorRowText` — end, or undefined when the mapping cannot be
 * verified from the cells.
 *
 * A JavaScript string length is not a cell column: a double-width glyph
 * occupies two cells while contributing one or two characters (a CJK BMP
 * glyph is a single code unit, an emoji is a surrogate pair), and combining
 * marks ride in their base cell. Walking the cells mirrors
 * `translateToString`: a width-0 continuation cell contributes nothing (its
 * glyph was counted by the wide cell before it), a null cell (codepoint 0)
 * renders as exactly one blank, and any other cell contributes its string —
 * base plus combining marks. Cells without `getString` (hand-built test
 * buffers) count as one character each, which keeps ASCII-only test rows
 * aligned. An undefined result also covers a character count that falls
 * between cell boundaries, which real translations never produce.
 */
const reflowAnchorPrefixCellLength = (
  line: ReflowAnchorBufferLine,
  charCount: number,
): number | undefined => {
  const lineLength = typeof line.length === "number" ? line.length : undefined;
  if (!line.getCell || lineLength === undefined) return undefined;
  let column = 0;
  let chars = 0;
  while (chars < charCount && column < lineLength) {
    const cell = line.getCell(column);
    if (!cell) return undefined;
    const width = cell.getWidth?.() ?? 1;
    if (width <= 0) {
      // Second cell of a wide glyph: it contributes no characters of its own.
      column += 1;
      continue;
    }
    chars += cell.getCode() === 0 ? 1 : cell.getString?.().length || 1;
    column += width;
  }
  return chars === charCount ? column : undefined;
};

/**
 * Whether every cell of the physical row at `row` past `prefixLength` is null
 * (codepoint 0): the padding xterm adds when columns grow.
 *
 * `prefixLength` is a cell column, not a string offset — derive it with
 * `reflowAnchorPrefixCellLength` when only the character count of the prefix
 * is known (see the column-grow tolerance in
 * `reflowAnchorTruncatedCursorRowsMatch`).
 *
 * A column grow skips reflowing the cursor line entirely (`reflowCursorLine`
 * stays false) but expands each of its physical rows to the new column count
 * with null cells. `reflowAnchorRowText` keeps that padding on a non-final
 * wrapped row — its trailing-null trim runs only on the line's final row — so
 * the surviving `rowText` renders longer than the captured row even though no
 * character was added. Null cells render as ordinary blanks in
 * `translateToString`, so the padding cannot be recognized from the row text
 * alone; the cell codes are the only witness. Without them a false accept
 * would need surviving real content beyond the captured prefix, which neither
 * truncation nor grow padding produces — extra written characters are
 * rejected because they carry a non-zero codepoint. Hand-built rows without
 * cell access keep the strict one-directional check.
 */
const reflowAnchorRowEndsInNullPadding = (
  buffer: ReflowAnchorBuffer,
  row: number,
  prefixLength: number,
): boolean => {
  const line = buffer.getLine(row);
  const lineLength = typeof line?.length === "number" ? line.length : undefined;
  if (!line || lineLength === undefined || !line.getCell) return false;
  for (let x = prefixLength; x < lineLength; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getCode() !== 0) return false;
  }
  return true;
};

const reflowAnchorTruncatedCursorRowsMatch = (
  buffer: ReflowAnchorBuffer,
  contextRow: number,
  anchor: TerminalReflowScrollAnchor,
): boolean => {
  const capturedRows = anchor.contextRowTexts;
  if (!capturedRows) return false;
  let row = contextRow;
  for (let i = 0; i < capturedRows.length; i += 1) {
    const line = buffer.getLine(row);
    if (row >= buffer.length || !line) return false;
    // The captured rows beyond the first were continuation rows: the
    // surviving line must still wrap at every captured boundary, or its rows
    // no longer line up with the captured ones.
    if (i > 0 && line.isWrapped !== true) return false;
    const captured = capturedRows[i];
    if (captured !== "") {
      const rowText = reflowAnchorRowText(buffer, row);
      const last = i === capturedRows.length - 1;
      // A column grow pads the cursor line's rows with null cells instead of
      // reflowing them, so a non-final surviving row can also be the captured
      // row plus trailing null padding (`reflowAnchorRowText` keeps that
      // padding on non-final wrapped rows). Accept it only when the extra
      // characters are verifiably null cells — extra written content must
      // still be rejected, so the string prefix alone is not enough. The
      // captured row's length is a character count, not a cell column (wide
      // glyphs span two cells), so the padding check starts at the cell the
      // captured prefix actually ends on.
      const capturedEndCell = reflowAnchorPrefixCellLength(line, captured.length);
      const paddedBeyondCaptured = rowText.length > captured.length
        && rowText.startsWith(captured)
        && capturedEndCell !== undefined
        && reflowAnchorRowEndsInNullPadding(buffer, row, capturedEndCell);
      if (last
        ? !rowText.startsWith(captured) && !captured.startsWith(rowText)
        : !captured.startsWith(rowText) && !paddedBeyondCaptured
      ) {
        return false;
      }
    }
    row += 1;
  }
  return true;
};

/**
 * True when the logical line at `row` matches the anchor's captured identity.
 *
 * When the capture dropped the follower identity at its character bound
 * (`contextDropped`), the resolve side must not demand a follower-less line:
 * the bound counts the anchored line's own characters, which a scrollback
 * trim shrinks, so the surviving line can present a follower the capture was
 * over the bound for. The anchor then degrades to its text-only identity —
 * the same degradation the bound applies when both sides drop the follower —
 * rather than rejecting the otherwise matching line and falling back to the
 * stale row.
 */
const reflowAnchorCandidateMatches = (
  buffer: ReflowAnchorBuffer,
  row: number,
  anchor: TerminalReflowScrollAnchor,
): boolean => {
  if (reflowAnchorJoinTextPrefix(buffer, row, REFLOW_ANCHOR_TEXT_PREFIX_CHARS) !== anchor.textPrefix) {
    return false;
  }
  const context = reflowAnchorNextNonBlankLogicalLineStart(buffer, row);
  if (anchor.contextSuffix === null) {
    return anchor.contextDropped === true || context.start === null;
  }
  return context.start !== null && reflowAnchorFollowerMatches(buffer, context.start, anchor);
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
 * hand-built test anchors — keeps the plain offset. The row-0 line being the
 * cursor's own logical line is the other exception: a narrowing resize
 * truncates that line's rows instead of trimming its start, so the length
 * loss is not a leading trim and the derivation declines (see the guard
 * below).
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
  // A narrowing resize with the pinned `reflowCursorLine: false` default does
  // not rewrap the cursor's logical line: it truncates the right side of every
  // physical row instead. That length loss removes characters from within the
  // line, not from its start, so treating it as a leading trim would shift the
  // offset to an earlier, wrong position — which repetitive content then
  // validates. The line's physical rows keep their indices, so decline the
  // derivation and let the caller fall back to the surviving viewport-row
  // marker (or the unchanged saved index), both of which still point at the
  // viewed row. A containment walk past its bound (`undefined`) also declines:
  // the line may be the truncated cursor line and the derivation would treat
  // its truncation as a leading trim.
  if (trimChars > 0 && reflowAnchorContextIsCursorLine(buffer, row) !== false) return -1;
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
  // A follower the capture dropped at its character bound (`contextDropped`)
  // stays unidentified here too: the bound counts the anchored line's own
  // characters, which a scrollback trim shrinks, so the surviving line can
  // present a follower the capture was over the bound for. Treat it as the
  // capture did — unidentified, not absent — and keep resolving through the
  // viewed text instead of rejecting the line outright.
  const context = reflowAnchorNextNonBlankLogicalLineStart(buffer, row);
  if (anchor.contextSuffix === null) {
    if (context.start !== null && anchor.contextDropped !== true) return -1;
  } else if (context.start === null || !reflowAnchorFollowerMatches(buffer, context.start, anchor)) {
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
  // When the marker constrains the search to one containing logical line,
  // evaluate that row directly: a scan outward from a marker deep inside a
  // long wrapped line would walk one physical row per distance just to reach
  // the line's start, and a failing primary pass would sweep the whole buffer
  // before the continuation pass could run.
  const resolveRow = (row: number): number | null => {
    const primary = primaryRow(row);
    if (primary >= 0) return reflowOffsetTargetRow(buffer, row, primary);
    if (!trackContinuation) return null;
    const continuation = reflowAnchorContinuationOffset(buffer, row, anchor);
    if (continuation < 0) return null;
    return reflowOffsetTargetRow(buffer, row, continuation);
  };
  const resolveFrom = (from: number, onlyRow?: number): number | null => {
    if (onlyRow !== undefined) return resolveRow(onlyRow);
    const primary = reflowScanOutward(buffer, anchor, from, (row) =>
      primaryRow(row));
    if (primary !== null) return primary;
    if (!trackContinuation) return null;
    return reflowScanOutward(buffer, anchor, from, (row) =>
      reflowAnchorContinuationOffset(buffer, row, anchor));
  };
  // A surviving marker is pinned to the viewed row or to the anchored
  // logical line's start, so it lives inside that line. In the continuation
  // case the marker can sit deep inside a long wrapped line, where a
  // repeating line/follower block below it is closer to the marker than the
  // original line's start is; a proximity scan seeded from the marker would
  // then jump into the duplicate even though the fallback from the stale
  // `anchor.startRow` selects the original. Constrain the seeded scan to the
  // marker's containing line, falling through to the stale-row scan when
  // that line no longer matches — or when the walk back to its start exceeds
  // `REFLOW_ANCHOR_MARKER_LINE_WALK_ROWS` (a large column shrink can push the
  // marker that deep into the reflowed line): skipping the seeded path avoids
  // re-walking the same continuation rows in an unconstrained scan that could
  // jump into a duplicate. The marker row may also numerically equal
  // the stale `anchor.startRow` — when the rewrap above the anchor removed
  // exactly as many wrapped rows as the viewport spans — while still sitting
  // inside the relocated line, so the seeded path must run for equal rows
  // too whenever a containing line was resolved.
  const seededLine = seedRow !== null && trackContinuation
    ? reflowAnchorLogicalLineStart(buffer, seedRow, REFLOW_ANCHOR_MARKER_LINE_WALK_ROWS)
    : undefined;
  if (seedRow !== null && trackContinuation && seededLine === undefined) {
    // The marker sits beyond `REFLOW_ANCHOR_MARKER_LINE_WALK_ROWS` rows into
    // its rewrapped line (a large column shrink). The stale-row fallback below
    // would still be unbounded for this case: after matching the line from the
    // stale start, `reflowOffsetTargetRow` walks one physical row per
    // `newCols` characters up to the captured offset — up to the same
    // continuation depth the bound just declined to visit, repeated on every
    // divider-drag frame. The surviving viewport-row marker is the O(1)
    // destination instead: xterm adjusted its row through the rewrap (and
    // would have disposed it if its row were trimmed), so it already marks the
    // row holding the viewed characters. This is the same marker metadata the
    // cursor-line branch below trusts; only the expensive re-derivation is
    // skipped.
    return Math.min(seedRow, buffer.baseY);
  }
  if (
    seedRow !== null
    && (seededLine !== undefined
      // No continuation tracking means no containing-line walk ran, so the
      // pre-bound behavior — an unconstrained scan seeded from a marker that
      // differs from the stale row — is kept as-is.
      || (!trackContinuation && seedRow !== anchor.startRow))
  ) {
    const seeded = resolveFrom(seedRow, seededLine);
    if (seeded !== null) {
      // A column change never rewraps the cursor's own logical line (the
      // pinned `reflowCursorLine: false` default): it truncates or null-pads
      // each physical row in place, keeping every row index while changing
      // the row lengths that the offset-to-row mapping walks. The scanned
      // result therefore translates the captured in-line offsets through the
      // changed row lengths and lands past (narrowing) or before (growing)
      // the viewed row — and a viewport partway into the line always spans
      // changed rows, since every non-final row of a wrapped line is exactly
      // the old column count long. When the surviving viewport-row marker
      // sits inside that line, it marks the viewed row itself, whose index
      // truncation and padding leave unchanged — keep it instead of letting
      // the scanned result override it. A marker at the line's start
      // (`seedRow === seededLine`) is the line-start marker, which only
      // seeds the scan and must not stand in for the result.
      if (
        trackContinuation
        && seededLine !== undefined
        && seedRow !== seededLine
        // The marker is also kept when the containment walk exceeds its bound
        // (`undefined`): the line may be the truncated cursor line, whose
        // changed row lengths the scanned offset mapping cannot traverse.
        && reflowAnchorContextIsCursorLine(buffer, seededLine) !== false
      ) {
        return Math.min(seedRow, buffer.baseY);
      }
      return seeded;
    }
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
  return reflowOffsetTargetRow(buffer, bestRow, bestOffset);
}

/**
 * Row that ends up at the viewport top when `row` is the anchored logical
 * line and `offset` characters of it are above the viewport. Rewrap moves the
 * captured characters to a different row offset within the logical line; walk
 * the (new) row boundaries to the row holding them. Use the same per-row text
 * as the capture so real trailing spaces on wrapped rows are counted
 * identically on both sides.
 */
const reflowOffsetTargetRow = (
  buffer: ReflowAnchorBuffer,
  row: number,
  offset: number,
): number => {
  let targetRow = row;
  let remaining = offset;
  while (remaining > 0) {
    if (!buffer.getLine(targetRow) || !buffer.getLine(targetRow + 1)?.isWrapped) break;
    const rowLength = reflowAnchorRowText(buffer, targetRow).length;
    if (remaining < rowLength) break;
    remaining -= rowLength;
    targetRow += 1;
  }
  return Math.min(targetRow, buffer.baseY);
};
