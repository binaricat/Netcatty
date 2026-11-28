/**
 * External Editor Integration Domain Logic
 *
 * Pure helpers for:
 * - Editor presets (Zed primary, extensible to VS Code, Cursor, Windsurf, Custom)
 * - Safe remote path validation, normalization, and URI encoding
 * - Deterministic, DNS-safe `*.netcatty` SSH bridge hostnames
 * - Custom OSC 7337 terminal escape sequence parsing & formatting (with tmux passthrough)
 * - Per-host trust resolution
 * - Structured process argument building (never shell strings)
 * - Remote shell integration snippet generation (bash/zsh/fish)
 */

export const EXTERNAL_EDITOR_OSC_CODE = 7337;
export const EXTERNAL_EDITOR_OSC_ACTION = 'open-editor';
export const EXTERNAL_EDITOR_OSC_VERSION = 1;
export const EXTERNAL_EDITOR_MAX_OSC_PAYLOAD_BYTES = 4096;
export const EXTERNAL_EDITOR_MAX_REMOTE_PATH_LENGTH = 2048;

export const SSH_BRIDGE_HOSTNAME_SUFFIX = '.netcatty';

export type ExternalEditorPresetId = 'zed' | 'vscode' | 'cursor' | 'windsurf' | 'custom';
export type ExternalEditorHostTrustPolicy = 'allow' | 'ask' | 'deny';
export type ExternalEditorConnectionMode = 'bridge' | 'direct';
export type ExternalEditorTargetKind = 'file' | 'dir' | 'auto';

export interface ExternalEditorConfig {
  id: ExternalEditorPresetId;
  /** Empty string means auto-detect from system installation paths / PATH. */
  executablePath: string;
  /**
   * Only used when `id === 'custom'`.
   * Each element is passed as a separate argv item (never shell-evaluated).
   * Supported placeholders: `{sshUri}`, `{sshTarget}`, `{remotePath}`, `{encodedPath}`, `{kind}`.
   */
  customArgs?: string[];
}

export interface ExternalEditorSettings {
  defaultEditor: ExternalEditorPresetId;
  editors: Record<ExternalEditorPresetId, ExternalEditorConfig>;
  terminalRequestsEnabled: boolean;
  autoSetupShellIntegration: boolean;
  defaultTrustPolicy: ExternalEditorHostTrustPolicy;
  trustedHosts: Record<string, ExternalEditorHostTrustPolicy>;
  connectionMode: ExternalEditorConnectionMode;
}

export interface ExternalEditorPresetMetadata {
  id: ExternalEditorPresetId;
  label: string;
  cliCommand: string;
  supportsRemoteSsh: boolean;
}

export const EXTERNAL_EDITOR_PRESETS: Readonly<Record<ExternalEditorPresetId, ExternalEditorPresetMetadata>> = Object.freeze({
  zed: {
    id: 'zed',
    label: 'Zed',
    cliCommand: 'zed',
    supportsRemoteSsh: true,
  },
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    cliCommand: 'code',
    supportsRemoteSsh: true,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    cliCommand: 'cursor',
    supportsRemoteSsh: true,
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf',
    cliCommand: 'windsurf',
    supportsRemoteSsh: true,
  },
  custom: {
    id: 'custom',
    label: 'Custom Editor',
    cliCommand: 'ncedit',
    supportsRemoteSsh: true,
  },
});

export const EXTERNAL_EDITOR_PRESET_IDS: readonly ExternalEditorPresetId[] = Object.freeze([
  'zed',
  'vscode',
  'cursor',
  'windsurf',
  'custom',
]);

export const DEFAULT_CUSTOM_EDITOR_ARGS: readonly string[] = Object.freeze(['{sshUri}']);

export const DEFAULT_EXTERNAL_EDITOR_SETTINGS: ExternalEditorSettings = {
  defaultEditor: 'zed',
  editors: {
    zed: { id: 'zed', executablePath: '' },
    vscode: { id: 'vscode', executablePath: '' },
    cursor: { id: 'cursor', executablePath: '' },
    windsurf: { id: 'windsurf', executablePath: '' },
    custom: { id: 'custom', executablePath: '', customArgs: [...DEFAULT_CUSTOM_EDITOR_ARGS] },
  },
  terminalRequestsEnabled: true,
  autoSetupShellIntegration: false,
  defaultTrustPolicy: 'ask',
  trustedHosts: {},
  connectionMode: 'bridge',
};

export function isExternalEditorPresetId(value: unknown): value is ExternalEditorPresetId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXTERNAL_EDITOR_PRESETS, value);
}

