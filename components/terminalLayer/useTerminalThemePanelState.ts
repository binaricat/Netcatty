import { startTransition, useCallback, useMemo, useRef, useState } from 'react';

import {
  applyCustomAccentToTerminalTheme,
  clearHostFontFamilyOverride,
  clearHostFontSizeOverride,
  clearHostFontWeightOverride,
  clearHostThemeOverride,
  hasHostFontFamilyOverride,
  hasHostFontSizeOverride,
  hasHostFontWeightOverride,
  hasHostThemeOverride,
  resolveHostTerminalFontFamilyId,
  resolveHostTerminalFontSize,
  resolveHostTerminalFontWeight,
  resolveHostTerminalThemeId,
} from '../../domain/terminalAppearance';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { useCustomThemes } from '../../application/state/customThemeStore';
import { getScopedTopTabsThemeId } from '../terminalTopTabsTheme';
import {
  adjustLightnessToken,
  adjustSaturationToken,
  clearTerminalPreviewVars,
  clearTopTabsPreviewVars,
  hexToHslToken,
  setStylePropertyIfChanged,
} from './TerminalLayerSupport';

interface UseTerminalThemePanelStateOptions {
  accentMode: 'theme' | 'custom';
  activeSession: TerminalSession | undefined;
  activeSidePanelTab: 'sftp' | 'scripts' | 'theme' | 'ai' | null;
  activeWorkspace: Workspace | undefined;
  customAccent: string;
  followAppTerminalTheme: boolean;
  focusedSessionId: string | undefined;
  fontSize: number;
  hostMap: Map<string, Host>;
  isVisible: boolean;
  onUpdateHost: (host: Host) => void;
  onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
  onUpdateTerminalFontSize?: (fontSize: number) => void;
  onUpdateTerminalFontWeight?: (fontWeight: number) => void;
  onUpdateTerminalThemeId?: (themeId: string) => void;
  sessionHostsMap: Map<string, Host>;
  terminalFontFamilyId: string;
  terminalSettings?: { fontWeight?: number };
  terminalTheme: TerminalTheme;
}

