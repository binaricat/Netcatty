export const starterTestNoop = () => undefined;

export const ENCRYPTED_CREDENTIAL_PLACEHOLDER = "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==";

export const armSudoPrompt = (
  autofill: { armForCommand: (command: string) => void } | null,
  command = "sudo whoami",
): string => {
  autofill?.armForCommand(command);
  return "[sudo] password for alice: ";
};

export const createMockTerminalBackend = (overrides: Record<string, unknown> = {}) => ({
  backendAvailable: () => true,
  telnetAvailable: () => true,
  moshAvailable: () => true,
  localAvailable: () => true,
  serialAvailable: () => true,
  execAvailable: () => true,
  startSSHSession: async () => "ssh-session",
  startTelnetSession: async () => "telnet-session",
  startMoshSession: async () => "mosh-session",
  startLocalSession: async () => "local-session",
  startSerialSession: async () => "serial-session",
  execCommand: async () => ({}),
  onSessionData: () => starterTestNoop,
  onSessionExit: () => starterTestNoop,
  onChainProgress: () => starterTestNoop,
  writeToSession: starterTestNoop,
  resizeSession: starterTestNoop,
  ...overrides,
});

export const createTermStub = (overrides: Record<string, unknown> = {}) => ({
  cols: 120,
  rows: 32,
  write: (_data: string, callback?: () => void) => callback?.(),
  writeln: starterTestNoop,
  scrollToBottom: starterTestNoop,
  ...overrides,
});

export const createStarterContext = (overrides: Record<string, unknown> = {}) => ({
  host: {
    id: "host-1",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
  },
  keys: [],
  identities: [],
  knownHosts: [],
  resolvedChainHosts: [],
  sessionId: "session-1",
  terminalSettings: {},
  sessionRef: { current: null },
  hasConnectedRef: { current: false },
  hasRunStartupCommandRef: { current: false },
  disposeDataRef: { current: null },
  disposeExitRef: { current: null },
  fitAddonRef: { current: null },
  serializeAddonRef: { current: null },
  pendingAuthRef: { current: null },
  updateStatus: starterTestNoop,
  setStatus: starterTestNoop,
  setError: starterTestNoop,
  setNeedsAuth: starterTestNoop,
  setAuthRetryMessage: starterTestNoop,
  setAuthPassword: starterTestNoop,
  setProgressLogs: starterTestNoop,
  setProgressValue: starterTestNoop,
  setChainProgress: starterTestNoop,
  ...overrides,
});
