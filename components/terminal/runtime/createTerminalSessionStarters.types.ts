import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type { Host, Identity, KnownHost, SerialConfig, SSHKey, TerminalSession, TerminalSettings } from "../../../types";
import type { PromptLineBreakState } from "./promptLineBreak";
import type {
  PasswordPromptPickerState,
  SudoPasswordAutofill,
  SudoPasswordAutofillCandidate,
} from "./terminalSudoAutofill";
import type { ProgrammaticCommandLogRewrite } from "../programmaticCommandLog";
import type { TerminalSessionExitEvent } from "../../../application/state/resolveTerminalSessionExitIntent";

export type TerminalBackendApi = {
  backendAvailable: () => boolean;
  telnetAvailable: () => boolean;
  moshAvailable: () => boolean;
  etAvailable: () => boolean;
  localAvailable: () => boolean;
  serialAvailable: () => boolean;
  pluginConnectionAvailable: () => boolean;
  execAvailable: () => boolean;
  startSSHSession: (options: NetcattySSHOptions) => Promise<string>;
  startTelnetSession: (
    options: Parameters<NonNullable<NetcattyBridge["startTelnetSession"]>>[0],
  ) => Promise<string>;
  startMoshSession: (
    options: Parameters<NonNullable<NetcattyBridge["startMoshSession"]>>[0],
  ) => Promise<string>;
  startEtSession: (
    options: Parameters<NonNullable<NetcattyBridge["startEtSession"]>>[0],
  ) => Promise<string>;
  startLocalSession: (
    options: Parameters<NonNullable<NetcattyBridge["startLocalSession"]>>[0],
  ) => Promise<string>;
  startSerialSession: (
    options: Parameters<NonNullable<NetcattyBridge["startSerialSession"]>>[0],
  ) => Promise<string>;
  startPluginConnection: (options: NetcattyPluginConnectionStartRequest & { signal?: AbortSignal }) => Promise<{
    sessionId: string;
    providerId: string;
    status: "connecting" | "connected";
    diagnostics: ReadonlyArray<import("@netcatty/plugin-contract").ProviderValidationIssue>;
  }>;
  cancelPluginExtensionRequest?: (requestId: string) => Promise<boolean> | boolean;
  signalPluginConnection?: (
    sessionId: string,
    signal?: "interrupt" | "terminate" | "kill" | "eof" | "break",
  ) => Promise<unknown>;
  execCommand: (options: Parameters<NetcattyBridge["execCommand"]>[0]) => Promise<{
    stdout?: string;
    stderr?: string;
  }>;
  getSessionRemoteInfo?: (sessionId: string) => Promise<{
    success: boolean;
    remoteSshVersion?: string;
    error?: string;
  }>;
  getSessionDistroInfo?: (sessionId: string) => Promise<{
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
  }>;
  onSessionData: (
    sessionId: string,
    cb: (data: string, meta?: TerminalSessionDataMeta) => void,
    options?: { replayBacklog?: boolean },
  ) => () => void;
  onSessionExit: (
    sessionId: string,
    cb: (evt: TerminalSessionExitEvent) => void,
  ) => () => void;
  onTelnetAutoLoginComplete?: (
    sessionId: string,
    cb: (evt: { sessionId: string; bootEpoch?: number }) => void,
  ) => (() => void) | undefined;
  onTelnetAutoLoginCancelled?: (
    sessionId: string,
    cb: (evt: { sessionId: string; bootEpoch?: number }) => void,
  ) => (() => void) | undefined;
  onMoshSessionReady?: (
    sessionId: string,
    cb: (evt: { sessionId: string; bootEpoch?: number }) => void,
  ) => (() => void) | undefined;
  onTelnetEchoMode?: (
    sessionId: string,
    cb: (evt: { sessionId: string; remoteEcho: boolean; localEcho: boolean }) => void,
  ) => (() => void) | undefined;
  getTelnetEchoMode?: (sessionId: string) => Promise<{
    success: boolean;
    sessionId?: string;
    remoteEcho?: boolean;
    localEcho?: boolean;
    error?: string;
  }>;
  onChainProgress: (
    cb: (sessionId: string, hop: number, total: number, label: string, status: string, error?: string) => void,
  ) => (() => void) | undefined;
  onConnectionReuseFallback?: (
    cb: (sessionId: string, sourceSessionId?: string) => void,
  ) => (() => void) | undefined;
  writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean; lineDelayMs?: number; logRewrite?: ProgrammaticCommandLogRewrite }) => void;
  interruptSession?: (sessionId: string, trace?: NetcattyTerminalInterruptTrace) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
  closeSession: (sessionId: string, options?: { bootEpoch?: number }) => void | Promise<void>;
  /** Pause/resume the source stream for output back-pressure (optional). */
  setSessionFlowPaused?: (sessionId: string, paused: boolean) => void;
  /** Acknowledge rendered terminal output bytes for main-process IPC back-pressure. */
  ackSessionFlow?: (sessionId: string, bytes: number) => void;
  notifyTerminalSessionDisplayReady?: (sessionId: string) => void;
};