export function useTerminalThemePanelState({
  accentMode,
  activeSession,
  activeSidePanelTab,
  activeWorkspace,
  customAccent,
  followAppTerminalTheme,
  focusedSessionId,
  fontSize,
  hostMap,
  isVisible,
  onUpdateHost,
  onUpdateTerminalFontFamilyId,
  onUpdateTerminalFontSize,
  onUpdateTerminalFontWeight,
  onUpdateTerminalThemeId,
  sessionHostsMap,
  terminalFontFamilyId,
  terminalSettings,
  terminalTheme,
}: UseTerminalThemePanelStateOptions) {
  const [themePreview, setThemePreview] = useState<{ targetSessionId: string | null; themeId: string | null }>({
      targetSessionId: null,
      themeId: null,
    });
  
  const themeCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Resolve theme change handler for the focused session
    const focusedHost = useMemo((): Host | null => {
      if (activeWorkspace && focusedSessionId) {
        return sessionHostsMap.get(focusedSessionId) ?? null;
      }
      if (activeSession) {
        return sessionHostsMap.get(activeSession.id) ?? null;
      }
      return null;
    }, [activeWorkspace, focusedSessionId, activeSession, sessionHostsMap]);
  
  const isFocusedHostLocal = useMemo(() => {
      return focusedHost?.protocol === 'local' || !!focusedHost?.id?.startsWith('local-');
    }, [focusedHost]);
  
  // Hosts not in the persisted hostMap (e.g. quick-connect) are ephemeral —
    // sidebar appearance changes should update global settings, not per-host overrides.
    const isFocusedHostEphemeral = useMemo(() => {
      if (isFocusedHostLocal) return true;
      if (!focusedHost) return true;
      return !hostMap.has(focusedHost.id);
    }, [focusedHost, isFocusedHostLocal, hostMap]);
  
  const rawFocusedHost = useMemo(() => {
      if (!focusedHost) return null;
      return hostMap.get(focusedHost.id) ?? null;
    }, [focusedHost, hostMap]);
  
  const previewTargetSessionId = activeWorkspace?.focusedSessionId ?? activeSession?.id ?? null;
  
  const activeThemePreviewId = themePreview.targetSessionId === previewTargetSessionId
      ? themePreview.themeId
      : null;
  
  // Current theme/font/size for the focused session (for ThemeSidePanel)
    const focusedThemeId = resolveHostTerminalThemeId(focusedHost, terminalTheme.id);
  
  const focusedFontFamilyId = resolveHostTerminalFontFamilyId(focusedHost, terminalFontFamilyId);
  
  const focusedFontSize = resolveHostTerminalFontSize(focusedHost, fontSize);
  
  const focusedThemeOverridden = hasHostThemeOverride(focusedHost);
  
  const focusedFontFamilyOverridden = hasHostFontFamilyOverride(focusedHost);
  
  const focusedFontSizeOverridden = hasHostFontSizeOverride(focusedHost);
  
  const focusedFontWeight = resolveHostTerminalFontWeight(focusedHost, terminalSettings?.fontWeight ?? 400);
  
  const focusedFontWeightOverridden = hasHostFontWeightOverride(focusedHost);
  
  const visibleFocusedThemeId = followAppTerminalTheme ? terminalTheme.id : focusedThemeId;
  
  const previewedOrVisibleThemeId = activeThemePreviewId ?? visibleFocusedThemeId;
  
  const activeTopTabsThemeId = useMemo(
      () =>
        getScopedTopTabsThemeId({
          activeSidePanelTab,
          activeThemePreviewId,
          activeWorkspace,
          followAppTerminalTheme,
          isVisible,
          previewTargetSessionId,
          previewedOrVisibleThemeId,
          resolveSessionThemeId: (sessionId) => {
            const host = sessionHostsMap.get(sessionId) ?? null;
            return followAppTerminalTheme ? terminalTheme.id : resolveHostTerminalThemeId(host, terminalTheme.id);
          },
        }),
      [
        activeSidePanelTab,
        activeThemePreviewId,
        activeWorkspace,
        followAppTerminalTheme,
        isVisible,
        previewTargetSessionId,
        previewedOrVisibleThemeId,
        sessionHostsMap,
        terminalTheme.id,
      ],
    );
  
  const appliedPreviewSessionRef = useRef<string | null>(null);
  
  const customThemes = useCustomThemes();
  
  const applyTerminalPreviewVars = useCallback((sessionId: string | null, themeId: string | null) => {
      if (!sessionId || !themeId || typeof document === 'undefined') {
        clearTerminalPreviewVars(sessionId);
        return;
      }
      const pane = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
      const baseTheme = TERMINAL_THEMES.find((entry) => entry.id === themeId)
        || customThemes.find((entry) => entry.id === themeId);
      if (!pane || !baseTheme) {
        clearTerminalPreviewVars(sessionId);
        return;
      }
      const theme = applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
  
      pane.style.setProperty('--terminal-preview-bg', theme.colors.background);
      pane.style.setProperty('--terminal-preview-fg', theme.colors.foreground);
      pane.style.setProperty('--terminal-preview-border', `color-mix(in srgb, ${theme.colors.foreground} 8%, ${theme.colors.background} 92%)`);
      pane.style.setProperty('--terminal-preview-toolbar-btn', `color-mix(in srgb, ${theme.colors.background} 88%, ${theme.colors.foreground} 12%)`);
      pane.style.setProperty('--terminal-preview-toolbar-btn-hover', `color-mix(in srgb, ${theme.colors.background} 78%, ${theme.colors.foreground} 22%)`);
      pane.style.setProperty('--terminal-preview-toolbar-btn-active', `color-mix(in srgb, ${theme.colors.cursor} 78%, ${theme.colors.background} 22%)`);
    }, [accentMode, customAccent, customThemes]);
  
  const applyTopTabsPreviewVars = useCallback((themeId: string | null) => {
      if (!themeId || typeof document === 'undefined') {
        clearTopTabsPreviewVars();
        return;
      }
      const tabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
      const baseTheme = TERMINAL_THEMES.find((entry) => entry.id === themeId)
        || customThemes.find((entry) => entry.id === themeId);
      if (!tabsRoot || !baseTheme) {
        clearTopTabsPreviewVars();
        return;
      }
      const theme = applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
      const bg = hexToHslToken(theme.colors.background);
      const fg = hexToHslToken(theme.colors.foreground);
      const accent = hexToHslToken(theme.colors.cursor);
      const isDark = theme.type === 'dark';
      const secondary = adjustLightnessToken(bg, isDark ? 6 : -5);
      const border = adjustLightnessToken(bg, isDark ? 12 : -10);
      const mutedFg = adjustSaturationToken(adjustLightnessToken(fg, isDark ? -20 : 20), 0.5);
  
      setStylePropertyIfChanged(tabsRoot, '--background', bg);
      setStylePropertyIfChanged(tabsRoot, '--foreground', fg);
      setStylePropertyIfChanged(tabsRoot, '--accent', accent);
      setStylePropertyIfChanged(tabsRoot, '--primary', accent);
      setStylePropertyIfChanged(tabsRoot, '--secondary', secondary);
      setStylePropertyIfChanged(tabsRoot, '--border', border);
      setStylePropertyIfChanged(tabsRoot, '--muted-foreground', mutedFg);
      setStylePropertyIfChanged(tabsRoot, '--top-tabs-bg', 'hsl(var(--secondary))');
      setStylePropertyIfChanged(tabsRoot, '--top-tabs-fg', 'hsl(var(--foreground))');
      setStylePropertyIfChanged(tabsRoot, '--top-tabs-muted', 'hsl(var(--muted-foreground))');
      setStylePropertyIfChanged(tabsRoot, '--top-tabs-active-bg', 'hsl(var(--background))');
      setStylePropertyIfChanged(tabsRoot, '--top-tabs-accent', 'hsl(var(--accent))');
    }, [accentMode, customAccent, customThemes]);
  
  const handleThemeChangeForFocusedSession = useCallback((themeId: string) => {
      if (!focusedHost || themeId === previewedOrVisibleThemeId) return;
      applyTerminalPreviewVars(previewTargetSessionId, themeId);
      applyTopTabsPreviewVars(themeId);
      setThemePreview({ targetSessionId: previewTargetSessionId, themeId });
      if (themeCommitTimerRef.current) {
        clearTimeout(themeCommitTimerRef.current);
      }
      themeCommitTimerRef.current = setTimeout(() => {
        startTransition(() => {
          if (isFocusedHostEphemeral) {
            onUpdateTerminalThemeId?.(themeId);
            return;
          }
          if (rawFocusedHost) {
            onUpdateHost({ ...rawFocusedHost, theme: themeId, themeOverride: true });
          }
        });
      }, 160);
    }, [applyTerminalPreviewVars, applyTopTabsPreviewVars, focusedHost, isFocusedHostEphemeral, onUpdateTerminalThemeId, onUpdateHost, previewTargetSessionId, previewedOrVisibleThemeId, rawFocusedHost]);
  
  const handleThemeResetForFocusedSession = useCallback(() => {
      if (themeCommitTimerRef.current) {
        clearTimeout(themeCommitTimerRef.current);
      }
      clearTerminalPreviewVars(previewTargetSessionId);
      setThemePreview({ targetSessionId: null, themeId: null });
      if (!focusedHost || isFocusedHostEphemeral || !rawFocusedHost) return;
      onUpdateHost(clearHostThemeOverride(rawFocusedHost));
    }, [focusedHost, isFocusedHostEphemeral, onUpdateHost, previewTargetSessionId, rawFocusedHost]);
  
  const handleFontFamilyChangeForFocusedSession = useCallback((fontFamilyId: string) => {
      if (!focusedHost || fontFamilyId === focusedFontFamilyId) return;
      startTransition(() => {
        if (isFocusedHostEphemeral) {
          onUpdateTerminalFontFamilyId?.(fontFamilyId);
          return;
        }
        if (rawFocusedHost) {
          onUpdateHost({ ...rawFocusedHost, fontFamily: fontFamilyId, fontFamilyOverride: true });
        }
      });
    }, [focusedHost, focusedFontFamilyId, isFocusedHostEphemeral, onUpdateTerminalFontFamilyId, onUpdateHost, rawFocusedHost]);
  
  const handleFontFamilyResetForFocusedSession = useCallback(() => {
      if (!focusedHost || isFocusedHostEphemeral || !rawFocusedHost) return;
      onUpdateHost(clearHostFontFamilyOverride(rawFocusedHost));
    }, [focusedHost, isFocusedHostEphemeral, onUpdateHost, rawFocusedHost]);
  
  const handleFontSizeChangeForFocusedSession = useCallback((newFontSize: number) => {
      if (!focusedHost || newFontSize === focusedFontSize) return;
      startTransition(() => {
        if (isFocusedHostEphemeral) {
          onUpdateTerminalFontSize?.(newFontSize);
          return;
        }
        if (rawFocusedHost) {
          onUpdateHost({ ...rawFocusedHost, fontSize: newFontSize, fontSizeOverride: true });
        }
      });
    }, [focusedHost, focusedFontSize, isFocusedHostEphemeral, onUpdateTerminalFontSize, onUpdateHost, rawFocusedHost]);
  
  const handleFontSizeResetForFocusedSession = useCallback(() => {
      if (!focusedHost || isFocusedHostEphemeral || !rawFocusedHost) return;
      onUpdateHost(clearHostFontSizeOverride(rawFocusedHost));
    }, [focusedHost, isFocusedHostEphemeral, onUpdateHost, rawFocusedHost]);
  
  const handleFontWeightChangeForFocusedSession = useCallback((newFontWeight: number) => {
      if (!focusedHost || newFontWeight === focusedFontWeight) return;
      startTransition(() => {
        if (isFocusedHostEphemeral) {
          onUpdateTerminalFontWeight?.(newFontWeight);
          return;
        }
        // Prefer raw (un-merged) host to avoid flattening group defaults
        const rawHost = hostMap.get(focusedHost.id);
        if (rawHost) {
          onUpdateHost({ ...rawHost, fontWeight: newFontWeight, fontWeightOverride: true });
        }
      });
    }, [focusedHost, focusedFontWeight, isFocusedHostEphemeral, onUpdateTerminalFontWeight, onUpdateHost, hostMap]);
  
  const handleFontWeightResetForFocusedSession = useCallback(() => {
      if (!focusedHost || isFocusedHostEphemeral) return;
      const rawHost = hostMap.get(focusedHost.id);
      if (rawHost) {
        onUpdateHost(clearHostFontWeightOverride(rawHost));
      }
    }, [focusedHost, isFocusedHostEphemeral, onUpdateHost, hostMap]);
  
  const resolvedPreviewTheme = useMemo(() => {
      const themeId = previewedOrVisibleThemeId;
      const baseTheme = TERMINAL_THEMES.find((theme) => theme.id === themeId)
        || customThemes.find((theme) => theme.id === themeId)
        || terminalTheme;
      return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
    }, [accentMode, customAccent, customThemes, previewedOrVisibleThemeId, terminalTheme]);
  
  // Resolve the effective theme for the compose bar in workspace mode
    const composeBarThemeColors = useMemo(() => {
      if (!activeWorkspace || !focusedSessionId) return terminalTheme.colors;
      return resolvedPreviewTheme.colors;
    }, [activeWorkspace, focusedSessionId, resolvedPreviewTheme, terminalTheme.colors]);

  return {
    activeTopTabsThemeId,
    appliedPreviewSessionRef,
    applyTerminalPreviewVars,
    applyTopTabsPreviewVars,
    composeBarThemeColors,
    focusedFontFamilyId,
    focusedFontFamilyOverridden,
    focusedFontSize,
    focusedFontSizeOverridden,
    focusedFontWeight,
    focusedFontWeightOverridden,
    focusedThemeOverridden,
    handleFontFamilyChangeForFocusedSession,
    handleFontFamilyResetForFocusedSession,
    handleFontSizeChangeForFocusedSession,
    handleFontSizeResetForFocusedSession,
    handleFontWeightChangeForFocusedSession,
    handleFontWeightResetForFocusedSession,
    handleThemeChangeForFocusedSession,
    handleThemeResetForFocusedSession,
    previewedOrVisibleThemeId,
    previewTargetSessionId,
    resolvedPreviewTheme,
    setThemePreview,
    themeCommitTimerRef,
    themePreview,
    visibleFocusedThemeId,
  };
}
