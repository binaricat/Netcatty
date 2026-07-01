import { Host, TerminalSession, TerminalTheme } from './models';

export type TerminalHostUpdate = Pick<Host, 'id'> & Partial<Host>;

const hasLegacyStringValue = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const hasLegacyNumberValue = (value: number | undefined): boolean =>
  typeof value === 'number' && !Number.isNaN(value);

const hasEffectiveOverride = (
  explicitOverride: boolean | undefined,
  legacyValuePresent: boolean,
): boolean => explicitOverride === true || (explicitOverride === undefined && legacyValuePresent);

export const hasHostThemeOverride = (host?: Pick<Host, 'themeOverride' | 'theme'> | null): boolean =>
  hasEffectiveOverride(host?.themeOverride, hasLegacyStringValue(host?.theme));

export const hasHostFontFamilyOverride = (host?: Pick<Host, 'fontFamilyOverride' | 'fontFamily'> | null): boolean =>
  hasEffectiveOverride(host?.fontFamilyOverride, hasLegacyStringValue(host?.fontFamily));

export const hasHostFontSizeOverride = (host?: Pick<Host, 'fontSizeOverride' | 'fontSize'> | null): boolean =>
  hasEffectiveOverride(host?.fontSizeOverride, hasLegacyNumberValue(host?.fontSize));

export const clearHostThemeOverride = (host: Host): Host => ({
  ...host,
  theme: undefined,
  themeOverride: false,
});

export const clearHostFontFamilyOverride = (host: Host): Host => ({
  ...host,
  fontFamily: undefined,
  fontFamilyOverride: false,
});

export const clearHostFontSizeOverride = (host: Host): Host => ({
  ...host,
  fontSize: undefined,
  fontSizeOverride: false,
});

export const mergeTerminalHostUpdate = (
  savedHost: Host,
  terminalHostUpdate: TerminalHostUpdate,
): Host => {
  const nextHost: Host = {
    ...savedHost,
    ...terminalHostUpdate,
    id: savedHost.id,
    protocol: savedHost.protocol,
    port: savedHost.port,
    moshEnabled: savedHost.moshEnabled,
  };

  if (!Object.prototype.hasOwnProperty.call(savedHost, 'protocol')) delete nextHost.protocol;
  if (!Object.prototype.hasOwnProperty.call(savedHost, 'port')) delete nextHost.port;
  if (!Object.prototype.hasOwnProperty.call(savedHost, 'moshEnabled')) delete nextHost.moshEnabled;

  return nextHost;
};

export const resolveHostTerminalThemeId = (host: Host | null | undefined, defaultThemeId: string): string =>
  hasHostThemeOverride(host) && host?.theme ? host.theme : defaultThemeId;

/**
 * Map a UI theme preset ID to the terminal theme whose background matches
 * it exactly. Used when "Follow Application Theme" is enabled so the
 * terminal blends seamlessly with the app chrome. Returns undefined if no
 * match exists (caller should fall back to the global terminal theme).
 */
const CORE_LIGHT_UI_TO_TERMINAL_THEME: Record<string, string> = {
  'snow': 'ui-snow',
  'pure-white': 'ui-pure-white',
  'ivory': 'ui-ivory',
  'mist': 'ui-mist',
  'mint': 'ui-mint',
  'sand': 'ui-sand',
  'lavender': 'ui-lavender',
};

const CORE_DARK_UI_TO_TERMINAL_THEME: Record<string, string> = {
  'pure-black': 'ui-pure-black',
  'midnight': 'ui-midnight',
  'deep-blue': 'ui-deep-blue',
  'vscode': 'ui-vscode',
  'graphite': 'ui-graphite',
  'obsidian': 'ui-obsidian',
  'forest': 'ui-forest',
};

const UI_TO_TERMINAL_THEME: Record<string, string> = {
  ...CORE_LIGHT_UI_TO_TERMINAL_THEME,
  ...CORE_DARK_UI_TO_TERMINAL_THEME,
};