export function isExternalEditorHostTrustPolicy(value: unknown): value is ExternalEditorHostTrustPolicy {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

export function isExternalEditorConnectionMode(value: unknown): value is ExternalEditorConnectionMode {
  return value === 'bridge' || value === 'direct';
}

export function isExternalEditorTargetKind(value: unknown): value is ExternalEditorTargetKind {
  return value === 'file' || value === 'dir' || value === 'auto';
}

export function normalizeExternalEditorSettings(
  raw: Partial<ExternalEditorSettings> | null | undefined,
): ExternalEditorSettings {
  const defaultEditor: ExternalEditorPresetId = isExternalEditorPresetId(raw?.defaultEditor)
    ? raw.defaultEditor
    : DEFAULT_EXTERNAL_EDITOR_SETTINGS.defaultEditor;

  const editors = {} as Record<ExternalEditorPresetId, ExternalEditorConfig>;
  for (const id of EXTERNAL_EDITOR_PRESET_IDS) {
    const incoming = raw?.editors?.[id];
    const executablePath = typeof incoming?.executablePath === 'string'
      ? incoming.executablePath.trim()
      : '';
    if (id === 'custom') {
      const customArgs = Array.isArray(incoming?.customArgs)
        ? incoming.customArgs
            .filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
            .slice(0, 32)
        : [...DEFAULT_CUSTOM_EDITOR_ARGS];
      editors[id] = {
        id,
        executablePath,
        customArgs: customArgs.length > 0 ? customArgs : [...DEFAULT_CUSTOM_EDITOR_ARGS],
      };
    } else {
      editors[id] = { id, executablePath };
    }
  }

  const trustedHosts: Record<string, ExternalEditorHostTrustPolicy> = {};
  if (raw?.trustedHosts && typeof raw.trustedHosts === 'object') {
    for (const [hostKey, policy] of Object.entries(raw.trustedHosts)) {
      const trimmedKey = hostKey.trim();
      if (trimmedKey && isExternalEditorHostTrustPolicy(policy)) {
        trustedHosts[trimmedKey] = policy;
      }
    }
  }

  return {
    defaultEditor,
    editors,
    terminalRequestsEnabled: typeof raw?.terminalRequestsEnabled === 'boolean'
      ? raw.terminalRequestsEnabled
      : DEFAULT_EXTERNAL_EDITOR_SETTINGS.terminalRequestsEnabled,
    autoSetupShellIntegration: typeof raw?.autoSetupShellIntegration === 'boolean'
      ? raw.autoSetupShellIntegration
      : DEFAULT_EXTERNAL_EDITOR_SETTINGS.autoSetupShellIntegration,
    defaultTrustPolicy: isExternalEditorHostTrustPolicy(raw?.defaultTrustPolicy)
      ? raw.defaultTrustPolicy
      : DEFAULT_EXTERNAL_EDITOR_SETTINGS.defaultTrustPolicy,
    trustedHosts,
    connectionMode: isExternalEditorConnectionMode(raw?.connectionMode)
      ? raw.connectionMode
      : DEFAULT_EXTERNAL_EDITOR_SETTINGS.connectionMode,
  };
}

export function getExternalEditorLabel(id: ExternalEditorPresetId): string {
  return EXTERNAL_EDITOR_PRESETS[id]?.label ?? 'External Editor';
}

export interface ExternalEditorHostIdentity {
  hostId?: string;
  hostname?: string;
  port?: number;
  username?: string;
  label?: string;
}

/**
 * Compute a stable key for per-host trust policies and bridge aliases.
 * Prefers the vault `hostId` when available, otherwise falls back to `user@host:port`.
 */
export function getHostKeyForExternalEditor(host: ExternalEditorHostIdentity): string {
  const hostId = typeof host.hostId === 'string' ? host.hostId.trim() : '';
  if (hostId) return `host:${hostId}`;
  const hostname = typeof host.hostname === 'string' ? host.hostname.trim().toLowerCase() : '';
  const username = typeof host.username === 'string' ? host.username.trim() : '';
  const port = Number.isInteger(host.port) && (host.port as number) > 0 ? (host.port as number) : 22;
  if (!hostname) return '';
  return username ? `${username}@${hostname}:${port}` : `${hostname}:${port}`;
}

export function resolveExternalEditorTrustPolicy(
  settings: ExternalEditorSettings,
  host: ExternalEditorHostIdentity,
): ExternalEditorHostTrustPolicy {
  const hostKey = getHostKeyForExternalEditor(host);
  if (hostKey && settings.trustedHosts[hostKey]) {
    return settings.trustedHosts[hostKey];
  }
  return settings.defaultTrustPolicy;
}

/**
 * Pure FNV-1a 32-bit hash for deterministic, dependency-free hostname suffixes.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Produce a DNS-safe, OpenSSH-safe `*.netcatty` hostname for a Netcatty host.
 * Strictly `[a-z0-9-]{1,50}.netcatty` — zero shell metacharacters or whitespace.
 */
export function buildSshBridgeHostname(host: ExternalEditorHostIdentity): string {
  const stableKey = getHostKeyForExternalEditor(host)
    || `${host.username || ''}@${host.hostname || 'session'}:${host.port || 22}`;
  const rawBase = (host.label || host.hostname || 'host').toLowerCase();
  const slug = rawBase
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'host';
  const suffix = fnv1aHex(stableKey);
  return `${slug}-${suffix}${SSH_BRIDGE_HOSTNAME_SUFFIX}`;
}

export function isSshBridgeHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netcatty$/.test(hostname);
}

