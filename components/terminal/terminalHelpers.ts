import type { DragEvent, PointerEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";

import type { TerminalContextReader } from "../../domain/terminalContextRead";
import { resolveSessionTabTitle } from "../../domain/sessionTabTitle";
import { logger } from "../../lib/logger";
import { getPathForFile, type DropEntry } from "../../lib/sftpFileUtils";
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

export const MAX_CONNECTION_LOG_DATA_CHARS = 1_000_000;
export const AUTO_RUN_SNIPPET_LINE_DELAY_MS = 250;

export interface TerminalBroadcastInputOptions {
  noAutoRun?: boolean;
  lineDelayMs?: number;
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
    if (!entry.file) continue;

    const fullPath = getPathForFile(entry.file);
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
  chainHosts?: Host[];
  appearanceTheme?: TerminalTheme;
  knownHosts?: KnownHost[];
  isVisible: boolean;
  /** Changes when split-pane bounds update; triggers xterm refit after tab switches. */
  paneLayoutKey?: string;
  inWorkspace?: boolean;
  isResizing?: boolean;
  isFocusMode?: boolean;
  isFocused?: boolean;
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
  onSessionExit?: (sessionId: string, evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onUpdateHost?: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onExpandToFocus?: () => void;
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
  ) => void;
  onSnippetExecutorChange?: (
    sessionId: string,
    executor: ((
      command: string,
      noAutoRun?: boolean,
      options?: { broadcast?: boolean; multiLineRunMode?: Snippet["multiLineRunMode"] },
    ) => void) | null,
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
  hideConnectingDialogForConnectionReuse,
}: {
  status: TerminalSession["status"];
  isLocalConnection: boolean;
  isSerialConnection: boolean;
  isDisconnectedDialogDismissed: boolean;
  hideConnectingDialogForConnectionReuse?: boolean;
}): boolean {
  return status !== "connected"
    && !(!!hideConnectingDialogForConnectionReuse && status === "connecting")
    && !((isLocalConnection || isSerialConnection) && status === "connecting")
    && !(status === "disconnected" && isDisconnectedDialogDismissed);
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
