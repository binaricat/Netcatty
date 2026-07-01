import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

import type { Host, TerminalTheme } from '../../domain/models';
import {
  idleThemeUserIntent,
  pickingThemeUserIntent,
  resolveGlobalTerminalAppearance,
  resolveTerminalAppearance,
  type ResolvedAppearance,
  type TerminalAppearanceHostScope,
  type TerminalAppearanceSettings,
  type ThemeUserIntent,
} from '../../domain/terminalAppearanceRuntime';
import { getFollowAppTerminalThemeSelectionUpdate } from '../../domain/terminalAppearance';
import {
  injectTerminalAppearanceVars,
} from '../../infrastructure/theme/terminalAppearanceVars';

export type ThemeRuntimeSettings = TerminalAppearanceSettings & {
  customThemes: TerminalTheme[];
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setLightUiThemeId: (id: string) => void;
  setDarkUiThemeId: (id: string) => void;
};

export function useThemeRuntime(settings: ThemeRuntimeSettings) {
  const [userIntent, setUserIntent] = useState<ThemeUserIntent>(idleThemeUserIntent());

  const appearanceSettings = useMemo((): TerminalAppearanceSettings => ({
    terminalThemeId: settings.terminalThemeId,
    terminalThemeDarkId: settings.terminalThemeDarkId,
    terminalThemeLightId: settings.terminalThemeLightId,
    followAppTerminalTheme: settings.followAppTerminalTheme,
    resolvedTheme: settings.resolvedTheme,
    lightUiThemeId: settings.lightUiThemeId,
    darkUiThemeId: settings.darkUiThemeId,
    accentMode: settings.accentMode,
    customAccent: settings.customAccent,
  }), [
    settings.terminalThemeId,
    settings.terminalThemeDarkId,
    settings.terminalThemeLightId,
    settings.followAppTerminalTheme,
    settings.resolvedTheme,
    settings.lightUiThemeId,
    settings.darkUiThemeId,
    settings.accentMode,
    settings.customAccent,
  ]);

  const globalAppearance = useMemo(() => resolveGlobalTerminalAppearance({
    userIntent,
    settings: appearanceSettings,
    customThemes: settings.customThemes,
  }), [userIntent, appearanceSettings, settings.customThemes]);

  const resolveFocusedAppearance = useCallback((hostScope: TerminalAppearanceHostScope): ResolvedAppearance => (
    resolveTerminalAppearance({
      userIntent,
      settings: appearanceSettings,
      hostScope,
      customThemes: settings.customThemes,
    })
  ), [userIntent, appearanceSettings, settings.customThemes]);

  const applyFollowAppSettingsForPick = useCallback((themeId: string) => {
    const update = getFollowAppTerminalThemeSelectionUpdate(themeId);
    if (!update) return false;
    if (update.appTheme === 'dark') {
      settings.setDarkUiThemeId(update.uiThemeId);
    } else {
      settings.setLightUiThemeId(update.uiThemeId);
    }
    settings.setTheme(update.appTheme);
    return true;
  }, [settings]);

  const pickTheme = useCallback((themeId: string, options?: { followApp?: boolean; scopeHostId?: string | null }) => {
    const followApp = options?.followApp ?? settings.followAppTerminalTheme;
    setUserIntent(pickingThemeUserIntent(themeId, {
      scopeHostId: followApp ? undefined : options?.scopeHostId,
    }));
    if (followApp) {
      applyFollowAppSettingsForPick(themeId);
    }
  }, [applyFollowAppSettingsForPick, settings.followAppTerminalTheme]);

  const clearIntent = useCallback(() => {
    setUserIntent(idleThemeUserIntent());
  }, []);

  const settleManualIntent = useCallback(() => {
    setUserIntent(idleThemeUserIntent());
  }, []);

  return {
    userIntent,
    globalAppearance,
    resolveFocusedAppearance,
    pickTheme,
    clearIntent,
    settleManualIntent,
    currentTerminalTheme: globalAppearance.theme,
  };
}

export function useTerminalAppearanceInjection(
  appearance: ResolvedAppearance,
  options?: { includeChromeSurfaces?: boolean },
): void {
  const includeChromeSurfaces = options?.includeChromeSurfaces ?? true;
  useLayoutEffect(() => {
    injectTerminalAppearanceVars(appearance.theme, { includeChromeSurfaces });
  }, [appearance.theme.id, appearance.theme, includeChromeSurfaces]);
}

export function buildHostScope(host: Host | null, isEphemeral: boolean): TerminalAppearanceHostScope {
  return { host, isEphemeral };
}