/**
 * Validate and normalize a remote path before encoding into an editor URI.
 * Rejects control characters, NUL bytes, newlines, and overly long paths.
 */
export function validateAndNormalizeRemotePath(
  rawPath: string,
  fallbackCwd?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof rawPath !== 'string') {
    return { ok: false, error: 'Remote path must be a string' };
  }
  if (rawPath.length === 0) {
    return { ok: false, error: 'Remote path is empty' };
  }
  if (rawPath.length > EXTERNAL_EDITOR_MAX_REMOTE_PATH_LENGTH) {
    return { ok: false, error: 'Remote path exceeds maximum length' };
  }
  // Reject NUL, CR, LF, and all ASCII control characters (0x00-0x1F, 0x7F).
  for (let i = 0; i < rawPath.length; i += 1) {
    const code = rawPath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return { ok: false, error: 'Remote path contains disallowed control characters' };
    }
  }

  let candidate = rawPath;

  // Resolve relative paths against the session's known CWD when provided.
  const isPosixAbsolute = candidate.startsWith('/');
  const isHomeRelative = candidate === '~' || candidate.startsWith('~/');
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(candidate);

  if (!isPosixAbsolute && !isHomeRelative && !isWindowsDrive) {
    const base = typeof fallbackCwd === 'string' ? fallbackCwd : '';
    if (!base || (!base.startsWith('/') && !base.startsWith('~'))) {
      return { ok: false, error: 'Cannot resolve relative remote path without an absolute working directory' };
    }
    candidate = base.endsWith('/') ? `${base}${candidate}` : `${base}/${candidate}`;
  }

  // Normalize POSIX paths (preserving leading `~/` if present).
  if (candidate.startsWith('/') || candidate === '~' || candidate.startsWith('~/')) {
    const hasTilde = candidate === '~' || candidate.startsWith('~/');
    const body = hasTilde ? candidate.slice(1) : candidate;
    const parts = body.split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) {
          stack.pop();
        } else if (hasTilde) {
          // Cannot traverse above `~` without knowing $HOME.
          return { ok: false, error: 'Cannot resolve parent traversal above home directory' };
        }
      } else {
        stack.push(part);
      }
    }
    const normalized = hasTilde
      ? (stack.length > 0 ? `~/${stack.join('/')}` : '~')
      : `/${stack.join('/')}`;
    return { ok: true, path: normalized };
  }

  // Remote Windows path (e.g., C:\Users\dev\project -> /C:/Users/dev/project)
  const slashPath = candidate.replace(/\\/g, '/');
  const parts = slashPath.split('/');
  const drive = parts[0];
  const stack: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return { ok: true, path: `/${drive}/${stack.join('/')}`.replace(/\/+$/, '') || `/${drive}/` };
}

/**
 * Percent-encode a validated remote path segment-by-segment for `ssh://` and `vscode-remote://` URIs.
 * Always returns a string starting with `/`.
 */
export function encodeRemoteSshPath(normalizedPath: string): string {
  if (normalizedPath === '~') {
    return '/~';
  }
  if (normalizedPath.startsWith('~/')) {
    const rest = normalizedPath
      .slice(2)
      .split('/')
      .filter((s) => s.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return rest ? `/~/${rest}` : '/~';
  }
  const clean = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  const segments = clean.split('/');
  const encoded = segments
    .map((segment, index) => {
      if (index === 0) return '';
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) {
        // Keep Windows drive letter colon unescaped for remote Windows hosts.
        return segment;
      }
      return encodeURIComponent(segment);
    })
    .join('/');
  return encoded || '/';
}

