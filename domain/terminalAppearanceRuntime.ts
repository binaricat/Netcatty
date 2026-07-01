import type { Host, TerminalTheme } from './models';
import {
  applyCustomAccentToTerminalTheme,
  getFollowAppTerminalThemeSelectionUpdate,
  isFollowAppTerminalThemeId,
  resolveFollowedTerminalThemeId,
  resolveHostTerminalThemeId,
  resolveManualTerminalThemeId,
  type FollowAppTerminalThemeSelection,
} from './terminalAppearance';
import { TERMINAL_THEMES, getBuiltinTerminalThemeById } from '../infrastructure/config/terminalThemes';

export type ThemeUserIntent =
  | { kind: 'idle' }
  | { kind: 'picking'; themeId: string; startedAt: number; scopeHostId?: string | null };

export type AppearanceSource = 'intent' | 'follow-app' | 'host-override' | 'manual-global';

export type ResolvedAppearance = {
  themeId: string;
  theme: TerminalTheme;
  source: AppearanceSource;
  appThemeUpdate: FollowAppTerminalThemeSelection | null;
};

export type TerminalAppearanceSettings = {
  terminalThemeId: string;
  terminalThemeDarkId: string;
  terminalThemeLightId: string;
  followAppTerminalTheme: boolean;
  resolvedTheme: 'light' | 'dark';
  lightUiThemeId: string;
  darkUiThemeId: string;
  accentMode: 'theme' | 'custom';
  customAccent: string;
};

export type TerminalAppearanceHostScope = {
  host: Host | null;
  isEphemeral: boolean;
};

export type ResolveTerminalAppearanceInput = {
  userIntent: ThemeUserIntent;
  settings: TerminalAppearanceSettings;
  hostScope: TerminalAppearanceHostScope;
  customThemes: TerminalTheme[];
};

export const idleThemeUserIntent = (): ThemeUserIntent => ({ kind: 'idle' });

export const pickingThemeUserIntent = (
  themeId: string,
  options?: { startedAt?: number; scopeHostId?: string | null },
): ThemeUserIntent => ({
  kind: 'picking',
  themeId,
  startedAt: options?.startedAt ?? Date.now(),
  ...(options?.scopeHostId !== undefined ? { scopeHostId: options.scopeHostId } : {}),
});

export function isFollowAppIntentSettled(
  themeId: string,
  settings: Pick<
    TerminalAppearanceSettings,
    'resolvedTheme' | 'lightUiThemeId' | 'darkUiThemeId' | 'terminalThemeId'
  >,
): boolean {
  const selection = getFollowAppTerminalThemeSelectionUpdate(themeId);
  if (!selection) return true;
  if (settings.resolvedTheme !== selection.appTheme) return false;
  const activeUiThemeId = selection.appTheme === 'dark'
    ? settings.darkUiThemeId
    : settings.lightUiThemeId;
  if (activeUiThemeId !== selection.uiThemeId) return false;
  return resolveFollowedTerminalThemeId({
    resolvedTheme: settings.resolvedTheme,
    lightUiThemeId: settings.lightUiThemeId,
    darkUiThemeId: settings.darkUiThemeId,
    fallbackThemeId: settings.terminalThemeId,
  }) === themeId;
}

function resolveFollowAppThemeId(
  userIntent: ThemeUserIntent,
  settings: TerminalAppearanceSettings,
): { themeId: string; source: AppearanceSource } {
  if (userIntent.kind === 'picking' && isFollowAppTerminalThemeId(userIntent.themeId)) {
    return { themeId: userIntent.themeId, source: 'intent' };
  }
  const themeId = resolveFollowedTerminalThemeId({
    resolvedTheme: settings.resolvedTheme,
    lightUiThemeId: settings.lightUiThemeId,
    darkUiThemeId: settings.darkUiThemeId,
    fallbackThemeId: settings.terminalThemeId,
  });
  return { themeId, source: 'follow-app' };
}

function resolveManualThemeId(
  userIntent: ThemeUserIntent,
  settings: TerminalAppearanceSettings,
  hostScope: TerminalAppearanceHostScope,
): { themeId: string; source: AppearanceSource } {
  if (userIntent.kind === 'picking') {
    const scopeHostId = userIntent.scopeHostId ?? null;
    const hostId = hostScope.host?.id ?? null;
    if (scopeHostId === null) {
      if (hostScope.isEphemeral || !hostScope.host) {
        return { themeId: userIntent.themeId, source: 'intent' };
      }
    } else if (hostId === scopeHostId) {
      return { themeId: userIntent.themeId, source: 'intent' };
    }
  }

  const globalThemeId = resolveManualTerminalThemeId({
    resolvedTheme: settings.resolvedTheme,
    terminalThemeDarkId: settings.terminalThemeDarkId,
    terminalThemeLightId: settings.terminalThemeLightId,
    lightUiThemeId: settings.lightUiThemeId,
    darkUiThemeId: settings.darkUiThemeId,
    fallbackThemeId: settings.terminalThemeId,
  });

  if (hostScope.isEphemeral || !hostScope.host) {
    return { themeId: globalThemeId, source: 'manual-global' };
  }

  const hostThemeId = resolveHostTerminalThemeId(hostScope.host, globalThemeId);
  if (hostThemeId !== globalThemeId) {
    return { themeId: hostThemeId, source: 'host-override' };
  }
  return { themeId: globalThemeId, source: 'manual-global' };
}

function lookupTheme(themeId: string, customThemes: TerminalTheme[]): TerminalTheme {
  return getBuiltinTerminalThemeById(themeId)
    || customThemes.find((theme) => theme.id === themeId)
    || getBuiltinTerminalThemeById(TERMINAL_THEMES[0].id)
    || TERMINAL_THEMES[0];
}

export function resolveTerminalAppearance({
  userIntent,
  settings,
  hostScope,
  customThemes,
}: ResolveTerminalAppearanceInput): ResolvedAppearance {
  const { themeId, source } = settings.followAppTerminalTheme
    ? resolveFollowAppThemeId(userIntent, settings)
    : resolveManualThemeId(userIntent, settings, hostScope);

  const baseTheme = lookupTheme(themeId, customThemes);
  const theme = applyCustomAccentToTerminalTheme(
    baseTheme,
    settings.accentMode,
    settings.customAccent,
  );

  const appThemeUpdate = settings.followAppTerminalTheme && userIntent.kind === 'picking'
    ? getFollowAppTerminalThemeSelectionUpdate(userIntent.themeId)
    : null;

  return {
    themeId,
    theme,
    source,
    appThemeUpdate,
  };
}

export function resolveGlobalTerminalAppearance(
  input: Omit<ResolveTerminalAppearanceInput, 'hostScope'> & {
    hostScope?: TerminalAppearanceHostScope;
  },
): ResolvedAppearance {
  return resolveTerminalAppearance({
    ...input,
    hostScope: input.hostScope ?? { host: null, isEphemeral: true },
  });
}

/** Pane-level theme id for workspace sessions (follow-app ignores host overrides). */
export function resolveSessionAppearanceThemeId(
  followAppTerminalTheme: boolean,
  globalThemeId: string,
  host: Host | null,
): string {
  if (followAppTerminalTheme) return globalThemeId;
  return resolveHostTerminalThemeId(host, globalThemeId);
}
