import type { SerialConfig, Snippet } from './connection';
import type { CodingCliProviderId } from '../codingCliProviders';
import {
  normalizeHibernateHiddenTabsDelaySec,
  normalizeHibernateKeepRendererCount,
  normalizeHibernateReplayChunkBytes,
} from '../terminalHibernate';

// Terminal appearance settings
export type CursorShape = 'block' | 'bar' | 'underline';
export type TerminalMouseClickBehavior = 'context-menu' | 'paste' | 'select-word';
export type RightClickBehavior = TerminalMouseClickBehavior;
export type MiddleClickBehavior = 'context-menu' | 'paste' | 'disabled';
export type LinkModifier = 'none' | 'ctrl' | 'alt' | 'meta';
export type TerminalEmulationType = 'xterm-256color' | 'xterm-16color' | 'xterm';
export type DynamicTabTitleMode = 'off' | 'agent' | 'all';

export const DEFAULT_TERMINAL_WORD_SEPARATORS = ' ()[]{}\'"';

// Keyword highlighting configuration
export interface KeywordHighlightRule {
  id: string;
  label: string; // Display name (e.g., "Error", "Warning", "OK")
  patterns: string[]; // Regex patterns to match
  color: string; // Highlight color (hex)
  enabled: boolean;
  // Set to true when the user edits a built-in rule's label/patterns so
  // normalize keeps the user-edited values instead of overwriting them with
  // the latest shipped defaults. Absent / false means "still tracking defaults"
  // and the rule picks up new built-in patterns added in later versions.
  customized?: boolean;
}

export interface TerminalSettings {
  // Rendering
  scrollback: number; // Number of lines kept in buffer
  drawBoldInBrightColors: boolean; // Draw bold text in bright colors
  terminalEmulationType: TerminalEmulationType; // Terminal emulation type (TERM env var)
  startupCommandDelayMs: number; // Delay (ms) after connect before sending the startup command; also used between multiple lines

  // Font
  fontLigatures: boolean; // Enable font ligatures
  fontSmoothing: boolean; // Use native macOS/WebKit font anti-aliasing
  fontWeight: number; // Normal font weight (100-900)
  fontWeightBold: number; // Bold font weight (100-900)
  linePadding: number; // Additional space between lines
  fallbackFont: string; // Fallback font family

  // Cursor
  cursorShape: CursorShape;
  cursorBlink: boolean;

  // Accessibility
  minimumContrastRatio: number; // Minimum contrast ratio (1-21)

  // Keyboard
  altAsMeta: boolean; // Use ⌥ as the Meta key
  optionArrowWordJump: boolean; // macOS: Option+←/→ send Meta-b/f for word jump
  shiftEnterNewlineEnabled: boolean; // Send configured text on Shift+Enter
  shiftEnterNewlineText: string; // Backslash-escaped text sent by Shift+Enter
  scrollOnInput: boolean; // Scroll terminal to bottom on input
  scrollOnOutput: boolean; // Scroll terminal to bottom on output
  scrollOnKeyPress: boolean; // Scroll terminal to bottom on key press
  scrollOnPaste: boolean; // Scroll terminal to bottom on paste

  smoothScrolling: boolean; // Animate viewport scrolling instead of jumping instantly

  // Mouse
  rightClickBehavior: RightClickBehavior;
  middleClickBehavior: MiddleClickBehavior;
  copyOnSelect: boolean; // Automatically copy selected text
  middleClickPaste: boolean; // Legacy mirror for older settings payloads
  wordSeparators: string; // Characters for word selection
  linkModifier: LinkModifier; // Modifier key to click links

  // Keyword Highlighting
  keywordHighlightEnabled: boolean;
  keywordHighlightRules: KeywordHighlightRule[];

  // Local Shell Configuration
  localShell: string; // Path to shell executable (empty = system default)
  localShellArgs: string[]; // Launch args for a custom local shell (e.g. ["--login", "-i"] for msys2 bash); ignored for discovered shells
  localStartDir: string; // Starting directory for local terminal (empty = home directory)

  // SSH Connection
  verifyHostKeys: boolean; // Verify SSH host keys before authenticating
  keepaliveInterval: number; // Seconds between SSH-level keepalive packets (0 = disabled)
  keepaliveCountMax: number; // Unanswered keepalives before declaring the connection dead
  sshAutoReconnectEnabled: boolean; // Automatically reconnect SSH sessions after unexpected disconnects
  x11Display: string; // Optional local X11 DISPLAY override (empty = use system DISPLAY/default)

