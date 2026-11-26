import React, { useEffect, useMemo } from 'react';

import { PluginContributionHost } from '../../components/plugins/PluginContributionHost';
import {
  isRemoteDesktopGrabReleaseChord,
  isTargetInsideRemoteDesktopCapture,
} from '../../components/remoteDesktop/remoteDesktopHelpers';
import type { TerminalSession, Workspace } from '../../types';
import { useActiveTabId } from '../state/activeTabStore';
import { resolveActivePluginKeybindingContext } from '../state/pluginContributionContexts';
import { getAISessionsSnapshot } from '../state/aiSessionsStore';
import { getPersistedAiSessionsSnapshot } from '../state/aiStateSnapshots';

/**
 * Leaf host for plugin keybindings so AppView does not subscribe to activeTabId.
 * Tab switches only re-render this small surface (and plugin lifecycle), not the shell.
 */
export function AppPluginKeybindingHost({
  locale,
  theme,
  themeTokens,
  sessions,
  workspaces,
}: {
  locale: string;
  theme: string;
  themeTokens?: Record<string, string>;
  sessions: TerminalSession[];
  workspaces: Workspace[];
}) {
  const activeTabId = useActiveTabId();

  // Short-circuit plugin keybindings when keyboard focus is inside an active
  // remote desktop capture surface (except for the grab-release chord).
  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (!isTargetInsideRemoteDesktopCapture(event.target, event.composedPath?.bind(event))) {
        return;
      }
      if (isRemoteDesktopGrabReleaseChord(event)) return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, []);

  const keybindingContext = useMemo(() => {
    // AI chat recency drives the workspace anchor fallback (#4098 phase 2).
    // Read without subscribing: keybinding context is best-effort and refreshes
    // on every tab/session/workspaces change that matters here.
    const live = getAISessionsSnapshot().sessions;
    const aiSessions = live.length > 0 ? live : getPersistedAiSessionsSnapshot();
    return resolveActivePluginKeybindingContext({
      activeTabId,
      sessions,
      workspaces,
      aiSessions,
    });
  }, [activeTabId, sessions, workspaces]);

  return (
    <PluginContributionHost
      locale={locale}
      theme={theme}
      themeTokens={themeTokens}
      keybindingContext={keybindingContext}
    />
  );
}
