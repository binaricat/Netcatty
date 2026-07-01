import type { TerminalTheme } from '../../domain/models';
import { TERMINAL_THEMES, getBuiltinTerminalThemeById } from '../../infrastructure/config/terminalThemes';
import {
  applyCustomAccentToTerminalTheme,
  resolveFollowAppTerminalThemeId,
  resolveManualTerminalThemeId,
} from '../../domain/terminalAppearance';

interface ResolveCurrentTerminalThemeParams {
  terminalThemeId: string;
  terminalThemeDarkId: string;
  terminalThemeLightId: string;
  customThemes: TerminalTheme[];
  followAppTerminalTheme: boolean;
  pendingFollowAppTerminalThemeId?: string | null;
  resolvedTheme: 'light' | 'dark';
  lightUiThemeId: string;
  darkUiThemeId: string;
  accentMode: 'theme' | 'custom';
  customAccent: string;
}

export function resolveCurrentTerminalTheme({
  terminalThemeId,
  terminalThemeDarkId,
  terminalThemeLightId,
  customThemes,
  followAppTerminalTheme,
  pendingFollowAppTerminalThemeId = null,
  resolvedTheme,
  lightUiThemeId,
  darkUiThemeId,
  accentMode,
  customAccent,
}: ResolveCurrentTerminalThemeParams): TerminalTheme {
  if (followAppTerminalTheme) {
    const followedId = resolveFollowAppTerminalThemeId(pendingFollowAppTerminalThemeId, {
      resolvedTheme,
      lightUiThemeId,
      darkUiThemeId,
      fallbackThemeId: terminalThemeId,
    });
    const followed = getBuiltinTerminalThemeById(followedId)
      || customThemes.find(t => t.id === followedId);
    if (followed) {
      return applyCustomAccentToTerminalTheme(followed, accentMode, customAccent);
    }
  }
  const manualThemeId = resolveManualTerminalThemeId({
    resolvedTheme,
    terminalThemeDarkId,
    terminalThemeLightId,
    lightUiThemeId,
    darkUiThemeId,
    fallbackThemeId: terminalThemeId,
  });
  const baseTheme = getBuiltinTerminalThemeById(manualThemeId)
    || customThemes.find(t => t.id === manualThemeId)
    || getBuiltinTerminalThemeById(terminalThemeId)
    || customThemes.find(t => t.id === terminalThemeId)
    || TERMINAL_THEMES[0];
  return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
}
