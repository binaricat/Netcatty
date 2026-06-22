import type { DragEvent, PointerEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";

import { classifyDistroId } from "../../domain/host";
import { logger } from "../../lib/logger";
import { getPathForFile, type DropEntry } from "../../lib/sftpFileUtils";
import { normalizeLineEndings } from "../../lib/utils";
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

export interface TerminalBroadcastInputOptions {
  protectTerminalMode?: boolean;
  rawCommand?: string;
  fallbackData?: string;
  noAutoRun?: boolean;
}

/**
 * Get the display name for a terminal session.
 * Uses customName if set, otherwise falls back to hostLabel.
 */
export function getSessionDisplayName(session: TerminalSession): string {
  return session.customName || session.hostLabel || '';
}

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
  themePreviewId?: string;
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
  restoreState?: TerminalSession["restoreState"];
  shellType?: TerminalSession["shellType"];
  lastCwd?: string;
  restoreTerminalCwd?: boolean;
  startupCommand?: string;
  noAutoRun?: boolean;
  protectStartupCommandTerminalMode?: boolean;
  // When this tab was created from a connected SSH session, the id of the
  // source session whose authenticated connection should be reused for a new
  // shell channel — skipping a second MFA prompt (issue #1204).
  reuseConnectionFromSessionId?: string;
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
  onTerminalCwdChange?: (sessionId: string, cwd: string | null) => void;
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
      options?: { broadcast?: boolean; protectTerminalMode?: boolean },
    ) => void) | null,
  ) => void;
  sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
  sshDebugLogEnabled?: boolean;
  sudoAutofillPassword?: string;
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

type SnippetRestoreHost = Pick<Host, "protocol" | "deviceType" | "distro" | "os">;

function shouldUseSnippetRestoreShell(shellType?: TerminalSession["shellType"]): boolean {
  return shellType === undefined || shellType === "posix";
}

