import { startTransition, useCallback, useEffect, useMemo, useRef } from 'react';

import { useAppearanceChromeStore } from '../../application/state/appearanceChromeStore';
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
  activeSession: TerminalSession | undefined;
  activeSidePanelTab: SidePanelTab | null;
  activeWorkspace: Workspace | undefined;
  clearIntent: () => void;
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

  // Subscribe to accent store so compose-bar / manual chrome recompute when
  // color-picker changes, even though resolveFocusedAppearance identity is
  // intentionally stable across accent drag (and TerminalLayer memo ignores
  // accent props).
  const appearanceChrome = useAppearanceChromeStore();
  const focusedAppearance = useMemo(() => {
    // resolveFocusedAppearance reads accent from the chrome store; pin these
    // deps so compose-bar chrome updates while focusedHostScope stays stable.
    void appearanceChrome.accentMode;
    void appearanceChrome.customAccent;
    return resolveFocusedAppearance(focusedHostScope);
  }, [
    appearanceChrome.accentMode,
    appearanceChrome.customAccent,
    focusedHostScope,
    resolveFocusedAppearance,
  ]);

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

  // Keep latest focus/host/font/theme inputs in a ref updated synchronously on
  // render so all 8 theme/font handlers preserve stable references across tab
  // switches and split-pane focus changes (these handlers live in
  // SIDE_PANEL_STABLE_CTX_KEYS).
  const latestRef = useRef({
    activeSession,
    activeWorkspace,
    clearIntent,
    focusedFontFamilyId,
    focusedFontSize,
    focusedFontWeight,
    focusedHost,
    focusedSessionId,
    followAppTerminalTheme,
    hostMap,
    isFocusedHostEphemeral,
    listSelectedThemeId,
    onClearSessionFontSizeOverride,
    onUpdateHost,
    onUpdateSessionFontSize,
    onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize,
    onUpdateTerminalFontWeight,
    onUpdateTerminalThemeId,
    pickTheme,
    rawFocusedHost,
  });
  latestRef.current = {
    activeSession,
    activeWorkspace,
    clearIntent,
    focusedFontFamilyId,
    focusedFontSize,
    focusedFontWeight,
    focusedHost,
    focusedSessionId,
    followAppTerminalTheme,
    hostMap,
    isFocusedHostEphemeral,
    listSelectedThemeId,
    onClearSessionFontSizeOverride,
    onUpdateHost,
    onUpdateSessionFontSize,
    onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize,
    onUpdateTerminalFontWeight,
    onUpdateTerminalThemeId,
    pickTheme,
    rawFocusedHost,
  };

  const handleThemeChangeForFocusedSession = useCallback((themeId: string) => {
    const {
      focusedHost,
      followAppTerminalTheme,
      isFocusedHostEphemeral,
      listSelectedThemeId,
      onUpdateHost,
      onUpdateTerminalThemeId,
      pickTheme,
      rawFocusedHost,
    } = latestRef.current;
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
  }, []);

  const handleThemeResetForFocusedSession = useCallback(() => {
    const {
      clearIntent,
      focusedHost,
      isFocusedHostEphemeral,
      onUpdateHost,
      rawFocusedHost,
    } = latestRef.current;
    clearIntent();
    if (!focusedHost || isFocusedHostEphemeral || !rawFocusedHost) return;
    onUpdateHost(clearHostThemeOverride(rawFocusedHost));
  }, []);

  const handleFontFamilyChangeForFocusedSession = useCallback((fontFamilyId: string) => {
    // Snapshot target host/session state synchronously before startTransition
    // so a focus change prior to transition commit cannot mutate another host.
    const {
      focusedHost,
      focusedFontFamilyId,
      isFocusedHostEphemeral,
      onUpdateTerminalFontFamilyId,
      onUpdateHost,
      rawFocusedHost,
    } = latestRef.current;
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
  }, []);

  const handleFontFamilyResetForFocusedSession = useCallback(() => {
    const {
      focusedHost,
      isFocusedHostEphemeral,
      onUpdateHost,
      rawFocusedHost,
    } = latestRef.current;
    if (!focusedHost || isFocusedHostEphemeral || !rawFocusedHost) return;
    onUpdateHost(clearHostFontFamilyOverride(rawFocusedHost));
  }, []);

  const handleFontSizeChangeForFocusedSession = useCallback((newFontSize: number) => {
    // Snapshot target host/session state synchronously before startTransition
    // so a focus change prior to transition commit cannot mutate another host.
    const {
      activeSession,
      activeWorkspace,
      focusedHost,
      focusedFontSize,
      focusedSessionId,
      isFocusedHostEphemeral,
      onUpdateSessionFontSize,
      onUpdateTerminalFontSize,
      onUpdateHost,
      rawFocusedHost,
    } = latestRef.current;
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
  }, []);

  const handleFontSizeResetForFocusedSession = useCallback(() => {
    const {
      activeSession,
      activeWorkspace,
      focusedHost,
      focusedSessionId,
      isFocusedHostEphemeral,
      onClearSessionFontSizeOverride,
      onUpdateHost,
      rawFocusedHost,
    } = latestRef.current;
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
  }, []);

  const handleFontWeightChangeForFocusedSession = useCallback((newFontWeight: number) => {
    // Snapshot target host/session state synchronously before startTransition
    // so a focus change prior to transition commit cannot mutate another host.
    const {
      focusedHost,
      focusedFontWeight,
      hostMap,
      isFocusedHostEphemeral,
      onUpdateTerminalFontWeight,
      onUpdateHost,
    } = latestRef.current;
    if (!focusedHost || newFontWeight === focusedFontWeight) return;
    const rawHost = isFocusedHostEphemeral ? undefined : hostMap.get(focusedHost.id);
    startTransition(() => {
      if (isFocusedHostEphemeral) {
        onUpdateTerminalFontWeight?.(newFontWeight);
        return;
      }
      if (rawHost) {
        onUpdateHost({ ...rawHost, fontWeight: newFontWeight, fontWeightOverride: true });
      }
    });
  }, []);

  const handleFontWeightResetForFocusedSession = useCallback(() => {
    const {
      focusedHost,
      hostMap,
      isFocusedHostEphemeral,
      onUpdateHost,
    } = latestRef.current;
    if (!focusedHost || isFocusedHostEphemeral) return;
    const rawHost = hostMap.get(focusedHost.id);
    if (rawHost) {
      onUpdateHost(clearHostFontWeightOverride(rawHost));
    }
  }, []);

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
