import { startTransition, useCallback, useEffect, useMemo } from 'react';

import type { ResolvedAppearance, TerminalAppearanceHostScope } from '../../domain/terminalAppearanceRuntime';
import {
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
import { isSavedVaultHost } from '../../domain/ephemeralHosts';
import { isSameResolvedTerminalFont } from '../../infrastructure/config/fonts';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { getScopedTopTabsThemeId } from '../terminalTopTabsTheme';
import type { SidePanelTab } from './TerminalLayerSupport';

const navigatorPlatform = typeof navigator !== 'undefined' ? navigator.platform : '';

interface UseTerminalThemePanelStateOptions {
  accentMode: 'theme' | 'custom';
  activeSession: TerminalSession | undefined;
  activeSidePanelTab: SidePanelTab | null;
  activeWorkspace: Workspace | undefined;
  clearIntent: () => void;
  customAccent: string;
  followAppTerminalTheme: boolean;
  focusedSessionId: string | undefined;
  fontSize: number;
  hostMap: Map<string, Host>;
  isSidePanelOpenForCurrentTab: boolean;
  isVisible: boolean;
  onUpdateHost: (host: Host) => void;
  onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
  onUpdateTerminalFontSize?: (fontSize: number) => void;
  onUpdateTerminalFontWeight?: (fontWeight: number) => void;
  onUpdateTerminalThemeId?: (themeId: string) => void;
  onUpdateSessionFontSize?: (sessionId: string, fontSize: number) => void;
  onClearSessionFontSizeOverride?: (sessionId: string) => void;
  pickTheme: (themeId: string) => void;
  resolveFocusedAppearance: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  sessionHostsMap: Map<string, Host>;
  terminalFontFamilyId: string;
  terminalSettings?: { fontWeight?: number };
  terminalTheme: TerminalTheme;
}

export function useTerminalThemePanelState({
  activeSession,
  activeSidePanelTab,
  activeWorkspace,
  clearIntent,
  followAppTerminalTheme,
  focusedSessionId,
  fontSize,
  hostMap,
  isSidePanelOpenForCurrentTab,
  isVisible,
  onUpdateHost,
  onUpdateTerminalFontFamilyId,
  onUpdateTerminalFontSize,
  onUpdateTerminalFontWeight,
  onUpdateTerminalThemeId,
  onUpdateSessionFontSize,
  onClearSessionFontSizeOverride,
  pickTheme,
  resolveFocusedAppearance,
  sessionHostsMap,
  terminalFontFamilyId,
  terminalSettings,
  terminalTheme,
}: UseTerminalThemePanelStateOptions) {
  useEffect(() => {
    if (isSidePanelOpenForCurrentTab) {
      if (!followAppTerminalTheme && activeSidePanelTab !== 'theme') {
        clearIntent();
      }
      return;
    }
    clearIntent();
  }, [activeSidePanelTab, clearIntent, followAppTerminalTheme, isSidePanelOpenForCurrentTab]);

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

  const isFocusedHostEphemeral = useMemo(() => {
    if (isFocusedHostLocal) return true;
    if (!focusedHost) return true;
    return !isSavedVaultHost(hostMap.get(focusedHost.id));
  }, [focusedHost, isFocusedHostLocal, hostMap]);

  const rawFocusedHost = useMemo(() => {
    if (!focusedHost) return null;
    return hostMap.get(focusedHost.id) ?? null;
  }, [focusedHost, hostMap]);

  const focusedHostScope = useMemo((): TerminalAppearanceHostScope => ({
    host: focusedHost,
    isEphemeral: isFocusedHostEphemeral,
  }), [focusedHost, isFocusedHostEphemeral]);

  const focusedAppearance = useMemo(
    () => resolveFocusedAppearance(focusedHostScope),
    [resolveFocusedAppearance, focusedHostScope],
  );

  const previewTargetSessionId = activeWorkspace?.focusedSessionId ?? activeSession?.id ?? null;

  const focusedThemeId = resolveHostTerminalThemeId(focusedHost, terminalTheme.id);
  const focusedFontFamilyId = resolveHostTerminalFontFamilyId(focusedHost, terminalFontFamilyId);
  const focusedFontSize = resolveHostTerminalFontSize(focusedHost, fontSize);
  const focusedThemeOverridden = hasHostThemeOverride(focusedHost);
  const focusedFontFamilyOverridden = hasHostFontFamilyOverride(focusedHost);
  const focusedFontSizeOverridden = hasHostFontSizeOverride(focusedHost);
  const focusedFontWeight = resolveHostTerminalFontWeight(focusedHost, terminalSettings?.fontWeight ?? 400);
  const focusedFontWeightOverridden = hasHostFontWeightOverride(focusedHost);
  const visibleFocusedThemeId = followAppTerminalTheme ? terminalTheme.id : focusedThemeId;
  const listSelectedThemeId = followAppTerminalTheme
    ? terminalTheme.id
    : focusedAppearance.themeId;
  const previewedOrVisibleThemeId = listSelectedThemeId;
  const resolvedPreviewTheme = focusedAppearance.theme;

  const activeTopTabsThemeId = useMemo(
    () => getScopedTopTabsThemeId({
      activeSidePanelTab,
      activeThemePreviewId: null,
      activeWorkspace,
      followAppTerminalTheme,
      isVisible,
      previewTargetSessionId,
      previewedOrVisibleThemeId,
      resolveSessionThemeId: (sessionId) => {
        const host = sessionHostsMap.get(sessionId) ?? null;
        const isEphemeral = !host || !isSavedVaultHost(hostMap.get(host.id));
        return resolveFocusedAppearance({ host, isEphemeral }).themeId;
      },
    }),
    [
      activeSidePanelTab,
      activeWorkspace,
      followAppTerminalTheme,
      hostMap,
      isVisible,
      previewTargetSessionId,
      previewedOrVisibleThemeId,
      resolveFocusedAppearance,
      sessionHostsMap,
    ],
  );

  const handleThemeChangeForFocusedSession = useCallback((themeId: string) => {
    if (themeId === listSelectedThemeId) return;
    if (!focusedHost && !followAppTerminalTheme) return;

    if (followAppTerminalTheme) {
      pickTheme(themeId);
      return;
    }

    pickTheme(themeId, {
      followApp: false,
      scopeHostId: rawFocusedHost?.id ?? focusedHost?.id ?? null,
    });
    if (isFocusedHostEphemeral) {
      onUpdateTerminalThemeId?.(themeId);
    } else if (rawFocusedHost) {
      onUpdateHost({ ...rawFocusedHost, theme: themeId, themeOverride: true });
    }
  }, [
    focusedHost,
    followAppTerminalTheme,
    isFocusedHostEphemeral,
    listSelectedThemeId,
    onUpdateHost,
    onUpdateTerminalThemeId,
    pickTheme,
    rawFocusedHost,
  ]);

  const handleThemeResetForFocusedSession = useCallback(() => {
    clearIntent();
    if (!focusedHost || isFocusedHostEphemeral || !rawFocusedHost) return;
    onUpdateHost(clearHostThemeOverride(rawFocusedHost));
  }, [clearIntent, focusedHost, isFocusedHostEphemeral, onUpdateHost, rawFocusedHost]);

  const handleFontFamilyChangeForFocusedSession = useCallback((fontFamilyId: string) => {
    if (!focusedHost || isSameResolvedTerminalFont(fontFamilyId, focusedFontFamilyId, navigatorPlatform)) return;
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
      if (activeWorkspace && focusedSessionId) {
        onUpdateSessionFontSize?.(focusedSessionId, newFontSize);
        return;
      }
      if (isFocusedHostEphemeral) {
        // Ephemeral hosts cannot persist host-level overrides; keep the
        // change per-session (same path Ctrl+zoom uses) when possible.
        const targetSessionId = focusedSessionId ?? activeSession?.id;
        if (targetSessionId) {
          onUpdateSessionFontSize?.(targetSessionId, newFontSize);
          return;
        }
        onUpdateTerminalFontSize?.(newFontSize);
        return;
      }
      if (rawFocusedHost) {
        onUpdateHost({ ...rawFocusedHost, fontSize: newFontSize, fontSizeOverride: true });
      }
    });
  }, [activeSession, activeWorkspace, focusedHost, focusedFontSize, focusedSessionId, isFocusedHostEphemeral, onUpdateSessionFontSize, onUpdateTerminalFontSize, onUpdateHost, rawFocusedHost]);

  const handleFontSizeResetForFocusedSession = useCallback(() => {
    if (!focusedHost) return;
    if (activeWorkspace && focusedSessionId) {
      onClearSessionFontSizeOverride?.(focusedSessionId);
      return;
    }
    if (isFocusedHostEphemeral) {
      const targetSessionId = focusedSessionId ?? activeSession?.id;
      if (targetSessionId) onClearSessionFontSizeOverride?.(targetSessionId);
      return;
    }
    if (!rawFocusedHost) return;
    onUpdateHost(clearHostFontSizeOverride(rawFocusedHost));
  }, [activeSession, activeWorkspace, focusedHost, focusedSessionId, isFocusedHostEphemeral, onClearSessionFontSizeOverride, onUpdateHost, rawFocusedHost]);

  const handleFontWeightChangeForFocusedSession = useCallback((newFontWeight: number) => {
    if (!focusedHost || newFontWeight === focusedFontWeight) return;
    startTransition(() => {
      if (isFocusedHostEphemeral) {
        onUpdateTerminalFontWeight?.(newFontWeight);
        return;
      }
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

  const composeBarThemeColors = useMemo(() => {
    if (!activeWorkspace || !focusedSessionId) return terminalTheme.colors;
    return resolvedPreviewTheme.colors;
  }, [activeWorkspace, focusedSessionId, resolvedPreviewTheme.colors, terminalTheme.colors]);

  return {
    activeTopTabsThemeId,
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
    visibleFocusedThemeId,
  };
}