export type PendingAuth = {
  authMethod: "password" | "key" | "certificate";
  username: string;
  password?: string;
  keyId?: string;
  passphrase?: string;
  savedToHost?: boolean;
} | null;

type ChainProgressState = {
  currentHop: number;
  totalHops: number;
  currentHostLabel: string;
  connectionPhase: string;
} | null;

export type SessionLogConfig = {
  enabled: boolean;
  directory: string;
  format: string;
  timestampsEnabled?: boolean;
};

export type TerminalSessionStartersContext = {
  host: Host & Pick<Partial<TerminalSession>, "localStartDir">;
  /**
   * Live host snapshot updated every render. Session data handlers close over
   * boot-time ctx, so mid-session host toggles (e.g. line timestamps) must be
   * read from this ref rather than the frozen `host` field.
   */
  hostRef?: RefObject<Host & Pick<Partial<TerminalSession>, "localStartDir">>;
  keys: SSHKey[];
  identities?: Identity[];
  knownHosts?: KnownHost[];
  resolvedChainHosts: Host[];
  sessionId: string;
  // One-shot source session intent for Copy/Split. Consumed by the first SSH
  // attempt so later reconnects do not skip the initial login sequence.
  reuseConnectionFromSessionIdRef?: MutableRefObject<string | undefined>;
  // Duplicate Session clones carry this marker for their whole lifetime: every
  // SSH attempt must send `reuseTransport: false` so the bridge never borrows
  // the source's live or any other pooled transport.
  requireFreshConnection?: boolean;
  // Set by the reconnect path (manual retry / auto-reconnect) for the rest of
  // the pane's lifetime: every SSH attempt must dial a brand-new connection
  // instead of borrowing a live or idle pooled transport. Reusing an
  // already-authenticated connection skips the server-side login, so remote
  // supplementary-group changes (e.g. `usermod -aG`) stay invisible until the
  // whole app quits (#3293).
  requireFreshConnectionOnReconnectRef?: MutableRefObject<boolean>;
  // Persists across renderer auth retries after the one-shot source intent is
  // consumed. Cleared only after a backend session starts successfully.
  reuseConnectionSourceAttemptedRef?: MutableRefObject<boolean>;
  // Mirrors the source actually consumed by the current SSH attempt so the UI
  // only hides its connecting dialog while Copy/Split reuse is being tried.
  setConnectionReuseAttemptSourceId?: (sourceSessionId: string | undefined) => void;
  // Connect automation and still-unhandled pending scripts need the initial
  // login output. Evaluate per attempt because pending work is one-shot.
  shouldUseFreshSshConnection?: () => boolean;
  // Commit the no-automation snapshot only after the corresponding backend
  // session actually starts, so failed auth attempts do not consume scripts.
  onConnectAutomationSnapshotCommitted?: () => void;
  isNetworkDevice?: boolean;
  startupCommand?: string;
  noAutoRun?: boolean;
  multiLineRunMode?: TerminalSession["multiLineRunMode"];
  shellType?: TerminalSession["shellType"];
  suppressHostStartupCommandRef?: RefObject<boolean>;
  terminalSettings?: TerminalSettings;
  terminalSettingsRef?: RefObject<TerminalSettings | undefined>;
  terminalBackend: TerminalBackendApi;
  serialConfig?: SerialConfig;
  telnetLocalEchoRef?: RefObject<boolean>;
  sessionLog?: SessionLogConfig;
  sshDebugLogEnabled?: boolean;
  sudoAutofillPassword?: string;
  sudoAutofillPasswordRef?: RefObject<string | undefined>;
  sudoAutofillCandidates?: SudoPasswordAutofillCandidate[];
  sudoAutofillCandidatesRef?: RefObject<SudoPasswordAutofillCandidate[] | undefined>;
  onSudoHint?: (active: boolean) => boolean;
  onPasswordPromptPicker?: (
    active: boolean,
    state: PasswordPromptPickerState | null,
  ) => boolean;
  /** Actual tab/pane visibility; the renderer may remain active while hidden. */
  isPaneVisibleRef?: RefObject<boolean>;
  isVisibleRef?: RefObject<boolean>;
  /** False after unmount/teardown so in-flight session starts skip attach. */
  isBootActiveRef?: RefObject<boolean>;
  /**
   * Monotonic boot epoch. Disconnect / a newer reconnect bumps this so an
   * older in-flight start cannot become current again when boot is re-armed.
   */
  bootEpochRef?: RefObject<number>;
  pendingOutputScrollRef?: RefObject<boolean>;

  sessionRef: RefObject<string | null>;
  hasConnectedRef: RefObject<boolean>;
  hasRunStartupCommandRef: RefObject<boolean>;
  disposeDataRef: RefObject<(() => void) | null>;
  disposeExitRef: RefObject<(() => void) | null>;
  /**
   * Track an async cleanup (e.g. cancelled plugin start → finishExternalSession)
   * so Disconnect/Reconnect can await it before starting a replacement boot.
   */
  trackSessionCleanup?: (promise: Promise<unknown>) => void;
  disposeTelnetEchoModeRef?: RefObject<(() => void) | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  serializeAddonRef: RefObject<SerializeAddon | null>;
  prepareKeywordHighlightSerialization?: () => Promise<void>;
  pendingAuthRef: RefObject<PendingAuth>;
  promptLineBreakStateRef?: RefObject<PromptLineBreakState>;
  sudoAutofillRef?: RefObject<SudoPasswordAutofill | null>;
  restoreCwdIntentRef?: RefObject<{ cwd: string; command: string } | null>;

  updateStatus: (next: TerminalSession["status"]) => void;
  setStatus: Dispatch<SetStateAction<TerminalSession["status"]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNeedsAuth: Dispatch<SetStateAction<boolean>>;
  setAuthRetryMessage: Dispatch<SetStateAction<string | null>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setProgressLogs: Dispatch<SetStateAction<string[]>>;
  setProgressValue: Dispatch<SetStateAction<number>>;
  setChainProgress: Dispatch<SetStateAction<ChainProgressState>>;
  setIsConnectionAwaitingUserInput?: Dispatch<SetStateAction<boolean>>;
  setIsConnectionPastTcpDial?: Dispatch<SetStateAction<boolean>>;
  t?: (key: string) => string;

  onSessionAttached?: (sessionId: string) => void;
  onRestoreCwdIntentConsumed?: (cwd: string) => void;
  onSessionExit?: (sessionId: string, evt: TerminalSessionExitEvent) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onTerminalLogData?: (data: string) => void;
  onProgrammaticCommandLogRewrite?: (rewrite: ProgrammaticCommandLogRewrite) => void;
  onTerminalOutput?: (chunk: string, meta?: TerminalSessionDataMeta) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
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
  onCommandCompleted?: () => void;
};

export type TerminalSessionDataMeta = {
  droppedOutputMayAffectTerminalState?: boolean;
  droppedOutputAlternateScreenAction?: 'enter' | 'leave';
  /** True while Mosh is still on the ephemeral SSH handshake PTY. */
  moshHandshake?: boolean;
  /** The Mosh SSH bootstrap is blocked on input that Netcatty cannot answer automatically. */
  moshHandshakeRequiresUserInput?: boolean;
  terminalPerf?: NetcattyTerminalOutputPerfMeta;
  /** Original host output units acknowledged even when an interceptor changes display length. */
  pluginPipelineIngressBytes?: number;
  /** Host-owned provenance marker for output already processed by an interceptor. */
  pluginPipelineProcessed?: boolean;
  /** Host-owned classification from original output; plugins cannot mask it. */
  pluginPipelineSensitiveInput?: boolean;
  /** Host-owned marker that a Plugin connection Provider has explicitly reached connected status. */
  pluginConnectionReady?: boolean;
};
