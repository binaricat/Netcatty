export type TargetOs = 'linux' | 'darwin' | 'win32' | 'unknown';

export interface SessionCapabilities {
  targetOs: TargetOs;
  hasTmux: boolean;
  /** `zellij` binary present. */
  hasZellij?: boolean;
  hasDocker: boolean;
  /** `podman` binary present. A podman-docker shim may also set hasDocker. */
  hasPodman?: boolean;
  /** `nerdctl` binary present. */
  hasNerdctl?: boolean;
  /** `kubectl` binary present on the remote host. */
  hasKubectl?: boolean;
  hasNvidiaSmi: boolean;
  hasNpuSmi: boolean;
  /** `ss` binary present (preferred listening-port collector). */
  hasSs?: boolean;
  /** `netstat` binary present (ports fallback). */
  hasNetstat?: boolean;
  /** `lsof` binary present (macOS / process-aware ports fallback). */
  hasLsof?: boolean;
  /** `systemctl` binary present. */
  hasSystemctl?: boolean;
  probedAt: number;
}

export type ListeningPortProtocol = 'tcp' | 'udp' | 'tcp6' | 'udp6' | 'unknown';

export interface ListeningPortInfo {
  protocol: ListeningPortProtocol;
  address: string;
  port: number;
  pid: number | null;
  processName: string;
  /** Stable row id for list merging: protocol|address|port|pid */
  id: string;
}

export type SystemdUnitActiveState =
  | 'active'
  | 'inactive'
  | 'failed'
  | 'activating'
  | 'deactivating'
  | 'reloading'
  | 'unknown';

export type SystemdUnitLoadState = 'loaded' | 'not-found' | 'bad-setting' | 'error' | 'masked' | 'unknown';
export type SystemdUnitSubState = string;

export interface SystemdUnitInfo {
  name: string;
  loadState: SystemdUnitLoadState;
  activeState: SystemdUnitActiveState;
  subState: SystemdUnitSubState;
  description: string;
  /** system or --user instance */
  scope: 'system' | 'user';
}

export type SystemdUnitAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'reload';

export type AcceleratorVendor = 'nvidia' | 'ascend';

export interface AcceleratorDeviceInfo {
  vendor: AcceleratorVendor;
  index: number;
  uuid: string;
  name: string;
  utilizationPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
  fanPercent: number | null;
  driverVersion: string | null;
  health: string | null;
}

export interface AcceleratorProcessInfo {
  vendor: AcceleratorVendor;
  gpuIndex: number;
  pid: number;
  processName: string;
  memoryUsedMb: number | null;
}

export interface AcceleratorSnapshot {
  devices: AcceleratorDeviceInfo[];
  processes: AcceleratorProcessInfo[];
  nvidiaDriverVersion: string | null;
  probedAt: number;
}

export interface SystemProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  stat: string;
  cpuPercent: number;
  memPercent: number;
  rssKb: number;
  vszKb: number;
  elapsed: string;
  command: string;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
  activity?: string;
  group?: string;
}

export interface TmuxWindowInfo {
  index: number;
  name: string;
  panes: number;
  active: boolean;
  layout: string;
}

export interface TmuxPaneInfo {
  index: number;
  title: string;
  command: string;
  active: boolean;
  pid: number;
  width: number;
  height: number;
}

export interface TmuxClientInfo {
  name: string;
  tty: string;
  activity: string;
  session: string;
}

export type TmuxManageAction =
  | { action: 'killSession'; sessionName: string }
  | { action: 'renameSession'; sessionName: string; newName: string }
  | { action: 'detachSession'; sessionName: string }
  | { action: 'createWindow'; sessionName: string; windowName?: string }
  | { action: 'killWindow'; sessionName: string; windowIndex: number }
  | { action: 'renameWindow'; sessionName: string; windowIndex: number; newName: string }
  | { action: 'killPane'; sessionName: string; windowIndex: number; paneIndex: number }
  | { action: 'splitPane'; sessionName: string; windowIndex: number; paneIndex?: number; direction: 'horizontal' | 'vertical' }
  | { action: 'sendKeys'; sessionName: string; windowIndex: number; paneIndex: number; keys: string; enter?: boolean }
  | { action: 'selectWindow'; sessionName: string; windowIndex: number }
  | { action: 'killServer' };

