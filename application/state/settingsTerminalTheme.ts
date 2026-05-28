import type { TerminalTheme } from '../../domain/models';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { applyCustomAccentToTerminalTheme, resolveFollowedTerminalThemeId } from '../../domain/terminalAppearance';

interface ResolveCurrentTerminalThemeParams {
  terminalThemeId: string;
  terminalThemeDarkId: string;
  terminalThemeLightId: string;
  customThemes: TerminalTheme[];
  followAppTerminalTheme: boolean;
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
  resolvedTheme,
  lightUiThemeId,
  darkUiThemeId,
  accentMode,
  customAccent,
}: ResolveCurrentTerminalThemeParams): TerminalTheme {
  if (followAppTerminalTheme) {
    const followedId = resolveFollowedTerminalThemeId({
      resolvedTheme,
      terminalThemeDarkId,
      terminalThemeLightId,
      lightUiThemeId,
      darkUiThemeId,
      fallbackThemeId: terminalThemeId,
    });
    const followed = TERMINAL_THEMES.find(t => t.id === followedId)
      || customThemes.find(t => t.id === followedId);
    if (followed) {
      return applyCustomAccentToTerminalTheme(followed, accentMode, customAccent);
    }
  }
  const baseTheme = TERMINAL_THEMES.find(t => t.id === terminalThemeId)
    || customThemes.find(t => t.id === terminalThemeId)
    || TERMINAL_THEMES[0];
  return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
}
