
export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  group?: string;
  tags: string[];
  os: 'linux' | 'windows' | 'macos';
  identityFileId?: string; // Reference to SSHKey
  protocol?: 'ssh' | 'telnet' | 'local';
  password?: string;
  authMethod?: 'password' | 'key' | 'certificate' | 'fido2';
  agentForwarding?: boolean;
  startupCommand?: string;
  hostChaining?: string;
  proxy?: string;
  envVars?: string;
  charset?: string;
  moshEnabled?: boolean;
  theme?: string;
  distro?: string; // detected distro id (e.g., ubuntu, debian)
}

export interface SSHKey {
  id: string;
  label: string;
  type: 'RSA' | 'ECDSA' | 'ED25519';
  privateKey: string;
  publicKey?: string;
  created: number;
}

export interface Snippet {
  id: string;
  label: string;
  command: string; // Multi-line script
  tags?: string[];
  package?: string; // package path
  targets?: string[]; // host ids
}

export interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  directory?: string;
  timestamp: number;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface GroupNode {
  name: string;
  path: string;
  children: Record<string, GroupNode>;
  hosts: Host[];
}

export interface SyncConfig {
  gistId: string;
  githubToken: string;
  lastSync?: number;
}

export interface TerminalTheme {
  id: string;
  name: string;
  type: 'dark' | 'light';
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  }
}

export interface TerminalSession {
  id: string;
  hostId: string;
  hostLabel: string;
  username: string;
  hostname: string;
  status: 'connecting' | 'connected' | 'disconnected';
  workspaceId?: string;
}

export interface RemoteFile {
  name: string;
  type: 'file' | 'directory';
  size: string;
  lastModified: string;
}

export type WorkspaceNode =
  | {
      id: string;
      type: 'pane';
      sessionId: string;
    }
  | {
      id: string;
      type: 'split';
      direction: 'horizontal' | 'vertical';
      children: WorkspaceNode[];
      sizes?: number[]; // relative sizes for children
    };

export interface Workspace {
  id: string;
  title: string;
  root: WorkspaceNode;
}