  // Mosh Connection
  // Legacy override retained for old settings payloads and internal callers.
  // The normal UI path uses Netcatty's bundled mosh-client.
  moshClientPath: string;

  // Server Stats Display (Linux only)
  showHostInfoBar: boolean; // Show host identity and server stats above the terminal
  showServerStats: boolean; // Show CPU/Memory/Disk in terminal statusbar
  serverStatsRefreshInterval: number; // Seconds between stats refresh (default: 30)

  // System Manager side panel polling (seconds)
  systemManagerProcessRefreshInterval: number;
  systemManagerTmuxRefreshInterval: number;
  systemManagerDockerListRefreshInterval: number;
  systemManagerDockerStatsRefreshInterval: number;

  // Paste
  disableBracketedPaste: boolean; // Disable bracketed paste mode (avoid ^[[200~ artifacts)

  // Shell `clear` command behavior — controls whether CSI 3 J (erase scrollback)
  // from the shell is honored. Default true matches POSIX/ncurses since 2013:
  // `clear` clears both visible screen and scrollback. Disable to keep history
  // across `clear` (matches iTerm2 default and pre-2013 behavior).
  clearWipesScrollback: boolean;

  // When true, typing on the keyboard does NOT clear an existing mouse
  // selection. Lets the user select text, type a command prefix (e.g. `sz `),
  // and then paste the still-live selection. xterm.js's default is to clear
  // on input; this opt-in toggle restores the selection right after.
  preserveSelectionOnInput: boolean;

  // When the final visible output line from a command is not terminated by a
  // newline, move a recognized shell prompt to the next visual line. This is
  // display-only; raw session logs keep the original byte stream.
  forcePromptNewLine: boolean;

  // Clipboard
  osc52Clipboard: 'off' | 'write-only' | 'read-write' | 'prompt'; // OSC-52 clipboard access: off, write-only (default), read-write, or prompt on read

  // Tab titles
  dynamicTabTitleMode: DynamicTabTitleMode; // off, agent-only, or all shell-reported titles

  // Rendering
  rendererType: 'auto' | 'webgl' | 'dom'; // Terminal renderer: auto (detect based on hardware), webgl, or dom
  /** Dispose xterm for hidden tabs after a delay to save renderer memory; SSH stays connected. */
  hibernateHiddenTabs: boolean;
  /** Seconds after a tab leaves view before hibernating (see hibernateHiddenTabs). */
  hibernateHiddenTabsDelaySec: number;
  /** Skip full hibernate while a full-screen TUI owns the alternate screen buffer. */
  hibernateSkipAltScreen: boolean;
  /** Hidden tabs whose renderer is kept alive (WebGL suspended) before full hibernate. */
  hibernateKeepRendererCount: number;
  /** Bytes per animation frame when replaying hibernate snapshots in the renderer. */
  hibernateReplayChunkBytes: number;
  /** Prefer WASM terminal serialize when available (falls back to JS). */
  hibernatePreferWasmSerialize: boolean;
  showLineTimestamps: boolean; // Show output timestamps in a side gutter

  // Autocomplete
  autocompleteEnabled: boolean; // Enable terminal command autocomplete
  autocompleteGhostText: boolean; // Show inline ghost text suggestions (like fish shell)
  autocompletePopupMenu: boolean; // Show popup menu with multiple suggestions
  autocompleteDebounceMs: number; // Debounce delay for fetching suggestions (ms)
  autocompleteMinChars: number; // Minimum characters before showing suggestions
  autocompleteMaxSuggestions: number; // Maximum suggestions in popup menu
}

const STRICT_IPV4_OCTET_PATTERN = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

const URL_HIGHLIGHT_PATTERN =
  "(?:\\bhttps?:\\/\\/\\[[0-9A-Fa-f:.]+\\](?::\\d+)?(?:[/?#][^\\s<>\"'`]*)?(?<![.,;:!?\\)}])|\\b(?:https?:\\/\\/|www\\.)[^\\s<>\"'`]+(?<![.,;:!?\\])}]))";
const IPV4_HIGHLIGHT_PATTERN =
  `(?<![\\w.])(?<!\\bver\\s)(?<!\\bversion\\s)(?:${STRICT_IPV4_OCTET_PATTERN}\\.){3}${STRICT_IPV4_OCTET_PATTERN}(?![\\w.])`;