const SYSTEM_LIGHT_UI_TO_TERMINAL_THEME: Record<string, string> = {
  "a-cup-of-coffee": "system-a-cup-of-coffee-light",
  "abolkog": "system-abolkog-light",
  "aurora": "system-aurora-light",
  "ayu": "system-ayu-light",
  "base16-flat": "system-base16-flat-light",
  "base16-mocha": "system-base16-mocha-light",
  "blue-dolphin": "system-blue-dolphin-light",
  "calm-days-sober-nights-sky": "system-calm-days-sober-nights-sky-light",
  "catppuccin": "system-catppuccin-light",
  "chai": "system-chai-light",
  "chinolor": "system-chinolor-light",
  "cyberdyne": "system-cyberdyne-light",
  "desert": "system-desert-light",
  "django-reborn-again": "system-django-reborn-again-light",
  "espresso": "system-espresso-light",
  "eyehealth": "system-eyehealth-light",
  "flexoki": "system-flexoki-light",
  "fox": "system-fox-light",
  "garbage-oracle": "system-garbage-oracle-light",
  "github": "system-github-light",
  "gruvbox-material": "system-gruvbox-material-light",
  "homebrew": "system-homebrew-light",
  "ic-orange-ppl": "system-ic-orange-ppl-light",
  "ikki": "system-ikki-light",
  "kanso-ink": "system-kanso-ink-light",
  "kary-pro-colors": "system-kary-pro-colors-light",
  "light-purple": "system-light-purple-light",
  "mondrian": "system-mondrian-light",
  "monochrome": "system-monochrome-light",
  "monochrome-stone": "system-monochrome-stone-light",
  "monokai-pro-spectrum": "system-monokai-pro-spectrum-light",
  "monospace": "system-monospace-light",
  "noctis-azureus": "system-noctis-azureus-light",
  "noctis-hibernus": "system-noctis-hibernus-light",
  "noir-essence": "system-noir-essence-light",
  "nord-midnight": "system-nord-midnight-light",
  "notionish": "system-notionish-light",
  "phonebook": "system-phonebook-light",
  "polychrome": "system-polychrome-light",
  "purplepeter": "system-purplepeter-light",
  "rainglow-codecourse": "system-rainglow-codecourse-light",
  "rainglow-crisp": "system-rainglow-crisp-light",
  "rainglow-lavender": "system-rainglow-lavender-light",
  "remedy-tilted": "system-remedy-tilted-light",
  "rose-pine": "system-rose-pine-light",
  "selene-selenized": "system-selene-selenized-light",
  "soft-color": "system-soft-color-light",
  "tearout": "system-tearout-light",
  "tokyo-night": "system-tokyo-night-light",
  "tomorrow-night-eighties": "system-tomorrow-night-eighties-light",
  "vaporizer-turquoise": "system-vaporizer-turquoise-light",
  "xotopio": "system-xotopio-light",
  "yuttari": "system-yuttari-light",
  "zenbones-rosebones": "system-zenbones-rosebones-light",
  "zhxo-red": "system-zhxo-red-light",
};

