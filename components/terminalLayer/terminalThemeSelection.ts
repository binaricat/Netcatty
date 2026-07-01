import type { TerminalThemePreviewState } from './terminalThemePreview';

/** Which preview theme id applies to the current focus scope (list highlight in manual mode). */
export function resolveActiveThemePreviewId(
  themePreview: TerminalThemePreviewState,
  previewTargetSessionId: string | null,
  previewTargetHostId: string | null,
): string | null {
  if (!themePreview.themeId) return null;
  if (themePreview.globalPreview) return themePreview.themeId;
  if (themePreview.targetSessionId === previewTargetSessionId) return themePreview.themeId;
  if (
    themePreview.targetHostId
    && previewTargetHostId
    && themePreview.targetHostId === previewTargetHostId
  ) {
    return themePreview.themeId;
  }
  return null;
}

/** Single source of truth for the theme list checkmark / footer label. */
export function resolveThemeListSelectionId(options: {
  followAppTerminalTheme: boolean;
  followAppPendingThemeId: string | null | undefined;
  terminalThemeId: string;
  themePreview: TerminalThemePreviewState;
  previewTargetSessionId: string | null;
  previewTargetHostId: string | null;
  focusedThemeId: string;
}): string {
  if (options.followAppTerminalTheme) {
    return options.followAppPendingThemeId ?? options.terminalThemeId;
  }
  return resolveActiveThemePreviewId(
    options.themePreview,
    options.previewTargetSessionId,
    options.previewTargetHostId,
  ) ?? options.focusedThemeId;
}