// Covers full and compressed forms (1:2:3:4:5:6:7:8, fe80::1, ::1, 2001:db8::,
// etc.). Bracketed `[…]:port` URLs are matched by URL_HIGHLIGHT_PATTERN.
// Zone IDs (%eth0) and IPv4-mapped (::ffff:192.0.2.1) are intentionally out
// of scope here — add them as custom patterns if you need them.
const IPV6_HIGHLIGHT_PATTERN =
  '(?<![\\w:.])' +
  '(?:' +
    '(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,7}:' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}' +
    '|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}' +
    '|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}' +
  ')' +
  '(?![\\w:.])';
const MAC_ADDRESS_HIGHLIGHT_PATTERN =
  '\\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b';

export const DEFAULT_KEYWORD_HIGHLIGHT_RULES: KeywordHighlightRule[] = [
  { id: 'error', label: 'Error', patterns: ['\\[error\\]', '\\[err\\]', '\\berror\\b', '\\bfail(ed)?\\b', '\\bfatal\\b', '\\bcritical\\b', '\\bexception\\b'], color: '#F87171', enabled: true },
  { id: 'warning', label: 'Warning', patterns: ['\\[warn(ing)?\\]', '\\bwarn(ing)?\\b', '\\bcaution\\b', '\\bdeprecated\\b'], color: '#FBBF24', enabled: true },
  { id: 'ok', label: 'OK', patterns: ['\\[ok\\]', '\\bok\\b', '\\bsuccess(ful)?\\b', '\\bpassed\\b', '\\bcompleted\\b', '\\bdone\\b'], color: '#34D399', enabled: true },
  { id: 'info', label: 'Info', patterns: ['\\[info\\]', '\\[notice\\]', '\\[note\\]', '\\bnotice\\b', '\\bnote\\b'], color: '#3B82F6', enabled: true },
  { id: 'debug', label: 'Debug', patterns: ['\\[debug\\]', '\\[trace\\]', '\\[verbose\\]', '\\bdebug\\b', '\\btrace\\b', '\\bverbose\\b'], color: '#A78BFA', enabled: true },
  { id: 'ip-mac', label: 'URL, IP & MAC', patterns: [URL_HIGHLIGHT_PATTERN, IPV4_HIGHLIGHT_PATTERN, IPV6_HIGHLIGHT_PATTERN, MAC_ADDRESS_HIGHLIGHT_PATTERN], color: '#EC4899', enabled: true },
];

const cloneKeywordHighlightRule = (rule: KeywordHighlightRule): KeywordHighlightRule => ({
  ...rule,
  patterns: [...rule.patterns],
});

const normalizeKeywordHighlightRules = (
  rules?: KeywordHighlightRule[],
): KeywordHighlightRule[] => {
  if (!rules || rules.length === 0) {
    return DEFAULT_KEYWORD_HIGHLIGHT_RULES.map(cloneKeywordHighlightRule);
  }

  const defaultRulesById = new Map(
    DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((rule) => [rule.id, rule] as const),
  );

  const normalizedRules = rules.map((rule) => {
    const defaultRule = defaultRulesById.get(rule.id);
    if (!defaultRule) {
      return cloneKeywordHighlightRule(rule);
    }

    // A built-in rule the user has explicitly edited keeps its label/patterns;
    // otherwise we re-sync with the latest defaults so newly shipped patterns
    // (e.g. the IPv6 entry in `ip-mac`) propagate to existing users without
    // a manual reset.
    if (rule.customized) {
      return {
        ...defaultRule,
        label: rule.label,
        patterns: [...rule.patterns],
        color: rule.color,
        enabled: rule.enabled,
        customized: true,
      };
    }

    return {
      ...defaultRule,
      color: rule.color,
      enabled: rule.enabled,
    };
  });

  const existingRuleIds = new Set(normalizedRules.map((rule) => rule.id));
  for (const defaultRule of DEFAULT_KEYWORD_HIGHLIGHT_RULES) {
    if (!existingRuleIds.has(defaultRule.id)) {
      normalizedRules.push(cloneKeywordHighlightRule(defaultRule));
    }
  }

  return normalizedRules;
};

const isMiddleClickBehavior = (value: unknown): value is MiddleClickBehavior => (
  value === 'context-menu' ||
  value === 'paste' ||
  value === 'disabled'
);

const resolveMiddleClickBehavior = (
  settings?: Partial<TerminalSettings> | null,
): MiddleClickBehavior => {
  if (isMiddleClickBehavior(settings?.middleClickBehavior)) {
    return settings.middleClickBehavior;
  }

  if (
    settings &&
    Object.prototype.hasOwnProperty.call(settings, 'middleClickPaste') &&
    settings.middleClickPaste === false
  ) {
    return 'disabled';
  }

  return DEFAULT_TERMINAL_SETTINGS.middleClickBehavior;
};

