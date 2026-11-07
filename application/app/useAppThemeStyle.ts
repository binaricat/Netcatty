import { usePluginThemeRevision } from '../state/usePluginThemeRuntime';
import type React from 'react';
import { useMemo } from 'react';

import { useAppearanceChromeStore } from '../state/appearanceChromeStore';
import { useSettingsChromeStore } from '../state/settingsChromeStore';
import { buildAppThemeCssVars } from '../state/settingsStateDefaults';
import { getUiThemeById } from '../../infrastructure/config/uiThemes';

/**
 * App theme CSS variables for surfaces that need them (vault surface, plugin
 * theme tokens). Reads accent from appearanceChromeStore and UI theme ids from
 * settingsChromeStore so accent drags only re-render the leaf that applies the
 * vars, never the App shell.
 */
export function useAppThemeStyle(includePreview = true): React.CSSProperties {
  const pluginThemeRevision = usePluginThemeRevision();
  const { accentMode, customAccent } = useAppearanceChromeStore();
  const { resolvedTheme, darkUiThemeId, lightUiThemeId } = useSettingsChromeStore();
  return useMemo(() => {
    void pluginThemeRevision; // getUiThemeById reads this external registry revision.
    const tokens = getUiThemeById(
      resolvedTheme,
      resolvedTheme === 'dark' ? darkUiThemeId : lightUiThemeId,
      includePreview,
    ).tokens;
    return {
      ...buildAppThemeCssVars(tokens, accentMode, customAccent),
      colorScheme: resolvedTheme,
    } as React.CSSProperties;
  }, [accentMode, customAccent, darkUiThemeId, lightUiThemeId, resolvedTheme, pluginThemeRevision, includePreview]);
}