/**
 * Validate and build a direct OpenSSH authority (`[user@]host[:port]`) for `direct` mode.
 */
export function buildDirectSshTarget(host: ExternalEditorHostIdentity): string | null {
  const hostname = typeof host.hostname === 'string' ? host.hostname.trim() : '';
  if (!hostname) return null;
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const isIpv6 = unbracketed.includes(':') && /^[0-9a-fA-F:]+(%[A-Za-z0-9._-]+)?$/.test(unbracketed);
  // Reject whitespace, control chars, or URI/option injection characters.
  if (!isIpv6 && (/[\s/@:?#\\'"`$;|&<>]/.test(hostname) || hostname.startsWith('-'))) {
    return null;
  }
  const username = typeof host.username === 'string' ? host.username.trim() : '';
  if (username && (/[\s/@:?#\\'"`$;|&<>]/.test(username) || username.startsWith('-'))) {
    return null;
  }
  const port = Number.isInteger(host.port) && (host.port as number) > 0 && (host.port as number) <= 65535
    ? (host.port as number)
    : 22;

  const formattedHost = isIpv6 ? `[${unbracketed}]` : hostname;
  const authPrefix = username ? `${encodeURIComponent(username)}@` : '';
  const portSuffix = port !== 22 ? `:${port}` : '';
  return `${authPrefix}${formattedHost}${portSuffix}`;
}

export interface BuildEditorLaunchSpecInput {
  editorId: ExternalEditorPresetId;
  executablePath: string;
  customArgs?: string[];
  sshTarget: string;
  remotePath: string;
  kind: ExternalEditorTargetKind;
  platform: NodeJS.Platform;
}

export interface EditorLaunchSpec {
  command: string;
  args: string[];
  displayUri: string;
}

/**
 * Build a safe, structured spawn specification (`command` + `args[]`, never a shell string).
 */
export function buildExternalEditorLaunchSpec(input: BuildEditorLaunchSpecInput): EditorLaunchSpec {
  const encodedPath = encodeRemoteSshPath(input.remotePath);
  const sshUri = `ssh://${input.sshTarget}${encodedPath}`;

  let editorArgs: string[];
  let displayUri = sshUri;

  switch (input.editorId) {
    case 'zed': {
      editorArgs = [sshUri];
      displayUri = sshUri;
      break;
    }
    case 'vscode':
    case 'cursor':
    case 'windsurf': {
      const vscodeUri = `vscode-remote://ssh-remote+${input.sshTarget}${encodedPath}`;
      const flag = input.kind === 'file' ? '--file-uri' : '--folder-uri';
      editorArgs = [flag, vscodeUri];
      displayUri = vscodeUri;
      break;
    }
    case 'custom': {
      const template = input.customArgs && input.customArgs.length > 0
        ? input.customArgs
        : [...DEFAULT_CUSTOM_EDITOR_ARGS];
      editorArgs = template.map((token) =>
        token
          .replace(/\{sshUri\}/g, sshUri)
          .replace(/\{sshTarget\}/g, input.sshTarget)
          .replace(/\{remotePath\}/g, input.remotePath)
          .replace(/\{encodedPath\}/g, encodedPath)
          .replace(/\{kind\}/g, input.kind),
      );
      displayUri = sshUri;
      break;
    }
  }

  // On macOS, `.app` bundles must be launched via `/usr/bin/open -a <bundle> --args ...`
  // whereas CLI binaries (like `/usr/local/bin/zed`) are executed directly.
  if (input.platform === 'darwin' && /\.app\/?$/i.test(input.executablePath)) {
    return {
      command: 'open',
      args: ['-a', input.executablePath.replace(/\/+$/, ''), '--args', ...editorArgs],
      displayUri,
    };
  }

  return {
    command: input.executablePath,
    args: editorArgs,
    displayUri,
  };
}

// ---------------------------------------------------------------------------
// Custom OSC 7337 protocol (Remote terminal -> Netcatty)
// ---------------------------------------------------------------------------

export interface ExternalEditorOscRequest {
  /** Requested editor preset, or undefined to use the user's configured defaultEditor. */
  editorId?: ExternalEditorPresetId;
  kind: ExternalEditorTargetKind;
  path: string;
}

function decodeBase64UrlUtf8(input: string): string | null {
  if (!input || !/^[A-Za-z0-9_-]+={0,2}$/.test(input)) return null;
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeBase64UrlUtf8(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parse an OSC 7337 payload received from xterm.js (`term.parser.registerOscHandler(7337, ...)`).
 *
 * Accepted format:
 *   `open-editor;v=1;editor=zed;kind=dir;path_b64=<base64url>`
 * or (percent-encoded fallback):
 *   `open-editor;v=1;editor=zed;kind=dir;path=<percent-encoded>`
 *
 * Security:
 * - Rejects payloads > 4096 bytes.
 * - Only accepts known preset IDs or `"default"` (never arbitrary executables or commands).
 * - Rejects invalid/control-char paths.
 */
export function parseExternalEditorOscPayload(data: string): ExternalEditorOscRequest | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > EXTERNAL_EDITOR_MAX_OSC_PAYLOAD_BYTES) {
    return null;
  }
  const parts = data.split(';');
  if (parts[0] !== EXTERNAL_EDITOR_OSC_ACTION) {
    return null;
  }

  let version: number | null = null;
  let editorId: ExternalEditorPresetId | undefined;
  let kind: ExternalEditorTargetKind = 'auto';
  let rawPath: string | null = null;

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);

    if (key === 'v') {
      const parsed = Number(val);
      if (!Number.isInteger(parsed) || parsed !== EXTERNAL_EDITOR_OSC_VERSION) return null;
      version = parsed;
    } else if (key === 'editor') {
      if (val === '' || val === 'default') {
        editorId = undefined;
      } else if (isExternalEditorPresetId(val)) {
        editorId = val;
      } else {
        // Unknown / untrusted editor name — reject strictly.
        return null;
      }
    } else if (key === 'kind') {
      if (!isExternalEditorTargetKind(val)) return null;
      kind = val;
    } else if (key === 'path_b64') {
      const decoded = decodeBase64UrlUtf8(val);
      if (decoded === null) return null;
      rawPath = decoded;
    } else if (key === 'path') {
      try {
        rawPath = decodeURIComponent(val);
      } catch {
        return null;
      }
    } else {
      // Ignore unknown future extension fields? No — strict allowlist for security.
      return null;
    }
  }

  if (version !== null && version !== EXTERNAL_EDITOR_OSC_VERSION) return null;
  if (!rawPath) return null;

  // Basic control-char/length pre-validation (relative paths can still be resolved by caller against CWD).
  if (rawPath.length > EXTERNAL_EDITOR_MAX_REMOTE_PATH_LENGTH) return null;
  for (let i = 0; i < rawPath.length; i += 1) {
    const code = rawPath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }

  return {
    ...(editorId ? { editorId } : {}),
    kind,
    path: rawPath,
  };
}

export function formatExternalEditorOscSequence(
  request: ExternalEditorOscRequest,
  options?: { tmuxPassthrough?: boolean },
): string {
  const editorPart = request.editorId ? `;editor=${request.editorId}` : ';editor=default';
  const kindPart = `;kind=${request.kind}`;
  const pathPart = `;path_b64=${encodeBase64UrlUtf8(request.path)}`;
  const osc = `\x1b]${EXTERNAL_EDITOR_OSC_CODE};${EXTERNAL_EDITOR_OSC_ACTION};v=${EXTERNAL_EDITOR_OSC_VERSION}${editorPart}${kindPart}${pathPart}\x07`;
  if (options?.tmuxPassthrough) {
    // Inside tmux, double ESC bytes inside DCS tmux passthrough.
    const escaped = osc.split('\x1b').join('\x1b\x1b');
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  return osc;
}

// ---------------------------------------------------------------------------
// Remote shell integration snippets (bash/zsh & fish)
// ---------------------------------------------------------------------------

export const EXTERNAL_EDITOR_SHELL_MARKER_START = '# >>> Netcatty external editor integration >>>';
export const EXTERNAL_EDITOR_SHELL_MARKER_END = '# <<< Netcatty external editor integration <<<';

export type RemoteShellKind = 'posix' | 'fish';

/**
 * Generate a self-contained shell integration block for remote Linux/macOS shells.
 * Supports `zed`, `code`, `cursor`, `windsurf`, and `ncedit` (user's default editor),
 * works inside tmux (DCS passthrough), and resolves relative paths cleanly without external deps.
 */
export function buildExternalEditorShellSnippet(
  shell: RemoteShellKind = 'posix',
  commands: readonly { name: string; editorId: ExternalEditorPresetId | 'default' }[] = [
    { name: 'zed', editorId: 'zed' },
    { name: 'ncedit', editorId: 'default' },
  ],
): string {
  const validCommands = commands.filter(
    (entry) =>
      /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(entry.name)
      && (entry.editorId === 'default' || isExternalEditorPresetId(entry.editorId)),
  );

  if (shell === 'fish') {
    const wrappers = validCommands
      .map(
        ({ name, editorId }) =>
          `function ${name}\n  __netcatty_open_editor ${editorId} $argv\nend`,
      )
      .join('\n');

    return [
      EXTERNAL_EDITOR_SHELL_MARKER_START,
      'function __netcatty_open_editor',
      '  set -l editor $argv[1]',
      '  set -l target $argv[2]',
      '  if test -z "$target"',
      '    set target "."',
      '  end',
      '  set -l kind auto',
      '  set -l abs ""',
      '  if test -d "$target"',
      '    set kind dir',
      '    set abs (cd "$target" 2>/dev/null; and pwd -P)',
      '  else',
      '    if test -e "$target"',
      '      set kind file',
      '    end',
      '    set -l dir (dirname -- "$target")',
      '    set -l base (basename -- "$target")',
      '    set -l abs_dir (cd "$dir" 2>/dev/null; and pwd -P)',
      '    if test -n "$abs_dir"',
      '      if test "$abs_dir" = "/"',
      '        set abs "/$base"',
      '      else',
      '        set abs "$abs_dir/$base"',
      '      end',
      '    end',
      '  end',
      '  if test -z "$abs"',
      '    echo "netcatty: cannot resolve path: $target" >&2',
      '    return 1',
      '  end',
      '  set -l b64 (printf "%s" "$abs" | base64 | tr -d "\\r\\n" | tr "+/" "-_" | tr -d "=")',
      '  set -l osc (printf "\\033]7337;open-editor;v=1;editor=%s;kind=%s;path_b64=%s\\007" "$editor" "$kind" "$b64")',
      '  if set -q TMUX',
      '    printf "\\033Ptmux;\\033%s\\033\\\\" "$osc"',
      '  else',
      '    printf "%s" "$osc"',
      '  end',
      'end',
      wrappers,
      EXTERNAL_EDITOR_SHELL_MARKER_END,
    ].join('\n');
  }

  const wrappers = validCommands
    .map(({ name, editorId }) => `${name}() { __netcatty_open_editor "${editorId}" "$@"; }`)
    .join('\n');

  return [
    EXTERNAL_EDITOR_SHELL_MARKER_START,
    '__netcatty_open_editor() {',
    '  _nc_editor="$1"',
    '  shift || true',
    '  _nc_target="${1:-.}"',
    '  _nc_kind="auto"',
    '  _nc_abs=""',
    '  if [ -d "$_nc_target" ]; then',
    '    _nc_kind="dir"',
    '    _nc_abs=$(cd "$_nc_target" 2>/dev/null && pwd -P) || _nc_abs=""',
    '  else',
    '    [ -e "$_nc_target" ] && _nc_kind="file"',
    '    _nc_dir=$(dirname -- "$_nc_target")',
    '    _nc_base=$(basename -- "$_nc_target")',
    '    _nc_abs_dir=$(cd "$_nc_dir" 2>/dev/null && pwd -P) || _nc_abs_dir=""',
    '    if [ -n "$_nc_abs_dir" ]; then',
    '      if [ "$_nc_abs_dir" = "/" ]; then',
    '        _nc_abs="/$_nc_base"',
    '      else',
    '        _nc_abs="$_nc_abs_dir/$_nc_base"',
    '      fi',
    '    fi',
    '  fi',
    '  if [ -z "$_nc_abs" ]; then',
    '    printf "netcatty: cannot resolve path: %s\\n" "$_nc_target" >&2',
    '    return 1',
    '  fi',
    '  _nc_b64=$(printf "%s" "$_nc_abs" | base64 | tr -d "\\r\\n" | tr "+/" "-_" | tr -d "=")',
    '  _nc_seq=$(printf "\\033]7337;open-editor;v=1;editor=%s;kind=%s;path_b64=%s\\007" "$_nc_editor" "$_nc_kind" "$_nc_b64")',
    '  if [ -n "${TMUX:-}" ]; then',
    '    printf "\\033Ptmux;\\033%s\\033\\\\" "$_nc_seq"',
    '  else',
    '    printf "%s" "$_nc_seq"',
    '  fi',
    '}',
    wrappers,
    EXTERNAL_EDITOR_SHELL_MARKER_END,
  ].join('\n');
}

export function shouldAutoSetupExternalEditorShell(
  settings: Pick<ExternalEditorSettings, 'terminalRequestsEnabled' | 'autoSetupShellIntegration'>,
  host?: { externalEditorShellIntegration?: boolean } | null,
): boolean {
  if (!settings.terminalRequestsEnabled) return false;
  if (typeof host?.externalEditorShellIntegration === 'boolean') {
    return host.externalEditorShellIntegration;
  }
  return settings.autoSetupShellIntegration === true;
}

export const EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER = '__NETCATTY_EXT_EDITOR_UPDATED__=1';
export const EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX = '__NETCATTY_EXT_EDITOR_SHELL__=';
export const EXTERNAL_EDITOR_REMOTE_BIN_DIR = '$HOME/.netcatty/bin';

/**
 * Build a standalone POSIX `#!/bin/sh` executable wrapper for `~/.netcatty/bin/<cmd>`.
 *
 * Scoped strictly to Netcatty terminal sessions: requires `NETCATTY_EXTERNAL_EDITOR=1`
 * (exported only inside that Netcatty window's shell) and emits OSC 7337 (with tmux
 * DCS passthrough when `$TMUX` is set).
 */
export function buildExternalEditorBinWrapperScript(
  editorId: ExternalEditorPresetId | 'default',
  commandName: string,
): string {
  const safeEditor = editorId === 'default' || isExternalEditorPresetId(editorId) ? editorId : 'default';
  const safeName = /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(commandName) ? commandName : 'ncedit';
  return [
    '#!/bin/sh',
    '# Netcatty session-scoped external editor helper (OSC 7337)',
    'if [ -z "${NETCATTY_EXTERNAL_EDITOR:-}" ]; then',
    `  printf 'netcatty: %s helper is only active inside a Netcatty terminal session\\n' '${safeName}' >&2`,
    '  exit 1',
    'fi',
    `_nc_editor='${safeEditor}'`,
    '_nc_target="${1:-.}"',
    '_nc_kind="auto"',
    '_nc_abs=""',
    'if [ -d "$_nc_target" ]; then',
    '  _nc_kind="dir"',
    '  _nc_abs=$(cd "$_nc_target" 2>/dev/null && pwd -P) || _nc_abs=""',
    'else',
    '  [ -e "$_nc_target" ] && _nc_kind="file"',
    '  _nc_dir=$(dirname -- "$_nc_target")',
    '  _nc_base=$(basename -- "$_nc_target")',
    '  _nc_abs_dir=$(cd "$_nc_dir" 2>/dev/null && pwd -P) || _nc_abs_dir=""',
    '  if [ -n "$_nc_abs_dir" ]; then',
    '    if [ "$_nc_abs_dir" = "/" ]; then',
    '      _nc_abs="/$_nc_base"',
    '    else',
    '      _nc_abs="$_nc_abs_dir/$_nc_base"',
    '    fi',
    '  fi',
    'fi',
    'if [ -z "$_nc_abs" ]; then',
    '  printf \'netcatty: cannot resolve path: %s\\n\' "$_nc_target" >&2',
    '  exit 1',
    'fi',
    '_nc_b64=$(printf \'%s\' "$_nc_abs" | base64 | tr -d \'\\r\\n\' | tr \'+/\' \'-_\' | tr -d \'=\')',
    '_nc_seq=$(printf \'\\033]7337;open-editor;v=1;editor=%s;kind=%s;path_b64=%s\\007\' "$_nc_editor" "$_nc_kind" "$_nc_b64")',
    'if [ -n "${TMUX:-}" ]; then',
    '  _nc_tty=$(tmux display-message -p \'#{client_tty}\' 2>/dev/null || true)',
    '  if [ -n "$_nc_tty" ] && [ -w "$_nc_tty" ]; then',
    '    printf \'%s\' "$_nc_seq" > "$_nc_tty"',
    '  else',
    '    tmux set -p allow-passthrough on 2>/dev/null || true',
    '    printf \'\\033Ptmux;\\033%s\\033\\\\\' "$_nc_seq"',
    '  fi',
    'else',
    '  printf \'%s\' "$_nc_seq"',
    'fi',
    '',
  ].join('\n');
}

function encodeUtf8Base64(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Build a safe, idempotent POSIX `sh -c '...'` command executed over the SSH exec channel
 * to install standalone executable editor helpers into `~/.netcatty/bin/`.
 *
 * IMPORTANT: Never modifies `~/.bashrc`, `~/.zshrc`, or `config.fish`. Commands are
 * activated strictly per Netcatty terminal window by prepending `~/.netcatty/bin` to
 * that session's `PATH` and exporting `NETCATTY_EXTERNAL_EDITOR=1`.
 */
export function buildExternalEditorAutoSetupCommand(
  defaultEditor: ExternalEditorPresetId = 'zed',
): string {
  const commands = getDefaultShellCommandsForEditor(defaultEditor);
  const installLines = commands.flatMap(({ name, editorId }) => {
    const body = buildExternalEditorBinWrapperScript(editorId, name);
    const b64 = encodeUtf8Base64(body);
    return [
      `write_bin '${name}' '${b64}'`,
    ];
  });

  const script = [
    'set -eu',
    'updated=0',
    'nc_bin="$HOME/.netcatty/bin"',
    'mkdir -p "$nc_bin"',
    'write_bin() {',
    '  name="$1"',
    '  b64="$2"',
    '  target="$nc_bin/$name"',
    '  new_content=$(printf \'%s\' "$b64" | base64 -d 2>/dev/null || printf \'%s\' "$b64" | base64 -D 2>/dev/null)',
    '  old_content=$(cat "$target" 2>/dev/null || true)',
    '  if [ "$old_content" != "$new_content" ] || [ ! -x "$target" ]; then',
    '    printf "%s\\n" "$new_content" > "$target"',
    '    chmod 755 "$target"',
    '    updated=1',
    '  fi',
    '}',
    ...installLines,
    // Clean up legacy rc hooks only if they reference our old external-editor.sh auto-setup file.
    'cleanup_legacy_rc() {',
    '  rc="$1"',
    '  [ -f "$rc" ] || return 0',
    '  grep -Fq \'. "$HOME/.netcatty/external-editor.sh"\' "$rc" 2>/dev/null || return 0',
    `  tmp="$rc.netcatty-clean.$$"`,
    `  awk -v s='${EXTERNAL_EDITOR_SHELL_MARKER_START}' -v e='${EXTERNAL_EDITOR_SHELL_MARKER_END}' '`,
    '    $0 == s { skip=1; next }',
    '    skip && $0 == e { skip=0; next }',
    '    !skip { print }',
    '  \' "$rc" > "$tmp" && mv "$tmp" "$rc" || rm -f "$tmp"',
    '}',
    'cleanup_legacy_rc "$HOME/.bashrc"',
    'cleanup_legacy_rc "${ZDOTDIR:-$HOME}/.zshrc"',
    'rm -f "$HOME/.netcatty/external-editor.sh" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/netcatty-external-editor.fish" 2>/dev/null || true',
    'login_shell=$(basename "${SHELL:-sh}" 2>/dev/null || echo sh)',
    'if [ "$login_shell" = "fish" ]; then',
    `  printf '%sfish\\n' '${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}'`,
    'else',
    `  printf '%sposix\\n' '${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}'`,
    'fi',
    `if [ "$updated" = "1" ]; then printf '%s\\n' '${EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER}'; fi`,
  ].join('\n');

  const escaped = script.replace(/'/g, `'\\''`);
  return `sh -c '${escaped}'`;
}

export function parseExternalEditorAutoSetupShell(stdout: string | undefined): RemoteShellKind {
  if (typeof stdout === 'string' && stdout.includes(`${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}fish`)) {
    return 'fish';
  }
  return 'posix';
}

/**
 * Build a leading-space, session-only command that prepends `~/.netcatty/bin` to `PATH`
 * and exports `NETCATTY_EXTERNAL_EDITOR=1` for the current Netcatty terminal window
 * (and any tmux/subshells spawned inside it). Leading space keeps it out of shell history
 * when `HISTCONTROL=ignorespace`/`ignoreboth` (bash), `HIST_IGNORE_SPACE` (zsh), or fish is used.
 */
export function buildExternalEditorSessionActivateCommand(
  shell: RemoteShellKind = 'posix',
): string {
  if (shell === 'fish') {
    return ` set -gx PATH "${EXTERNAL_EDITOR_REMOTE_BIN_DIR}" $PATH; set -gx NETCATTY_EXTERNAL_EDITOR 1\r`;
  }
  return ` export PATH="${EXTERNAL_EDITOR_REMOTE_BIN_DIR}:$PATH" NETCATTY_EXTERNAL_EDITOR=1\r`;
}

export function getDefaultShellCommandsForEditor(
  defaultEditor: ExternalEditorPresetId,
): { name: string; editorId: ExternalEditorPresetId | 'default' }[] {
  const cmds: { name: string; editorId: ExternalEditorPresetId | 'default' }[] = [
    { name: 'zed', editorId: 'zed' },
  ];
  if (defaultEditor === 'vscode') {
    cmds.push({ name: 'code', editorId: 'vscode' });
  } else if (defaultEditor === 'cursor') {
    cmds.push({ name: 'cursor', editorId: 'cursor' });
  } else if (defaultEditor === 'windsurf') {
    cmds.push({ name: 'windsurf', editorId: 'windsurf' });
  }
  cmds.push({ name: 'ncedit', editorId: 'default' });
  return cmds;
}