const isDynamicTabTitleMode = (value: unknown): value is DynamicTabTitleMode => (
  value === 'off' ||
  value === 'agent' ||
  value === 'all'
);

export const normalizeTerminalSettings = (
  settings?: Partial<TerminalSettings> | null,
): TerminalSettings => {
  const middleClickBehavior = resolveMiddleClickBehavior(settings);
  const wordSeparators = typeof settings?.wordSeparators === 'string'
    ? settings.wordSeparators
    : DEFAULT_TERMINAL_SETTINGS.wordSeparators;
  const shiftEnterNewlineText = typeof settings?.shiftEnterNewlineText === 'string'
    ? settings.shiftEnterNewlineText
    : DEFAULT_TERMINAL_SETTINGS.shiftEnterNewlineText;
  const mergedSettings = {
    ...DEFAULT_TERMINAL_SETTINGS,
    ...(settings ?? {}),
    middleClickBehavior,
    middleClickPaste: middleClickBehavior === 'paste',
    wordSeparators,
    shiftEnterNewlineText,
    dynamicTabTitleMode: isDynamicTabTitleMode(settings?.dynamicTabTitleMode)
      ? settings.dynamicTabTitleMode
      : DEFAULT_TERMINAL_SETTINGS.dynamicTabTitleMode,
  };

  // Migrate legacy 'canvas' renderer to 'dom' (canvas removed in xterm.js 6.0)
  const rendererType = (mergedSettings.rendererType as string) === 'canvas'
    ? 'dom' as const
    : mergedSettings.rendererType;

  return {
    ...mergedSettings,
    rendererType,
    hibernateHiddenTabsDelaySec: normalizeHibernateHiddenTabsDelaySec(
      mergedSettings.hibernateHiddenTabsDelaySec,
    ),
    hibernateKeepRendererCount: normalizeHibernateKeepRendererCount(
      mergedSettings.hibernateKeepRendererCount,
    ),
    hibernateReplayChunkBytes: normalizeHibernateReplayChunkBytes(
      mergedSettings.hibernateReplayChunkBytes,
    ),
    autocompleteGhostText: mergedSettings.autocompletePopupMenu
      ? false
      : mergedSettings.autocompleteGhostText,
    keywordHighlightRules: normalizeKeywordHighlightRules(
      mergedSettings.keywordHighlightRules,
    ),
  };
};

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollback: 10000,
  drawBoldInBrightColors: true,
  terminalEmulationType: 'xterm-256color',
  startupCommandDelayMs: 600,
  fontLigatures: true,
  fontSmoothing: true,
  fontWeight: 400,
  fontWeightBold: 700,
  linePadding: 0,
  fallbackFont: '',
  cursorShape: 'block',
  cursorBlink: true,
  minimumContrastRatio: 1,
  altAsMeta: false,
  optionArrowWordJump: false,
  shiftEnterNewlineEnabled: true,
  shiftEnterNewlineText: '\\n',
  scrollOnInput: true,
  scrollOnOutput: false,
  scrollOnKeyPress: false,
  scrollOnPaste: true,
  smoothScrolling: false,
  rightClickBehavior: 'context-menu',
  middleClickBehavior: 'paste',
  copyOnSelect: false,
  middleClickPaste: true,
  wordSeparators: DEFAULT_TERMINAL_WORD_SEPARATORS,
  linkModifier: 'none',
  keywordHighlightEnabled: true,
  keywordHighlightRules: DEFAULT_KEYWORD_HIGHLIGHT_RULES,
  localShell: '', // Empty = use system default
  localShellArgs: [], // Launch args for a custom local shell (empty = bridge default args)
  localStartDir: '', // Empty = use home directory
  // Cloud-friendly defaults: 30s interval keeps NAT/LB state tables alive,
  // and 10 unanswered keepalives provides headroom for brief network glitches
  // before declaring the session dead (~5 min). Hosts whose SSH stack doesn't
  // reply to keepalive@openssh.com (older routers/switches) should set their
  // own per-host keepaliveOverride and dial these values down.
  verifyHostKeys: true,
  keepaliveInterval: 30,
  keepaliveCountMax: 10,
  sshAutoReconnectEnabled: false,
  x11Display: '', // Empty = use DISPLAY/default local X server
  moshClientPath: '', // Legacy mosh-client override; normal UI uses bundled mosh-client
  showHostInfoBar: true, // Preserve the existing host information bar by default
  showServerStats: true, // Show server stats by default
  serverStatsRefreshInterval: 5, // Refresh every 5 seconds
  systemManagerProcessRefreshInterval: 3,
  systemManagerTmuxRefreshInterval: 3,
  systemManagerDockerListRefreshInterval: 5,
  systemManagerDockerStatsRefreshInterval: 3,
  disableBracketedPaste: false, // Bracketed paste enabled by default
  clearWipesScrollback: true, // POSIX-standard: shell `clear` clears scrollback too
  preserveSelectionOnInput: false, // Opt-in: keep selection alive when typing
  forcePromptNewLine: false, // Opt-in: keep the next shell prompt visually separated from unterminated final output lines
  osc52Clipboard: 'write-only', // OSC-52: allow remote programs to write clipboard by default
  dynamicTabTitleMode: 'agent',
  rendererType: 'auto', // Auto-detect best renderer based on hardware
  hibernateHiddenTabs: false,
  hibernateHiddenTabsDelaySec: 5,
  hibernateSkipAltScreen: true,
  hibernateKeepRendererCount: 2,
  hibernateReplayChunkBytes: 16 * 1024,
  hibernatePreferWasmSerialize: false,
  showLineTimestamps: false, // Opt-in: shows output timestamps beside terminal lines
  autocompleteEnabled: true, // Autocomplete enabled by default
  autocompleteGhostText: false, // Mutually exclusive with popup menu
  autocompletePopupMenu: true, // Popup menu enabled by default
  autocompleteDebounceMs: 100, // 100ms debounce
  autocompleteMinChars: 1, // Start suggesting after 1 character
  autocompleteMaxSuggestions: 8, // Show up to 8 suggestions
};

