import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Host, Identity, KnownHost, SerialConfig, SSHKey, TerminalSession, TerminalSettings } from "../../../types";
import type { PromptLineBreakState } from "./promptLineBreak";
import type {
  PasswordPromptPickerState,
  SudoPasswordAutofill,
  SudoPasswordAutofillCandidate,
} from "./terminalSudoAutofill";
import type { ProgrammaticCommandLogRewrite } from "../programmaticCommandLog";

export type TerminalBackendApi = {
  backendAvailable: () => boolean;
  telnetAvailable: () => boolean;
  moshAvailable: () => boolean;
  etAvailable: () => boolean;
  localAvailable: () => boolean;
  serialAvailable: () => boolean;
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
    cb: (evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void,
  ) => () => void;
  onTelnetAutoLoginComplete?: (
    sessionId: string,
    cb: (evt: { sessionId: string }) => void,
  ) => (() => void) | undefined;
  onTelnetAutoLoginCancelled?: (
    sessionId: string,
    cb: (evt: { sessionId: string }) => void,
  ) => (() => void) | undefined;
  onMoshSessionReady?: (
    sessionId: string,
    cb: (evt: { sessionId: string }) => void,
  ) => (() => void) | undefined;
  onTelnetEchoMode?: (
    sessionId: string,
    cb: (evt: { sessionId: string; remoteEcho: boolean; localEcho: boolean }) => void,
  ) => (() => void) | undefined;
  onChainProgress: (
    cb: (sessionId: string, hop: number, total: number, label: string, status: string, error?: string) => void,
  ) => (() => void) | undefined;
  onConnectionReuseFallback?: (
    cb: (sessionId: string, sourceSessionId?: string) => void,
  ) => (() => void) | undefined;
  writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; lineDelayMs?: number; logRewrite?: ProgrammaticCommandLogRewrite }) => void;
  interruptSession?: (sessionId: string, trace?: NetcattyTerminalInterruptTrace) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
  closeSession: (sessionId: string) => void | Promise<void>;
  /** Pause/resume the source stream for output back-pressure (optional). */
  setSessionFlowPaused?: (sessionId: string, paused: boolean) => void;
  /** Acknowledge rendered terminal output bytes for main-process IPC back-pressure. */
  ackSessionFlow?: (sessionId: string, bytes: number) => void;
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
  keys: SSHKey[];
  identities?: Identity[];
  knownHosts?: KnownHost[];
  resolvedChainHosts: Host[];
  sessionId: string;
  // Source session id to reuse an authenticated SSH connection from when this
  // terminal was created from an existing SSH session.
  reuseConnectionFromSessionId?: string;
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
  isVisibleRef?: RefObject<boolean>;
  /** False after unmount/teardown so in-flight session starts skip attach. */
  isBootActiveRef?: RefObject<boolean>;
  pendingOutputScrollRef?: RefObject<boolean>;

  sessionRef: RefObject<string | null>;
  hasConnectedRef: RefObject<boolean>;
  hasRunStartupCommandRef: RefObject<boolean>;
  disposeDataRef: RefObject<(() => void) | null>;
  disposeExitRef: RefObject<(() => void) | null>;
  disposeTelnetEchoModeRef?: RefObject<(() => void) | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  serializeAddonRef: RefObject<SerializeAddon | null>;
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
  onSessionExit?: (sessionId: string, evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void;
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
};

export type TerminalSessionDataMeta = {
  droppedOutputMayAffectTerminalState?: boolean;
  droppedOutputAlternateScreenAction?: 'enter' | 'leave';
  /** True while Mosh is still on the ephemeral SSH handshake PTY. */
  moshHandshake?: boolean;
  terminalPerf?: NetcattyTerminalOutputPerfMeta;
};