const SYSTEM_DARK_UI_TO_TERMINAL_THEME: Record<string, string> = {
  "a-cup-of-coffee": "system-a-cup-of-coffee-dark",
  "abolkog": "system-abolkog-dark",
  "aurora": "system-aurora-dark",
  "ayu": "system-ayu-dark",
  "base16-flat": "system-base16-flat-dark",
  "base16-mocha": "system-base16-mocha-dark",
  "blue-dolphin": "system-blue-dolphin-dark",
  "calm-days-sober-nights-sky": "system-calm-days-sober-nights-sky-dark",
  "catppuccin": "system-catppuccin-dark",
  "chai": "system-chai-dark",
  "chinolor": "system-chinolor-dark",
  "cyberdyne": "system-cyberdyne-dark",
  "desert": "system-desert-dark",
  "django-reborn-again": "system-django-reborn-again-dark",
  "espresso": "system-espresso-dark",
  "eyehealth": "system-eyehealth-dark",
  "flexoki": "system-flexoki-dark",
  "fox": "system-fox-dark",
  "garbage-oracle": "system-garbage-oracle-dark",
  "github": "system-github-dark",
  "gruvbox-material": "system-gruvbox-material-dark",
  "homebrew": "system-homebrew-dark",
  "ic-orange-ppl": "system-ic-orange-ppl-dark",
  "ikki": "system-ikki-dark",
  "kanso-ink": "system-kanso-ink-dark",
  "kary-pro-colors": "system-kary-pro-colors-dark",
  "light-purple": "system-light-purple-dark",
  "mondrian": "system-mondrian-dark",
  "monochrome": "system-monochrome-dark",
  "monochrome-stone": "system-monochrome-stone-dark",
  "monokai-pro-spectrum": "system-monokai-pro-spectrum-dark",
  "monospace": "system-monospace-dark",
  "noctis-azureus": "system-noctis-azureus-dark",
  "noctis-hibernus": "system-noctis-hibernus-dark",
  "noir-essence": "system-noir-essence-dark",
  "nord-midnight": "system-nord-midnight-dark",
  "notionish": "system-notionish-dark",
  "phonebook": "system-phonebook-dark",
  "polychrome": "system-polychrome-dark",
  "purplepeter": "system-purplepeter-dark",
  "rainglow-codecourse": "system-rainglow-codecourse-dark",
  "rainglow-crisp": "system-rainglow-crisp-dark",
  "rainglow-lavender": "system-rainglow-lavender-dark",
  "remedy-tilted": "system-remedy-tilted-dark",
  "rose-pine": "system-rose-pine-dark",
  "selene-selenized": "system-selene-selenized-dark",
  "soft-color": "system-soft-color-dark",
  "tearout": "system-tearout-dark",
  "tokyo-night": "system-tokyo-night-dark",
  "tomorrow-night-eighties": "system-tomorrow-night-eighties-dark",
  "vaporizer-turquoise": "system-vaporizer-turquoise-dark",
  "xotopio": "system-xotopio-dark",
  "yuttari": "system-yuttari-dark",
  "zenbones-rosebones": "system-zenbones-rosebones-dark",
  "zhxo-red": "system-zhxo-red-dark",
};

export const getTerminalThemeForUiTheme = (uiThemeId: string, resolvedTheme?: 'light' | 'dark'): string | undefined => {
  if (resolvedTheme === 'light') return SYSTEM_LIGHT_UI_TO_TERMINAL_THEME[uiThemeId] ?? UI_TO_TERMINAL_THEME[uiThemeId];
  if (resolvedTheme === 'dark') return SYSTEM_DARK_UI_TO_TERMINAL_THEME[uiThemeId] ?? UI_TO_TERMINAL_THEME[uiThemeId];
  return UI_TO_TERMINAL_THEME[uiThemeId];
};

export type FollowAppTerminalThemeSelection = {
  appTheme: TerminalTheme['type'];
  uiThemeId: string;
};

const createTerminalThemeToUiThemeMap = (): Record<string, FollowAppTerminalThemeSelection> => {
  const entries: Array<[string, FollowAppTerminalThemeSelection]> = [];
  for (const [uiThemeId, terminalThemeId] of Object.entries(CORE_LIGHT_UI_TO_TERMINAL_THEME)) {
    entries.push([terminalThemeId, { appTheme: 'light', uiThemeId }]);
  }
  for (const [uiThemeId, terminalThemeId] of Object.entries(CORE_DARK_UI_TO_TERMINAL_THEME)) {
    entries.push([terminalThemeId, { appTheme: 'dark', uiThemeId }]);
  }
  for (const [uiThemeId, terminalThemeId] of Object.entries(SYSTEM_LIGHT_UI_TO_TERMINAL_THEME)) {
    entries.push([terminalThemeId, { appTheme: 'light', uiThemeId }]);
  }
  for (const [uiThemeId, terminalThemeId] of Object.entries(SYSTEM_DARK_UI_TO_TERMINAL_THEME)) {
    entries.push([terminalThemeId, { appTheme: 'dark', uiThemeId }]);
  }
  return Object.fromEntries(entries);
};

