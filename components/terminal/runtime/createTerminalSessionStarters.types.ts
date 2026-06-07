import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Host, Identity, KnownHost, SerialConfig, SSHKey, TerminalSession, TerminalSettings } from "../../../types";
import type { PromptLineBreakState } from "./promptLineBreak";
import type { SudoPasswordAutofill } from "./terminalSudoAutofill";

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
  onSessionData: (sessionId: string, cb: (data: string) => void) => () => void;
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
  onChainProgress: (
    cb: (sessionId: string, hop: number, total: number, label: string, status: string, error?: string) => void,
  ) => (() => void) | undefined;
  onConnectionReuseFallback?: (
    cb: (sessionId: string, sourceSessionId?: string) => void,
  ) => (() => void) | undefined;
  writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
  /** Pause/resume the source stream for output back-pressure (optional). */
  setSessionFlowPaused?: (sessionId: string, paused: boolean) => void;
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
} | null;

export type SessionLogConfig = {
  enabled: boolean;
  directory: string;
  format: string;
  timestampsEnabled?: boolean;
};

export type TerminalSessionStartersContext = {
  host: Host;
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
  terminalSettings?: TerminalSettings;
  terminalSettingsRef?: RefObject<TerminalSettings | undefined>;
  terminalBackend: TerminalBackendApi;
  serialConfig?: SerialConfig;
  sessionLog?: SessionLogConfig;
  sshDebugLogEnabled?: boolean;
  sudoAutofillPassword?: string;
  sudoAutofillPasswordRef?: RefObject<string | undefined>;
  onSudoHint?: (active: boolean) => boolean;
  isVisibleRef?: RefObject<boolean>;
  pendingOutputScrollRef?: RefObject<boolean>;

  sessionRef: RefObject<string | null>;
  hasConnectedRef: RefObject<boolean>;
  hasRunStartupCommandRef: RefObject<boolean>;
  disposeDataRef: RefObject<(() => void) | null>;
  disposeExitRef: RefObject<(() => void) | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  serializeAddonRef: RefObject<SerializeAddon | null>;
  pendingAuthRef: RefObject<PendingAuth>;
  promptLineBreakStateRef?: RefObject<PromptLineBreakState>;
  sudoAutofillRef?: RefObject<SudoPasswordAutofill | null>;

  updateStatus: (next: TerminalSession["status"]) => void;
  setStatus: Dispatch<SetStateAction<TerminalSession["status"]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNeedsAuth: Dispatch<SetStateAction<boolean>>;
  setAuthRetryMessage: Dispatch<SetStateAction<string | null>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setProgressLogs: Dispatch<SetStateAction<string[]>>;
  setProgressValue: Dispatch<SetStateAction<number>>;
  setChainProgress: Dispatch<SetStateAction<ChainProgressState>>;
  t?: (key: string) => string;

  onSessionAttached?: (sessionId: string) => void;
  onSessionExit?: (sessionId: string, evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onTerminalLogData?: (data: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
};
