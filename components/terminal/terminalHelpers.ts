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
    sourceSessionId?: string,
  ) => void;
  onTerminalCwdChange?: (sessionId: string, cwd: string | null, meta?: { source?: 'osc7' }) => void;
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