function shouldRestoreTerminalModeAfterSnippet({
  host,
  noAutoRun,
  shellType,
}: {
  host: SnippetRestoreHost;
  noAutoRun?: boolean;
  shellType?: TerminalSession["shellType"];
}): boolean {
  if (noAutoRun) return false;
  if (!shouldUseSnippetRestoreShell(shellType)) return false;
  const protocol = host.protocol ?? "ssh";
  if (protocol !== "ssh") return false;

  const detectedDeviceClass = classifyDistroId(host.distro);
  if (host.deviceType === "network" || detectedDeviceClass === "network-device") return false;

  return host.os === "macos" || detectedDeviceClass === "linux-like";
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function hasMultipleCommandLines(command: string): boolean {
  return command.includes("\n") || command.includes("\r");
}

function doubleQuoteFishAndPosix(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

function buildPosixSnippetRestoreCommand(encodedCommand: string): string {
  return [
    "__netcatty_stty_state=\"$(stty -g 2>/dev/null || true)\"",
    "__netcatty_restore(){ if [ -n \"$__netcatty_stty_state\" ]; then stty \"$__netcatty_stty_state\" 2>/dev/null || stty sane 2>/dev/null || true; else stty sane 2>/dev/null || true; fi; }",
    "trap __netcatty_restore INT TERM EXIT",
    `__netcatty_cmd_b64='${encodedCommand}'`,
    "__netcatty_cmd=\"$(printf %s \"$__netcatty_cmd_b64\" | base64 -d 2>/dev/null || printf %s \"$__netcatty_cmd_b64\" | base64 -D 2>/dev/null)\"",
    "__netcatty_decode_status=$?",
    "if [ \"$__netcatty_decode_status\" -eq 0 ]; then eval \"$__netcatty_cmd\"; __netcatty_status=$?; else printf '%s\\n' 'Netcatty: failed to decode protected snippet command' >&2; __netcatty_status=127; fi",
    "__netcatty_restore",
    "trap - INT TERM EXIT",
    "unset __netcatty_stty_state __netcatty_cmd_b64 __netcatty_cmd __netcatty_decode_status",
    "unset -f __netcatty_restore 2>/dev/null || true",
    "( exit $__netcatty_status )",
  ].join("; ");
}

function buildPortableCurrentShellSnippetRestoreCommand(command: string): string | null {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tempDir = `/tmp/.netcatty-${suffix}`;
  const encodedCommand = encodeUtf8Base64(command);
  const createTempDir = `sh -c 'mkdir -m 700 ${tempDir} 2>/dev/null || exit 1'`;
  const safeTempDirCheck = "dir=$1; parent=${dir%/*}; base=${dir##*/}; parent_real=$(cd -P \"$parent\" 2>/dev/null && pwd -P) && expected=$parent_real/$base && cd -P \"$dir\" 2>/dev/null && actual=$(pwd -P) && test \"$actual\" = \"$expected\"";
  const saveState = `sh -c '${safeTempDirCheck} || exit 1; stty -g > stty 2>/dev/null || true' sh ${tempDir}`;
  const restoreState = `sh -c '${safeTempDirCheck} || { stty sane 2>/dev/null || true; exit 0; }; xargs stty < stty 2>/dev/null || stty sane 2>/dev/null || true; rm -f stty' sh ${tempDir}`;
  const trapCleanup = `sh -c '${safeTempDirCheck} || { stty sane 2>/dev/null || true; exit 0; }; xargs stty < stty 2>/dev/null || stty sane 2>/dev/null || true; rm -f stty status; cd /; rmdir "$1" 2>/dev/null || true' sh ${tempDir}`;
  const writeStatus = `sh -c '${safeTempDirCheck} || exit 1; printf %s "$2" > status' sh ${tempDir}`;
  const statusGuard = `sh -c '${safeTempDirCheck} || exit 1; test -f status' sh ${tempDir}`;
  const exitWithStatus = `sh -c '${safeTempDirCheck} || exit 1; code=$(cat status 2>/dev/null || printf 1); rm -f status; cd /; rmdir "$1" 2>/dev/null || true; exit "$code"' sh ${tempDir}`;
  const fishRunner = [
    `set __netcatty_cmd (printf %s '${encodedCommand}' | base64 -d 2>/dev/null; or printf %s '${encodedCommand}' | base64 -D 2>/dev/null)`,
    "set __netcatty_decode_status $status",
    "if test $__netcatty_decode_status -eq 0",
    "eval $__netcatty_cmd",
    "set __netcatty_status $status",
    "else",
    "printf '%s\\n' 'Netcatty: failed to decode protected snippet command' >&2",
    "set __netcatty_status 127",
    "end",
    `${writeStatus} "$__netcatty_status"`,
    "set -e __netcatty_cmd __netcatty_decode_status __netcatty_status",
    "true",
  ].join("; ");
  const posixRunner = [
    `__netcatty_cmd="$(printf %s '${encodedCommand}' | base64 -d 2>/dev/null || printf %s '${encodedCommand}' | base64 -D 2>/dev/null)"`,
    "__netcatty_decode_status=$?",
    "if [ \"$__netcatty_decode_status\" -eq 0 ]; then eval \"$__netcatty_cmd\"; __netcatty_status=$?; else printf '%s\\n' 'Netcatty: failed to decode protected snippet command' >&2; __netcatty_status=127; fi",
    `${writeStatus} "$__netcatty_status"`,
    "unset __netcatty_cmd __netcatty_decode_status __netcatty_status",
    "true",
  ].join("; ");
  const tempDirGuard = `sh -c '${safeTempDirCheck}' sh ${tempDir}`;
  const runFailure = [
    "printf '%s\\n' 'Netcatty: failed to create private temp directory' >&2",
    "false",
  ].join("; ");
  const runInCurrentShell = [
    `${tempDirGuard} && sh -c 'test -n "$1"' sh "$FISH_VERSION" && eval ${doubleQuoteFishAndPosix(fishRunner)}`,
    `${tempDirGuard} && sh -c 'test -z "$1"' sh "$FISH_VERSION" && eval ${doubleQuoteFishAndPosix(posixRunner)}`,
    `${statusGuard} || eval ${doubleQuoteFishAndPosix(runFailure)}`,
  ].join(" || ");

  return [
    createTempDir,
    saveState,
    `trap ${doubleQuoteFishAndPosix(trapCleanup)} INT TERM EXIT`,
    `eval ${doubleQuoteFishAndPosix(runInCurrentShell)}`,
    restoreState,
    "trap - INT TERM EXIT",
    exitWithStatus,
  ].join(" && ");
}

export function prepareAutoRunSnippetCommand(
  command: string,
  opts: {
    host: SnippetRestoreHost;
    noAutoRun?: boolean;
    shellType?: TerminalSession["shellType"];
  },
): string {
  const rawCommand = String(command ?? "");
  if (!shouldRestoreTerminalModeAfterSnippet(opts)) {
    return rawCommand;
  }
  if (hasMultipleCommandLines(rawCommand)) {
    return rawCommand;
  }

  const encodedCommand = encodeUtf8Base64(rawCommand);
  return opts.shellType === undefined
    ? (buildPortableCurrentShellSnippetRestoreCommand(rawCommand) ?? rawCommand)
    : buildPosixSnippetRestoreCommand(encodedCommand);
}

export function prepareProtectedBroadcastSnippetData({
  rawCommand,
  fallbackData,
  host,
  noAutoRun,
  shellType,
}: {
  rawCommand: string;
  fallbackData: string;
  host: SnippetRestoreHost;
  noAutoRun?: boolean;
  shellType?: TerminalSession["shellType"];
}): string {
  const prepared = prepareAutoRunSnippetCommand(rawCommand, { host, noAutoRun, shellType });
  if (prepared === String(rawCommand ?? "")) {
    return fallbackData;
  }
  let data = normalizeLineEndings(prepared);
  if (!noAutoRun) data = `${data}\r`;
  return data;
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
