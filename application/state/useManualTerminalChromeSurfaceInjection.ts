import { useLayoutEffect, useRef } from 'react';

import type { TerminalTheme } from '../../domain/models';
import { applyTopTabsChromeThemeVars } from '../app/topTabsChromeTheme';
import {
  clearTerminalLayerChromeSurfaceVars,
  injectTerminalLayerChromeSurfaceVars,
} from '../../infrastructure/theme/terminalAppearanceVars';

/** Manual mode: side panel + host tree follow the focused session theme, not the global default. */
export function useManualTerminalChromeSurfaceInjection(
  theme: TerminalTheme,
  enabled: boolean,
): void {
  const prevEnabledRef = useRef(enabled);
  useLayoutEffect(() => {
    const wasEnabled = prevEnabledRef.current;
    prevEnabledRef.current = enabled;
    if (enabled) {
      injectTerminalLayerChromeSurfaceVars(theme);
      applyTopTabsChromeThemeVars(theme);
      return;
    }
    if (wasEnabled) {
      clearTerminalLayerChromeSurfaceVars();
    }
  }, [enabled, theme.id, theme]);
}