export interface TerminalTheme {
  id: string;
  name: string;
  type: 'dark' | 'light';
  isCustom?: boolean;
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
  /** Script to auto-run after connect (multi-host script runner). */
  pendingScriptId?: string;
  /** Snapshot used by "Run now" so unsaved editor changes run exactly as shown. */
  pendingScript?: Snippet;
  startupCommand?: string; // Command to run after connection (for snippet runner)
  noAutoRun?: boolean;     // If true, paste command without auto-executing
  multiLineRunMode?: Snippet['multiLineRunMode'];
  // Connection-time protocol overrides (used instead of looking up from hosts)
  protocol?: 'ssh' | 'telnet' | 'local' | 'serial';
  port?: number;
  moshEnabled?: boolean;
  etEnabled?: boolean;
  shellType?: 'posix' | 'fish' | 'powershell' | 'cmd' | 'unknown';
  charset?: string; // Connection-time charset override (e.g. for quick-connect serial)
  // Serial-specific connection settings
  serialConfig?: SerialConfig;
  localShell?: string;       // Shell command for local terminals (from discovery)
  localShellArgs?: string[]; // Shell args for local terminals (from discovery)
  localShellName?: string;   // Display name for local shell (e.g., "Zsh", "Ubuntu (WSL)")
  localShellIcon?: string;   // Icon identifier for local shell (e.g., "zsh", "ubuntu")
  localStartDir?: string;    // Per-session starting directory for local terminals
  // For sessions created from an existing SSH session: the id of the source
  // session whose already-authenticated connection should be reused so the new
  // shell channel does not trigger a second MFA prompt (issue #1204). The
  // bridge reuses the source connection when it is still live, otherwise it
  // falls back to a fresh connection — so this also applies on reconnect: a
  // reconnect reuses the source again if still connected, else dials fresh.
  reuseConnectionFromSessionId?: string;
  // Per-pane font size override (workspace splits only; not persisted to vault hosts).
  fontSize?: number;
  fontSizeOverride?: boolean;
  /** User-assigned display name for this terminal session (overrides hostLabel in UI) */
  customName?: string;
  /** Runtime shell-reported window title (OSC 0/2), shown on tabs when enabled */
  dynamicTitle?: string;
  /** Sticky coding CLI provider detected from launch command or window title */
  codingCliProviderId?: CodingCliProviderId;
  /** Runtime marker for sessions reconstructed from startup restore. */
  restoreState?: 'restored-disconnected';
  /**
   * Runtime marker for sessions backed by an in-memory-only host (e.g. a
   * password deep link). Excluded from session restore persistence because
   * the one-time credentials cannot survive a relaunch.
   */
  ephemeralHost?: boolean;
  /** Runtime hint to auto-open a side panel once the session connects. */
  autoOpenSidePanel?: 'sftp';
  /** Latest known working directory captured from terminal cwd tracking. */
  lastCwd?: string;
}