/** A login user on the remote host that may own tmux/zellij sessions. */
export interface MultiplexerUser {
  name: string;
  uid: number;
  /** True when a tmux socket directory (`/tmp/tmux-<uid>`) exists for this user. */
  hasTmuxSockets?: boolean;
}

/**
 * Scope for running multiplexer (tmux/zellij) commands as another host user
 * via sudo. Undefined `user` means the current connection user (no sudo).
 */
export interface MultiplexerScope {
  user?: string;
  /** Saved SSH/sudo password piped to `sudo -S`; omitted for passwordless `sudo -n`. */
  sudoPassword?: string;
  /** UID of `user`; lets a root connection open `/tmp/tmux-<uid>` sockets directly. */
  targetUid?: number;
  /**
   * Root fast path (tmux only): the connection user is uid 0, so the target
   * user's sockets are readable without sudo — no PAM round trip per command.
   */
  directAsRoot?: boolean;
}

/** One round trip worth of tmux state: sessions + every window + client. */
export interface TmuxSnapshot {
  sessions: TmuxSessionInfo[];
  /** Windows grouped by owning session name. */
  windowsBySession: Record<string, TmuxWindowInfo[]>;
  clients: TmuxClientInfo[];
  tmuxVersion?: string;
}

export interface ZellijSessionInfo {
  name: string;
  /** Raw "[Created …]" text reported by `zellij list-sessions`. */
  createdText: string;
  /** Session has at least one attached client. */
  attached: boolean;
  /** Session is exited but kept for resurrection. */
  exited: boolean;
  /** This session is the one the probing client is attached to. */
  isCurrent: boolean;
}

export type ZellijManageAction =
  | { action: 'killSession'; sessionName: string }
  | { action: 'deleteSession'; sessionName: string; force?: boolean };

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
}

export interface DockerStatInfo {
  id: string;
  name: string;
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
  netIO: string;
  blockIO: string;
  pids: number;
}

export interface DockerImageInfo {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
  digest?: string;
  name: string;
}

/** Unique per `docker images` row — same layer id can have multiple repo:tag lines. */
export function dockerImageRowKey(image: DockerImageInfo): string {
  return `${image.id}\0${image.repository}\0${image.tag}`;
}

export type DockerContainerAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'rm'
  | 'pause'
  | 'unpause'
  | 'kill'
  | 'rename';

export type DockerImageManageAction =
  | { action: 'pull'; imageRef: string }
  | { action: 'rm'; imageId: string; force?: boolean; repository?: string; tag?: string }
  | { action: 'prune'; all?: boolean }
  | { action: 'tag'; imageId: string; repository: string; tag?: string };

export type SystemManagerSubTab =
  | 'overview'
  | 'processes'
  | 'ports'
  | 'services'
  | 'tmux'
  | 'zellij'
  | 'docker'
  | 'gpu';

export interface TerminalPopupIcon {
  kind: 'image';
  src: string;
  backgroundColor?: string;
  alt?: string;
}

export interface TerminalPopupPayload {
  popupId?: string;
  title: string;
  icon?: TerminalPopupIcon;
  parentSessionId: string;
  sourceSession: import('../../types').TerminalSession;
  startupCommand: string;
  /**
   * System-manager panel rectangle in renderer viewport pixels. The popup is
   * placed in the remaining source-window area so it does not cover this panel.
   */
  avoidClientRect?: { x: number; y: number; width: number; height: number };
  localShellType?: import('../../types').TerminalSession['shellType'];
  /**
   * When set, the popup attaches to this already-running backend session
   * (same PTY) instead of starting a new shell. Used for AI silent sessions.
   */
  attachSessionId?: string;
  /** Ephemeral main-process grant bound to the attach popup window. */
  attachAuthorization?: string;
}