const TERMINAL_THEME_TO_UI_THEME = createTerminalThemeToUiThemeMap();

export const getFollowAppTerminalThemeIds = (type?: TerminalTheme['type']): string[] =>
  Object.entries(TERMINAL_THEME_TO_UI_THEME)
    .filter(([, selection]) => !type || selection.appTheme === type)
    .map(([terminalThemeId]) => terminalThemeId);

export const isFollowAppTerminalThemeId = (themeId: string): boolean =>
  Object.prototype.hasOwnProperty.call(TERMINAL_THEME_TO_UI_THEME, themeId);

export const getFollowAppTerminalThemeSelectionUpdate = (
  themeId: string,
): FollowAppTerminalThemeSelection | null =>
  TERMINAL_THEME_TO_UI_THEME[themeId] ?? null;

/**
 * Sentinel stored in the per-mode manual terminal theme settings. It means
 * the user has not chosen a concrete terminal theme for that mode yet, so the
 * app can use the UI-matched default.
 */
export const TERMINAL_THEME_AUTO = 'auto';

/**
 * Resolve which terminal theme id to use while "Follow Application Theme" is
 * enabled. This is intentionally not overrideable: the terminal follows the
 * active UI theme preset, then `fallbackThemeId` when no UI match exists.
 */
export const resolveFollowedTerminalThemeId = (args: {
  resolvedTheme: 'light' | 'dark';
  lightUiThemeId: string;
  darkUiThemeId: string;
  fallbackThemeId: string;
}): string => {
  const activeUiThemeId = args.resolvedTheme === 'dark'
    ? args.darkUiThemeId
    : args.lightUiThemeId;
  return getTerminalThemeForUiTheme(activeUiThemeId, args.resolvedTheme) ?? args.fallbackThemeId;
};

/** Resolve a follow-app sidebar pick using the target mode, not the current resolvedTheme. */
export const resolveFollowAppTerminalThemeId = (
  pendingTerminalThemeId: string | null | undefined,
  args: {
    resolvedTheme: 'light' | 'dark';
    lightUiThemeId: string;
    darkUiThemeId: string;
    fallbackThemeId: string;
  },
): string => {
  if (pendingTerminalThemeId && isFollowAppTerminalThemeId(pendingTerminalThemeId)) {
    return pendingTerminalThemeId;
  }
  return resolveFollowedTerminalThemeId(args);
};

export const getFollowAppThemePickExpectedSettledId = (
  pendingTerminalThemeId: string,
): string | null => {
  const selection = getFollowAppTerminalThemeSelectionUpdate(pendingTerminalThemeId);
  if (!selection) return null;
  return getTerminalThemeForUiTheme(selection.uiThemeId, selection.appTheme) ?? pendingTerminalThemeId;
};

export const isFollowAppThemePickSettled = (
  pendingTerminalThemeId: string,
  args: {
    resolvedTheme: 'light' | 'dark';
    lightUiThemeId: string;
    darkUiThemeId: string;
    fallbackThemeId: string;
  },
): boolean => {
  const selection = getFollowAppTerminalThemeSelectionUpdate(pendingTerminalThemeId);
  if (!selection) return true;
  if (args.resolvedTheme !== selection.appTheme) return false;
  const activeUiThemeId = selection.appTheme === 'dark'
    ? args.darkUiThemeId
    : args.lightUiThemeId;
  if (activeUiThemeId !== selection.uiThemeId) return false;
  return resolveFollowedTerminalThemeId(args) === pendingTerminalThemeId;
};

