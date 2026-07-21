export type TargetOs = 'linux' | 'darwin' | 'win32' | 'unknown';

export interface SessionCapabilities {
  targetOs: TargetOs;
  hasTmux: boolean;
  hasDocker: boolean;
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
  | { action: 'rm'; imageId: string; force?: boolean }
  | { action: 'prune'; all?: boolean }
  | { action: 'tag'; imageId: string; repository: string; tag?: string };

export type SystemManagerSubTab = 'overview' | 'processes' | 'tmux' | 'docker';

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
  localShellType?: import('../../types').TerminalSession['shellType'];
  /**
   * When set, the popup attaches to this already-running backend session
   * (same PTY) instead of starting a new shell. Used for AI silent sessions.
   */
  attachSessionId?: string;
  /** Ephemeral main-process grant bound to the attach popup window. */
  attachAuthorization?: string;
}