export const resolveManualTerminalThemeId = (args: {
  resolvedTheme: 'light' | 'dark';
  terminalThemeDarkId: string;
  terminalThemeLightId: string;
  lightUiThemeId: string;
  darkUiThemeId: string;
  fallbackThemeId: string;
}): string => {
  const selected = args.resolvedTheme === 'dark'
    ? args.terminalThemeDarkId
    : args.terminalThemeLightId;
  if (selected && selected !== TERMINAL_THEME_AUTO) return selected;
  return args.fallbackThemeId;
};

type ParsedHslToken = {
  hue: number;
  saturation: number;
  lightness: number;
};

const parseHslToken = (value: string): ParsedHslToken | null => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return null;

  const hue = Number(match[1]);
  const saturation = Number(match[2]);
  const lightness = Number(match[3]);
  if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(lightness)) return null;
  if (saturation < 0 || saturation > 100 || lightness < 0 || lightness > 100) return null;

  return {
    hue: ((hue % 360) + 360) % 360,
    saturation,
    lightness,
  };
};

const toHexChannel = (value: number): string =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0');

const hslToHex = ({ hue, saturation, lightness }: ParsedHslToken): string => {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const m = l - c / 2;
  return `#${toHexChannel((r + m) * 255)}${toHexChannel((g + m) * 255)}${toHexChannel((b + m) * 255)}`;
};

const terminalSelectionFromAccent = (accent: ParsedHslToken, type: TerminalTheme['type']): ParsedHslToken => ({
  ...accent,
  lightness: type === 'dark'
    ? Math.max(18, Math.min(32, accent.lightness * 0.55))
    : Math.max(72, Math.min(88, accent.lightness + 42)),
});

export const applyCustomAccentToTerminalTheme = (
  theme: TerminalTheme,
  accentMode: 'theme' | 'custom',
  customAccent: string,
): TerminalTheme => {
  if (accentMode !== 'custom') return theme;

  const accent = parseHslToken(customAccent);
  if (!accent) return theme;

  return {
    ...theme,
    colors: {
      ...theme.colors,
      cursor: hslToHex(accent),
      selection: hslToHex(terminalSelectionFromAccent(accent, theme.type)),
    },
  };
};

export const resolveHostTerminalFontFamilyId = (host: Host | null | undefined, defaultFontFamilyId: string): string =>
  hasHostFontFamilyOverride(host) && host?.fontFamily ? host.fontFamily : defaultFontFamilyId;

export const resolveHostTerminalFontSize = (host: Host | null | undefined, defaultFontSize: number): number =>
  hasHostFontSizeOverride(host) && host?.fontSize != null ? host.fontSize : defaultFontSize;

export const hasSessionFontSizeOverride = (
  session?: Pick<TerminalSession, 'fontSizeOverride' | 'fontSize'> | null,
): boolean => hasHostFontSizeOverride(session);

export const applySessionFontSizeToHost = (host: Host, session?: TerminalSession): Host => {
  if (!session || !hasSessionFontSizeOverride(session) || session.fontSize == null) {
    return host;
  }
  return { ...host, fontSize: session.fontSize, fontSizeOverride: true };
};

export const clearSessionFontSizeOverride = (session: TerminalSession): TerminalSession => ({
  ...session,
  fontSize: undefined,
  fontSizeOverride: false,
});

export const hasHostFontWeightOverride = (host?: Pick<Host, 'fontWeightOverride' | 'fontWeight'> | null): boolean =>
  hasEffectiveOverride(host?.fontWeightOverride, hasLegacyNumberValue(host?.fontWeight));

export const clearHostFontWeightOverride = (host: Host): Host => ({
  ...host,
  fontWeight: undefined,
  fontWeightOverride: false,
});

export const resolveHostTerminalFontWeight = (host: Host | null | undefined, defaultFontWeight: number): number =>
  hasHostFontWeightOverride(host) && host?.fontWeight != null ? host.fontWeight : defaultFontWeight;
