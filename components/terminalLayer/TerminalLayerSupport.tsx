import React, { createContext, lazy, memo, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { activeTabStore } from '../../application/state/activeTabStore';
import { useTerminalLayoutSuppressActive } from '../../application/state/terminalLayoutSuppressStore';
import type { TerminalSessionExitEvent } from '../../application/state/resolveTerminalSessionExitIntent';
import { createTerminalSelectionAttachment } from '../../application/state/terminalSelectionAttachment';
import { getTopTabInsertionTarget, isPointInsideRect, WORKSPACE_SESSION_DRAG_TYPE } from '../../application/state/terminalDragData';
import { useAIState } from '../../application/state/useAIState';
import { useStoredBoolean } from '../../application/state/useStoredBoolean';
import { isSavedVaultHost } from '../../domain/ephemeralHosts';
import { collectSessionIds, SplitDirection } from '../../domain/workspace';
import { resolveSessionTabTitle } from '../../domain/sessionTabTitle';
import {
  resolveTerminalHibernateEnabled,
  resolveTerminalHibernateEnabledForProtocol,
} from '../../domain/terminalHibernate';
import { KeyBinding, TerminalSettings } from '../../domain/models';
import { STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION } from '../../infrastructure/config/storageKeys';
import { cn } from '../../lib/utils';
import { LazyLoadBoundary } from '../ui/lazy-load-boundary';
import type { DropEntry } from '../../lib/sftpFileUtils';
import type { GroupConfig, Host, Identity, KnownHost, ProxyProfile, SSHKey, Snippet, TerminalSession, VaultNote, Workspace } from '../../types';
import type { ExecutorContext } from '../../infrastructure/ai/cattyAgent/executor';
import Terminal from '../Terminal';
import { removePaneVisible, setPaneVisible } from '../terminal/paneVisibilityStore';
import type { TerminalBroadcastInputOptions } from '../terminal/terminalHelpers';
import type { TerminalContextReader } from '../../domain/terminalContextRead';
import {
  getTerminalPaneRenderSnapshot,
  parseTerminalPaneRenderSnapshot,
  resolveInactiveTerminalPaneStyle,
  shouldUseTerminalPaneSplitLayout,
  type TerminalPaneHiddenSize,
} from '../terminalPaneVisibility';
import type { ResolvedAppearance, TerminalAppearanceHostScope } from '../../domain/terminalAppearanceRuntime';
import type { TerminalSidePanelAutoOpenTab } from '../../domain/terminalSidePanelAutoOpen';

export type SidePanelTab = 'sftp' | 'scripts' | 'history' | 'theme' | 'ai' | 'system' | 'notes';

const LazyAIChatSidePanel = lazy(() =>
  import('../AIChatSidePanel').then((module) => ({ default: module.AIChatSidePanel })),
);

const AIChatSidePanelFallback = memo(function AIChatSidePanelFallback() {
  return (
    <div className="netcatty-lazy-fade-in h-full min-h-0 bg-background" aria-hidden="true" />
  );
});

export type WorkspaceRect = { x: number; y: number; w: number; h: number };

export type SplitHint = {
  direction: 'horizontal' | 'vertical';
  position: 'left' | 'right' | 'top' | 'bottom';
  targetSessionId?: string;
  rect?: { x: number; y: number; w: number; h: number };
} | null;

export type ResizerHandle = {
  id: string;
  splitId: string;
  index: number;
  direction: 'vertical' | 'horizontal';
  rect: { x: number; y: number; w: number; h: number };
  splitArea: { w: number; h: number };
};

export type PendingSftpUpload = {
  requestId: string;
  hostId: string;
  /** Full connection identity (id:hostname:port:protocol) for session-override awareness */
  connectionKey: string;
  targetPath?: string;
  entries: DropEntry[];
};

export type SnippetExecutor = (
  command: string,
  noAutoRun?: boolean,
  options?: { broadcast?: boolean; multiLineRunMode?: Snippet["multiLineRunMode"] },
) => void;

export type PendingTerminalSelectionForAI = {
  requestId: string;
  tabId: string;
  text: string;
};

export function hexToHslToken(hex: string): string {
  const normalized = hex.startsWith('#') ? hex : `#${hex}`;
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return `${Math.round(h * 3600) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`;
}

export function adjustLightnessToken(hsl: string, delta: number): string {
  const parts = hsl.split(/\s+/);
  const newL = Math.max(0, Math.min(100, parseFloat(parts[2]) + delta));
  return `${parts[0]} ${parts[1]} ${Math.round(newL * 10) / 10}%`;
}

export function adjustSaturationToken(hsl: string, factor: number): string {
  const parts = hsl.split(/\s+/);
  const newS = Math.max(0, Math.min(100, parseFloat(parts[1]) * factor));
  return `${parts[0]} ${Math.round(newS * 10) / 10}% ${parts[2]}`;
}

export type { TerminalThemePreviewState } from './terminalThemePreview';
export {
  emptyTerminalThemePreview,
  listThemePreviewSessionIds,
  resolvePaneThemePreviewId,
} from './terminalThemePreview';

export const clearTerminalPreviewVars = (sessionId: string | null) => {
  if (!sessionId || typeof document === 'undefined') return;
  const pane = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (!pane) return;
  pane.style.removeProperty('--terminal-preview-bg');
  pane.style.removeProperty('--terminal-preview-fg');
  pane.style.removeProperty('--terminal-preview-border');
  pane.style.removeProperty('--terminal-preview-toolbar-btn');
  pane.style.removeProperty('--terminal-preview-toolbar-btn-hover');
  pane.style.removeProperty('--terminal-preview-toolbar-btn-active');
};

export const setStylePropertyIfChanged = (element: HTMLElement, property: string, value: string) => {
  if (element.style.getPropertyValue(property) === value) return;
  element.style.setProperty(property, value);
};

const removeStylePropertyIfSet = (element: HTMLElement, property: string) => {
  if (!element.style.getPropertyValue(property)) return;
  element.style.removeProperty(property);
};

const HOST_TREE_PREVIEW_PROPERTIES = [
  '--terminal-host-tree-bg',
  '--terminal-host-tree-fg',
  '--terminal-host-tree-muted',
  '--terminal-host-tree-separator',
  '--terminal-host-tree-hover-bg',
  '--terminal-host-tree-active-bg',
  '--terminal-host-tree-drop-bg',
  '--terminal-host-tree-folder-fg',
] as const;

const getHostTreePreviewRoots = (): HTMLElement[] => {
  if (typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll<HTMLElement>(
    '[data-section="app-host-tree-layer"], [data-section="terminal-host-tree-sidebar"]',
  ));
};

export const clearHostTreePreviewVars = () => {
  const roots = getHostTreePreviewRoots();
  for (const root of roots) {
    for (const property of HOST_TREE_PREVIEW_PROPERTIES) {
      removeStylePropertyIfSet(root, property);
    }
  }
};

export const clearTopTabsPreviewVars = () => {
  if (typeof document === 'undefined') return;
  const tabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
  if (!tabsRoot) return;
  removeStylePropertyIfSet(tabsRoot, '--top-tabs-bg');
  removeStylePropertyIfSet(tabsRoot, '--top-tabs-fg');
  removeStylePropertyIfSet(tabsRoot, '--top-tabs-muted');
  removeStylePropertyIfSet(tabsRoot, '--top-tabs-active-bg');
  removeStylePropertyIfSet(tabsRoot, '--top-tabs-accent');
  removeStylePropertyIfSet(tabsRoot, '--background');
  removeStylePropertyIfSet(tabsRoot, '--foreground');
  removeStylePropertyIfSet(tabsRoot, '--accent');
  removeStylePropertyIfSet(tabsRoot, '--accent-foreground');
  removeStylePropertyIfSet(tabsRoot, '--primary');
  removeStylePropertyIfSet(tabsRoot, '--primary-foreground');
  removeStylePropertyIfSet(tabsRoot, '--secondary');
  removeStylePropertyIfSet(tabsRoot, '--border');
  removeStylePropertyIfSet(tabsRoot, '--muted-foreground');
};

export const filterTabsMap = <T,>(source: Map<string, T>, validIds: Set<string>): Map<string, T> => {
  let changed = false;
  const next = new Map<string, T>();
  for (const [id, value] of source) {
    if (validIds.has(id)) {
      next.set(id, value);
    } else {
      changed = true;
    }
  }
  return changed ? next : source;
};

// eslint-disable-next-line no-control-regex
const TERMINAL_OSC_SEQUENCE_REGEX = new RegExp('\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)', 'g');
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_SEQUENCE_REGEX = new RegExp('\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])', 'g');
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_CHAR_REGEX = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]', 'g');
// eslint-disable-next-line no-control-regex
const INCOMPLETE_ESCAPE_TAIL_REGEX = new RegExp('\\u001B(?:\\][^\\u0007\\u001B]*(?:\\u001B)?|\\[[0-?]*[ -/]*)?$');

const stripTerminalControlSequences = (data: string): string => {
  return data
    .replace(TERMINAL_OSC_SEQUENCE_REGEX, '')
    .replace(TERMINAL_ESCAPE_SEQUENCE_REGEX, '')
    .replace(TERMINAL_CONTROL_CHAR_REGEX, '');
};

export class ChunkedEscapeFilter {
  private pending = '';

  feed(chunk: string): string {
    const data = this.pending + chunk;
    const tailMatch = INCOMPLETE_ESCAPE_TAIL_REGEX.exec(data);
    if (tailMatch) {
      this.pending = tailMatch[0];
      return stripTerminalControlSequences(data.slice(0, tailMatch.index));
    }
    this.pending = '';
    return stripTerminalControlSequences(data);
  }
}

export const hasNotifiableTerminalOutput = (filter: ChunkedEscapeFilter, chunk: string): boolean => {
  return filter.feed(chunk).trim().length > 0;
};

export type AITerminalSessionInfo = {
  sessionId: string;
  hostId: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
  hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
  activePortForwards?: Array<{
    ruleId: string;
    label?: string;
    type?: string;
    localPort?: number;
    status?: string;
  }>;
};

function summarizeHostChain(
  host: Host | undefined,
  allHosts: Host[],
): AITerminalSessionInfo['hostChain'] | undefined {
  if (!host?.hostChain?.hostIds?.length) return undefined;
  return host.hostChain.hostIds.map((hostId) => {
    const jumpHost = allHosts.find((entry) => entry.id === hostId);
    return {
      hostId,
      label: jumpHost?.label,
      hostname: jumpHost?.hostname,
    };
  });
}

export type AIPanelContext = {
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeHostIds: string[];
  scopeLabel: string;
  terminalSessions: AITerminalSessionInfo[];
};

type AIStateValue = ReturnType<typeof useAIState>;

const AIStateContext = createContext<AIStateValue | null>(null);

export const buildAITerminalSessionInfo = (
  session: TerminalSession | undefined,
  host: Host | undefined,
  localOs: 'linux' | 'macos' | 'windows',
  options?: {
    allHosts?: Host[];
    portForwardingRules?: import('../../domain/models').PortForwardingRule[];
  },
): AITerminalSessionInfo => {
  const protocol = session?.protocol || host?.protocol;
  const isLocalSession = protocol === 'local' || session?.hostId?.startsWith('local-');
  const allHosts = options?.allHosts ?? (host ? [host] : []);
  const hostChain = summarizeHostChain(host, allHosts);
  const activePortForwards = host?.id && options?.portForwardingRules
    ? options.portForwardingRules
      .filter((rule) => rule.hostId === host.id && (rule.status === 'active' || rule.status === 'connecting'))
      .map((rule) => ({
        ruleId: rule.id,
        label: rule.label,
        type: rule.type,
        localPort: rule.localPort,
        status: rule.status,
      }))
    : undefined;
  return {
    sessionId: session?.id || '',
    hostId: session?.hostId || '',
    hostname: host?.hostname || session?.hostname || '',
    label: host?.label || session?.hostLabel || '',
    os: host?.os || (isLocalSession ? localOs : undefined),
    username: host?.username || session?.username,
    protocol,
    shellType: session?.shellType && session.shellType !== 'unknown' ? session.shellType : undefined,
    // Suppress deviceType for Mosh / ET sessions — both require a shell-backed
    // PTY and cannot connect to vendor CLIs, so network device mode doesn't apply.
    deviceType: (session?.moshEnabled || host?.moshEnabled || session?.etEnabled || host?.etEnabled) ? undefined : host?.deviceType,
    connected: session?.status === 'connected',
    ...(hostChain?.length ? { hostChain } : {}),
    ...(activePortForwards?.length ? { activePortForwards } : {}),
  };
};

interface AIChatPanelsHostProps {
  mountedTabIds: string[];
  activeTabId: string | null;
  activeSidePanelTab: SidePanelTab | null;
  contextsByTabId: Map<string, AIPanelContext>;
  resolveExecutorContext: (scope: {
    type: 'terminal' | 'workspace';
    targetId?: string;
    label?: string;
  }) => ExecutorContext;
  pendingTerminalSelection?: PendingTerminalSelectionForAI | null;
  onPendingTerminalSelectionConsumed?: (requestId: string) => void;
  notes: VaultNote[];
  hosts: Host[];
  snippets: Snippet[];
  onOpenVaultNoteFromChat?: (noteId: string) => void;
  onOpenVaultHostFromChat?: (hostId: string) => void;
  onOpenVaultSectionFromChat?: (section: 'notes' | 'hosts' | 'snippets') => void;
  onOpenVaultSnippetFromChat?: (snippetId: string) => void;
}

interface AIStateMaintenanceHostProps {
  validAIScopeTargetIds: Set<string>;
}

const AIStateProviderInner: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const aiState = useAIState();
  return (
    <AIStateContext.Provider value={aiState}>
      {children}
    </AIStateContext.Provider>
  );
};

export const AIStateProvider = memo(AIStateProviderInner);
AIStateProvider.displayName = 'AIStateProvider';

const AIStateMaintenanceHostInner: React.FC<AIStateMaintenanceHostProps> = ({
  validAIScopeTargetIds,
}) => {
  const aiState = useContext(AIStateContext);

  if (!aiState) {
    throw new Error('AIStateMaintenanceHost must be rendered inside AIStateProvider');
  }

  const { cleanupOrphanedSessions } = aiState;

  useEffect(() => {
    cleanupOrphanedSessions(validAIScopeTargetIds);
  }, [cleanupOrphanedSessions, validAIScopeTargetIds]);

  return null;
};

export const AIStateMaintenanceHost = memo(AIStateMaintenanceHostInner);
AIStateMaintenanceHost.displayName = 'AIStateMaintenanceHost';

interface AISidePanelStateRootProps {
  validAIScopeTargetIds: Set<string>;
  children: React.ReactNode;
}

const AISidePanelStateRootInner: React.FC<AISidePanelStateRootProps> = ({
  validAIScopeTargetIds,
  children,
}) => (
  <AIStateProvider>
    <AIStateMaintenanceHost validAIScopeTargetIds={validAIScopeTargetIds} />
    {children}
  </AIStateProvider>
);

export const AISidePanelStateRoot = memo(AISidePanelStateRootInner);
AISidePanelStateRoot.displayName = 'AISidePanelStateRoot';

function aiChatPanelsHostAreEqual(
  prev: AIChatPanelsHostProps,
  next: AIChatPanelsHostProps,
): boolean {
  if (prev.mountedTabIds !== next.mountedTabIds) return false;
  if (prev.contextsByTabId !== next.contextsByTabId) return false;
  if (prev.activeSidePanelTab !== next.activeSidePanelTab) return false;
  if (prev.pendingTerminalSelection !== next.pendingTerminalSelection) return false;
  if (prev.onPendingTerminalSelectionConsumed !== next.onPendingTerminalSelectionConsumed) return false;
  if (prev.resolveExecutorContext !== next.resolveExecutorContext) return false;
  if (prev.notes !== next.notes) return false;
  if (prev.hosts !== next.hosts) return false;
  if (prev.snippets !== next.snippets) return false;
  if (prev.onOpenVaultNoteFromChat !== next.onOpenVaultNoteFromChat) return false;
  if (prev.onOpenVaultHostFromChat !== next.onOpenVaultHostFromChat) return false;
  if (prev.onOpenVaultSectionFromChat !== next.onOpenVaultSectionFromChat) return false;
  if (prev.onOpenVaultSnippetFromChat !== next.onOpenVaultSnippetFromChat) return false;
  if (prev.activeTabId === next.activeTabId) return true;

  for (let i = 0; i < prev.mountedTabIds.length; i += 1) {
    const tabId = prev.mountedTabIds[i];
    const prevAiVisible = prev.activeTabId === tabId && prev.activeSidePanelTab === 'ai';
    const nextAiVisible = next.activeTabId === tabId && next.activeSidePanelTab === 'ai';
    if (prevAiVisible !== nextAiVisible) return false;
  }
  return true;
}

const AIChatPanelsHostInner: React.FC<AIChatPanelsHostProps> = ({
  mountedTabIds,
  activeTabId,
  activeSidePanelTab,
  contextsByTabId,
  resolveExecutorContext,
  pendingTerminalSelection,
  onPendingTerminalSelectionConsumed,
  notes,
  hosts,
  snippets,
  onOpenVaultNoteFromChat,
  onOpenVaultHostFromChat,
  onOpenVaultSectionFromChat,
  onOpenVaultSnippetFromChat,
}) => {
  const aiState = useContext(AIStateContext);

  if (!aiState) {
    throw new Error('AIChatPanelsHost must be rendered inside AIStateProvider');
  }
  const {
    activeSessionIdMap,
    defaultAgentId,
    panelViewByScope,
    showDraftView,
    updateDraft,
  } = aiState;

  useEffect(() => {
    if (!pendingTerminalSelection) return;

    const context = contextsByTabId.get(pendingTerminalSelection.tabId);
    if (!context) return;

    const attachment = createTerminalSelectionAttachment(pendingTerminalSelection.text);
    if (!attachment) {
      onPendingTerminalSelectionConsumed?.(pendingTerminalSelection.requestId);
      return;
    }

    const scopeKey = `${context.scopeType}:${context.scopeTargetId ?? ''}`;
    const isSessionView =
      panelViewByScope[scopeKey]?.mode === 'session'
      || activeSessionIdMap[scopeKey] != null;
    if (!isSessionView) {
      showDraftView(scopeKey);
    }
    updateDraft(scopeKey, defaultAgentId, (draft) => ({
      ...draft,
      attachments: [...draft.attachments, attachment],
    }));
    onPendingTerminalSelectionConsumed?.(pendingTerminalSelection.requestId);
  }, [
    activeSessionIdMap,
    contextsByTabId,
    defaultAgentId,
    onPendingTerminalSelectionConsumed,
    panelViewByScope,
    pendingTerminalSelection,
    showDraftView,
    updateDraft,
  ]);

  return (
    <>
      {mountedTabIds.map((tabId) => {
        const context = contextsByTabId.get(tabId);
        if (!context) return null;

        const isVisible = activeTabId === tabId && activeSidePanelTab === 'ai';

        return (
          <div
            key={tabId}
            className={cn("absolute inset-0 z-10", !isVisible && "hidden")}
          >
            <LazyLoadBoundary name="AI side panel" resetKey={tabId}>
              <Suspense fallback={<AIChatSidePanelFallback />}>
                <LazyAIChatSidePanel
                    sessions={aiState.sessions}
                    activeSessionIdMap={aiState.activeSessionIdMap}
                    draftsByScope={aiState.draftsByScope}
                    panelViewByScope={aiState.panelViewByScope}
                    setActiveSessionId={aiState.setActiveSessionId}
                    ensureDraftForScope={aiState.ensureDraftForScope}
                    updateDraft={aiState.updateDraft}
                    showDraftView={aiState.showDraftView}
                    showSessionView={aiState.showSessionView}
                    clearDraftForScope={aiState.clearDraftForScope}
                    addDraftFiles={aiState.addDraftFiles}
                    removeDraftFile={aiState.removeDraftFile}
                    createSession={aiState.createSession}
                    deleteSession={aiState.deleteSession}
                    updateSessionTitle={aiState.updateSessionTitle}
                    updateSessionExternalSessionId={aiState.updateSessionExternalSessionId}
                    addMessageToSession={aiState.addMessageToSession}
                    updateLastMessage={aiState.updateLastMessage}
                    updateMessageById={aiState.updateMessageById}
                    providers={aiState.providers}
                    activeProviderId={aiState.activeProviderId}
                    activeModelId={aiState.activeModelId}
                    defaultAgentId={aiState.defaultAgentId}
                    toolIntegrationMode={aiState.toolIntegrationMode}
                    externalAgents={aiState.externalAgents}
                    setExternalAgents={aiState.setExternalAgents}
                    agentModelMap={aiState.agentModelMap}
                    setAgentModel={aiState.setAgentModel}
                    agentProviderMap={aiState.agentProviderMap}
                    setAgentProvider={aiState.setAgentProvider}
                    globalPermissionMode={aiState.globalPermissionMode}
                    setGlobalPermissionMode={aiState.setGlobalPermissionMode}
                    commandBlocklist={aiState.commandBlocklist}
                    commandTimeout={aiState.commandTimeout}
                    maxIterations={aiState.maxIterations}
                    webSearchConfig={aiState.webSearchConfig}
                    quickMessages={aiState.quickMessages}
                    scopeType={context.scopeType}
                    scopeTargetId={context.scopeTargetId}
                    scopeHostIds={context.scopeHostIds}
                    scopeLabel={context.scopeLabel}
                    terminalSessions={context.terminalSessions}
                    resolveExecutorContext={resolveExecutorContext}
                    isVisible={isVisible}
                    notes={notes}
                    hosts={hosts}
                    snippets={snippets}
                    onOpenVaultNote={onOpenVaultNoteFromChat}
                    onOpenVaultHost={onOpenVaultHostFromChat}
                    onOpenVaultSection={onOpenVaultSectionFromChat}
                    onOpenVaultSnippet={onOpenVaultSnippetFromChat}
                  />
              </Suspense>
            </LazyLoadBoundary>
          </div>
        );
      })}
    </>
  );
};

export const AIChatPanelsHost = memo(AIChatPanelsHostInner, aiChatPanelsHostAreEqual);
AIChatPanelsHost.displayName = 'AIChatPanelsHost';

export interface TerminalLayerProps {
  hosts: Host[];
  portForwardingRules?: import('../../domain/models').PortForwardingRule[];
  customGroups: string[];
  groupConfigs: GroupConfig[];
  proxyProfiles: ProxyProfile[];
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  snippetPackages: string[];
  notes: VaultNote[];
  noteGroups: string[];
  openNoteRequest?: { tabId: string; noteId: string; requestId: number } | null;
  onOpenVaultNoteFromChat?: (noteId: string) => void;
  onOpenVaultHostFromChat?: (hostId: string) => void;
  onOpenVaultSectionFromChat?: (section: 'notes' | 'hosts' | 'snippets') => void;
  onOpenVaultSnippetFromChat?: (snippetId: string) => void;
  sessions: TerminalSession[];
  workspaces: Workspace[];
  knownHosts?: KnownHost[];
  draggingSessionId: string | null;
  terminalTheme: TerminalTheme;
  terminalThemeId?: string;
  followAppTerminalTheme?: boolean;
  pickTerminalTheme?: (themeId: string) => void;
  clearThemeIntent?: () => void;
  settleManualThemeIntent?: () => void;
  resolveSessionAppearance?: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  accentMode?: 'theme' | 'custom';
  customAccent?: string;
  terminalSettings?: TerminalSettings;
  terminalFontFamilyId: string;
  fontSize?: number;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  disableTerminalFontZoom?: boolean;
  restoreTerminalCwd?: boolean;
  keyBindings?: KeyBinding[];
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onUpdateTerminalThemeId?: (themeId: string) => void;
  onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
  onUpdateTerminalFontSize?: (fontSize: number) => void;
  onUpdateTerminalFontWeight?: (fontWeight: number) => void;
  onUpdateSessionFontSize?: (sessionId: string, fontSize: number) => void;
  onUpdateSessionRestoreCwd?: (sessionId: string, cwd: string | null) => void;
  onUpdateSessionDynamicTitle?: (sessionId: string, title: string | null) => void;
  onUpdateSessionCodingCliProvider?: (sessionId: string, providerId: import('../../domain/codingCliProviders').CodingCliProviderId | null) => void;
  onClearSessionFontSizeOverride?: (sessionId: string) => void;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onUpdateSessionStatus: (sessionId: string, status: TerminalSession['status']) => void;
  onUpdateHostDistro: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  shellHistory?: import('../../types').ShellHistoryEntry[];
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onRequestAddToWorkspace?: (workspaceId: string) => void;
  onUpdateSplitSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  onSetDraggingSessionId: (id: string | null) => void;
  onToggleWorkspaceViewMode?: (workspaceId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onReorderWorkspaceSessions?: (workspaceId: string, draggedSessionId: string, targetSessionId: string, position: 'before' | 'after') => void;
  onReorderTabs?: (draggedId: string, targetId: string, position: 'before' | 'after', additionalTabIds?: readonly string[]) => void;
  onCopySession?: (sessionId: string) => void;
  onCopySessionToNewWindow?: (sessionId: string) => void;
  onRemoveSessionFromWorkspace?: (
    sessionId: string,
    tabInsertionTarget?: { tabId: string; position: 'before' | 'after'; additionalTabIds?: readonly string[] },
  ) => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  onConnectToHost: (host: Host) => string | void;
  onCreateLocalTerminal?: () => void;
  // Broadcast mode
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onToggleBroadcast?: (workspaceId: string) => void;
  // SFTP side panel
  updateHosts: (hosts: Host[]) => void;
  updateSnippets?: (snippets: Snippet[]) => void;
  updateSnippetPackages?: (packages: string[]) => void;
  updateNotes: (notes: VaultNote[]) => void;
  updateNoteGroups: (groups: string[]) => void;
  sftpDefaultViewMode: 'list' | 'tree';
  sftpDoubleClickBehavior: 'open' | 'transfer';
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  sftpAutoOpenSidebar: boolean;
  terminalSidePanelAutoOpen?: boolean;
  terminalSidePanelAutoOpenTab?: TerminalSidePanelAutoOpenTab;
  sftpFollowTerminalCwd: boolean;
  setSftpFollowTerminalCwd: (enabled: boolean) => void;
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  // Session log settings for real-time streaming
  sessionLogsEnabled?: boolean;
  sessionLogsDir?: string;
  sessionLogsFormat?: "txt" | "raw" | "html";
  sessionLogsTimestampsEnabled?: boolean;
  sshDebugLogsEnabled?: boolean;
  showHostTreeSidebar?: boolean;
  toggleScriptsSidePanelRef?: React.MutableRefObject<(() => void) | null>;
  toggleSidePanelRef?: React.MutableRefObject<(() => void) | null>;
  // Session rename
  onStartSessionRename?: (sessionId: string) => void;
  onSubmitSessionRename?: (sessionId?: string, name?: string) => void;
}

interface TerminalPaneProps {
  session: TerminalSession;
  host: Host;
  sessionHostResolved: boolean;
  chainHosts?: Host[];
  sudoAutofillPassword?: string;
  sudoAutofillCandidates?: import("../terminal/runtime/terminalSudoAutofill").SudoPasswordAutofillCandidate[];
  workspaceById: Map<string, Workspace>;
  workspaceRectsById: Map<string, Record<string, WorkspaceRect>>;
  isTerminalLayerVisible: boolean;
  workspaceFocusHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  workspaceBroadcastHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitHorizontalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitVerticalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  resolveSessionAppearance: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  hostMap: Map<string, Host>;
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  knownHosts: KnownHost[];
  terminalFontFamilyId: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  followAppTerminalTheme?: boolean;
  accentMode?: 'theme' | 'custom';
  customAccent?: string;
  terminalSettings?: TerminalSettings;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  disableTerminalFontZoom?: boolean;
  restoreTerminalCwd?: boolean;
  keyBindings?: KeyBinding[];
  isResizing: boolean;
  isComposeBarOpen: boolean;
  sessionLog?: { enabled: boolean; directory: string; format: "txt" | "raw" | "html"; timestampsEnabled?: boolean };
  sshDebugLogEnabled?: boolean;
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onTerminalFontSizeChange?: (sessionId: string, fontSize: number) => void;
  onOpenSftp: (
    host: Host,
    initialPath?: string,
    pendingUploadEntries?: DropEntry[],
    sourceSessionId?: string,
  ) => void;
  onTerminalCwdChange: (sessionId: string, cwd: string | null, meta?: { source?: 'osc7' }) => void;
  onTerminalTitleChange?: (sessionId: string, title: string | null) => void;
  onTerminalBell?: (sessionId: string) => void;
  onTerminalOutput?: (sessionId: string, chunk: string) => void;
  onTerminalContextReaderChange?: (sessionId: string, reader: TerminalContextReader | null) => void;
  onOpenScripts: () => void;
  onOpenHistory?: () => void;
  onOpenTheme: () => void;
  onOpenSystem?: () => void;
  onCloseSession: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: TerminalSession['status']) => void;
  onSessionExit: (sessionId: string, evt: TerminalSessionExitEvent) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  shellHistory?: import('../../types').ShellHistoryEntry[];
  onCommandSubmitted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onBroadcastInput: (
    data: string,
    sourceSessionId: string,
    options?: TerminalBroadcastInputOptions,
  ) => string[] | void;
  onToggleWorkspaceComposeBar: () => void;
  onBroadcastInterruptPriorityChange: (
    sessionId: string,
    prioritize: (() => void) | null,
  ) => void;
  onSnippetExecutorChange: (
    sessionId: string,
    executor: SnippetExecutor | null,
  ) => void;
  onProgrammaticCommandLogRewriteChange: (
    sessionId: string,
    queueRewrite: ((rewrite: ProgrammaticCommandLogRewrite) => void) | null,
  ) => void;
  onAddSelectionToAI?: (sessionId: string, selection: string) => void;
  showSelectionAIAction: boolean;
  onStartSessionRename?: (sessionId: string) => void;
  onRemoveSessionFromWorkspace?: (
    sessionId: string,
    tabInsertionTarget?: { tabId: string; position: 'before' | 'after'; additionalTabIds?: readonly string[] },
  ) => void;
  onReorderTabs?: (draggedId: string, targetId: string, position: 'before' | 'after', additionalTabIds?: readonly string[]) => void;
  onStartSessionDrag?: (sessionId: string) => void;
  onEndSessionDrag?: () => void;
}

const getPaneAppearanceThemeId = (props: TerminalPaneProps): string => {
  const isEphemeral = !isSavedVaultHost(props.hostMap.get(props.host.id));
  return props.resolveSessionAppearance({ host: props.host, isEphemeral }).themeId;
};

const getPaneWorkspaceRect = (props: Pick<TerminalPaneProps, 'session' | 'workspaceRectsById'>): WorkspaceRect | null => {
  const workspaceId = props.session.workspaceId;
  if (!workspaceId) return null;
  return props.workspaceRectsById.get(workspaceId)?.[props.session.id] ?? null;
};

const getPaneRenderedWorkspaceRect = (props: Pick<TerminalPaneProps, 'session' | 'host' | 'workspaceById' | 'workspaceRectsById' | 'terminalSettings'>): WorkspaceRect | null => {
  const workspaceId = props.session.workspaceId;
  if (!workspaceId) return null;
  const workspace = props.workspaceById.get(workspaceId);
  if (!workspace) return null;
  if (resolveTerminalHibernateEnabledForProtocol(props.terminalSettings, props.host.protocol)
    && activeTabStore.getActiveTabId() !== workspaceId) {
    return null;
  }
  if (workspace.viewMode === 'focus' && workspace.focusedSessionId === props.session.id) {
    return null;
  }
  return props.workspaceRectsById.get(workspaceId)?.[props.session.id] ?? null;
};

const workspaceRectsEqual = (a: WorkspaceRect | null, b: WorkspaceRect | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
};

const terminalPanePropsAreEqual = (
  prev: TerminalPaneProps,
  next: TerminalPaneProps,
): boolean => (
  prev.session === next.session &&
  prev.host === next.host &&
  prev.sessionHostResolved === next.sessionHostResolved &&
  prev.chainHosts === next.chainHosts &&
  prev.sudoAutofillPassword === next.sudoAutofillPassword &&
  prev.sudoAutofillCandidates === next.sudoAutofillCandidates &&
  prev.workspaceById === next.workspaceById &&
  workspaceRectsEqual(getPaneRenderedWorkspaceRect(prev), getPaneRenderedWorkspaceRect(next)) &&
  prev.isTerminalLayerVisible === next.isTerminalLayerVisible &&
  prev.workspaceFocusHandlersRef === next.workspaceFocusHandlersRef &&
  prev.workspaceBroadcastHandlersRef === next.workspaceBroadcastHandlersRef &&
  prev.splitHorizontalHandlersRef === next.splitHorizontalHandlersRef &&
  prev.splitVerticalHandlersRef === next.splitVerticalHandlersRef &&
  getPaneAppearanceThemeId(prev) === getPaneAppearanceThemeId(next) &&
  prev.keys === next.keys &&
  prev.identities === next.identities &&
  prev.snippets === next.snippets &&
  prev.knownHosts === next.knownHosts &&
  prev.terminalFontFamilyId === next.terminalFontFamilyId &&
  prev.fontSize === next.fontSize &&
  prev.terminalTheme === next.terminalTheme &&
  prev.followAppTerminalTheme === next.followAppTerminalTheme &&
  prev.accentMode === next.accentMode &&
  prev.customAccent === next.customAccent &&
  prev.terminalSettings === next.terminalSettings &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.disableTerminalFontZoom === next.disableTerminalFontZoom &&
  prev.restoreTerminalCwd === next.restoreTerminalCwd &&
  prev.keyBindings === next.keyBindings &&
  prev.isResizing === next.isResizing &&
  prev.isComposeBarOpen === next.isComposeBarOpen &&
  prev.sessionLog === next.sessionLog &&
  prev.sshDebugLogEnabled === next.sshDebugLogEnabled &&
  prev.onHotkeyAction === next.onHotkeyAction &&
  prev.onTerminalFontSizeChange === next.onTerminalFontSizeChange &&
  prev.onOpenSftp === next.onOpenSftp &&
  prev.onTerminalCwdChange === next.onTerminalCwdChange &&
  prev.onTerminalTitleChange === next.onTerminalTitleChange &&
  prev.onTerminalBell === next.onTerminalBell &&
  prev.onTerminalOutput === next.onTerminalOutput &&
  prev.onTerminalContextReaderChange === next.onTerminalContextReaderChange &&
  prev.onOpenScripts === next.onOpenScripts &&
  prev.onOpenHistory === next.onOpenHistory &&
  prev.onOpenTheme === next.onOpenTheme &&
  prev.onOpenSystem === next.onOpenSystem &&
  prev.onCloseSession === next.onCloseSession &&
  prev.onStatusChange === next.onStatusChange &&
  prev.onSessionExit === next.onSessionExit &&
  prev.onTerminalDataCapture === next.onTerminalDataCapture &&
  prev.onOsDetected === next.onOsDetected &&
  prev.onUpdateHost === next.onUpdateHost &&
  prev.onAddKnownHost === next.onAddKnownHost &&
  prev.onCommandExecuted === next.onCommandExecuted &&
  prev.onCommandSubmitted === next.onCommandSubmitted &&
  prev.onSetWorkspaceFocusedSession === next.onSetWorkspaceFocusedSession &&
  prev.onSplitSession === next.onSplitSession &&
  prev.isBroadcastEnabled === next.isBroadcastEnabled &&
  prev.onBroadcastInput === next.onBroadcastInput &&
  prev.onBroadcastInterruptPriorityChange === next.onBroadcastInterruptPriorityChange &&
  prev.onToggleWorkspaceComposeBar === next.onToggleWorkspaceComposeBar &&
  prev.onSnippetExecutorChange === next.onSnippetExecutorChange &&
  prev.onAddSelectionToAI === next.onAddSelectionToAI &&
  prev.showSelectionAIAction === next.showSelectionAIAction &&
  prev.onStartSessionRename === next.onStartSessionRename &&
  prev.onRemoveSessionFromWorkspace === next.onRemoveSessionFromWorkspace &&
  prev.onReorderTabs === next.onReorderTabs &&
  prev.onStartSessionDrag === next.onStartSessionDrag &&
  prev.onEndSessionDrag === next.onEndSessionDrag
);

const TerminalPane: React.FC<TerminalPaneProps> = memo(({
  session,
  host,
  sessionHostResolved,
  chainHosts,
  sudoAutofillPassword,
  sudoAutofillCandidates,
  workspaceById,
  workspaceRectsById,
  isTerminalLayerVisible,
  workspaceFocusHandlersRef,
  workspaceBroadcastHandlersRef,
  splitHorizontalHandlersRef,
  splitVerticalHandlersRef,
  resolveSessionAppearance,
  hostMap,
  keys,
  identities,
  snippets,
  knownHosts,
  terminalFontFamilyId,
  fontSize,
  terminalTheme,
  followAppTerminalTheme,
  accentMode,
  customAccent,
  terminalSettings,
  hotkeyScheme,
  disableTerminalFontZoom,
  restoreTerminalCwd,
  keyBindings,
  isResizing,
  isComposeBarOpen,
  sessionLog,
  sshDebugLogEnabled,
  onHotkeyAction,
  onTerminalFontSizeChange,
  onOpenSftp,
  onTerminalCwdChange,
  onTerminalTitleChange,
  onTerminalBell,
  onTerminalOutput,
  onTerminalContextReaderChange,
  onOpenScripts,
  onOpenHistory,
  onOpenTheme,
  onOpenSystem,
  onCloseSession,
  onStatusChange,
  onSessionExit,
  onTerminalDataCapture,
  onOsDetected,
  onUpdateHost,
  onAddKnownHost,
  onCommandExecuted,
  onCommandSubmitted,
  onSetWorkspaceFocusedSession,
  onSplitSession,
  isBroadcastEnabled,
  onBroadcastInput,
  onBroadcastInterruptPriorityChange,
  onToggleWorkspaceComposeBar,
  onSnippetExecutorChange,
  onProgrammaticCommandLogRewriteChange,
  onAddSelectionToAI,
  showSelectionAIAction,
  onStartSessionRename,
  onRemoveSessionFromWorkspace,
  onReorderTabs,
  onStartSessionDrag,
  onEndSessionDrag,
}) => {
  const layoutSuppressActive = useTerminalLayoutSuppressActive();
  const deferPaneLayoutUpdate = isResizing || layoutSuppressActive;

  const getRenderSnapshot = useCallback(
    () => getTerminalPaneRenderSnapshot({
      activeTabId: activeTabStore.getActiveTabId(),
      sessionId: session.id,
      sessionWorkspaceId: session.workspaceId,
      workspaceById,
      isTerminalLayerVisible,
    }),
    [isTerminalLayerVisible, session.id, session.workspaceId, workspaceById],
  );
  const renderSnapshot = useSyncExternalStore(activeTabStore.subscribe, getRenderSnapshot, getRenderSnapshot);
  const { paneState, isFocusedPane } = parseTerminalPaneRenderSnapshot(renderSnapshot);
  const activeWorkspaceId = paneState.workspaceId;
  const isVisible = paneState.isVisible;
  const paneElementRef = useRef<HTMLDivElement | null>(null);
  const lastVisiblePaneSizeRef = useRef<TerminalPaneHiddenSize | null>(null);
  const [, bumpHiddenPaneSizeVersion] = useState(0);

  // Publish visibility before paint so hibernate / write-path readers see the
  // new value in the same frame as the CSS hide/show (#1985).
  useLayoutEffect(() => {
    setPaneVisible(session.id, isVisible);
  }, [session.id, isVisible]);
  useEffect(() => () => removePaneVisible(session.id), [session.id]);
  const inActiveWorkspace = !!activeWorkspaceId;
  const isFocusMode = paneState.mode === 'focus';
  const isSplitViewVisible = paneState.mode === 'split';
  const hibernateHiddenTabs = resolveTerminalHibernateEnabledForProtocol(terminalSettings, host.protocol);
  const layoutWorkspaceId = activeWorkspaceId ?? (!hibernateHiddenTabs ? session.workspaceId : undefined);
  const layoutWorkspace = layoutWorkspaceId ? workspaceById.get(layoutWorkspaceId) : undefined;
  const keepsWorkspacePresentation = !!layoutWorkspace;
  const usesSplitLayout = shouldUseTerminalPaneSplitLayout({
    workspace: layoutWorkspace,
    sessionId: session.id,
    isVisible,
    hibernateHiddenTabs,
  });
  const rect = layoutWorkspaceId && usesSplitLayout
    ? workspaceRectsById.get(layoutWorkspaceId)?.[session.id] ?? null
    : null;
  const layoutStyle = rect
    ? {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    }
    : { left: 0, top: 0, width: '100%', height: '100%' };
  const livePaneLayoutKey = usesSplitLayout && rect
    ? `${Math.round(rect.w)}x${Math.round(rect.h)}`
    : 'full';
  const paneLayoutKeyRef = useRef(livePaneLayoutKey);
  const [, bumpPaneLayoutKeyVersion] = useState(0);
  const shouldCommitLayoutImmediately =
    !deferPaneLayoutUpdate && (!isSplitViewVisible || isFocusMode || isFocusedPane);
  if (shouldCommitLayoutImmediately && paneLayoutKeyRef.current !== livePaneLayoutKey) {
    paneLayoutKeyRef.current = livePaneLayoutKey;
  }
  useEffect(() => {
    if (deferPaneLayoutUpdate || !isVisible || !isSplitViewVisible || isFocusMode || isFocusedPane) return;
    if (paneLayoutKeyRef.current === livePaneLayoutKey) return;

    let cancelled = false;
    const commitDeferredLayout = () => {
      if (cancelled || !isVisible) return;
      if (paneLayoutKeyRef.current === livePaneLayoutKey) return;
      paneLayoutKeyRef.current = livePaneLayoutKey;
      bumpPaneLayoutKeyVersion((version) => version + 1);
    };

    if (typeof requestIdleCallback === 'function') {
      const idleId = requestIdleCallback(commitDeferredLayout, { timeout: 500 });
      return () => {
        cancelled = true;
        cancelIdleCallback(idleId);
      };
    }

    const timerId = setTimeout(commitDeferredLayout, 350);
    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [deferPaneLayoutUpdate, isFocusedPane, isFocusMode, isSplitViewVisible, isVisible, livePaneLayoutKey]);

  const paneLayoutKey = paneLayoutKeyRef.current;
  const style: React.CSSProperties = { ...layoutStyle };

  useLayoutEffect(() => {
    const element = paneElementRef.current;
    if (!element) return;

    const capturePaneSize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width <= 0 || height <= 0) return false;
      lastVisiblePaneSizeRef.current = { width, height };
      return true;
    };

    if (isVisible) {
      capturePaneSize();
      const observer = new ResizeObserver(() => {
        capturePaneSize();
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    const initializeHiddenFullSize = !hibernateHiddenTabs
      && !rect
      && !lastVisiblePaneSizeRef.current;
    if (!initializeHiddenFullSize) return;
    if (capturePaneSize()) {
      bumpHiddenPaneSizeVersion((version) => version + 1);
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!capturePaneSize()) return;
      observer.disconnect();
      bumpHiddenPaneSizeVersion((version) => version + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    hibernateHiddenTabs,
    isVisible,
    layoutStyle.height,
    layoutStyle.width,
    activeWorkspaceId,
    rect,
  ]);

  if (!isVisible) {
    Object.assign(style, resolveInactiveTerminalPaneStyle(
      style,
      lastVisiblePaneSizeRef.current,
      hibernateHiddenTabs,
      !rect,
    ));
  }

  const workspaceFocusHandler = activeWorkspaceId
    ? workspaceFocusHandlersRef.current.get(activeWorkspaceId)
    : undefined;
  const workspaceBroadcastHandler = activeWorkspaceId
    ? workspaceBroadcastHandlersRef.current.get(activeWorkspaceId)
    : undefined;
  const splitHorizontalHandler = splitHorizontalHandlersRef.current.get(session.id);
  const splitVerticalHandler = splitVerticalHandlersRef.current.get(session.id);
  const broadcastEnabled = activeWorkspaceId ? !!isBroadcastEnabled?.(activeWorkspaceId) : false;
  const isHostEphemeral = !isSavedVaultHost(hostMap.get(host.id));
  const sessionAppearance = useMemo(
    () => resolveSessionAppearance({ host, isEphemeral: isHostEphemeral }),
    [resolveSessionAppearance, host, isHostEphemeral],
  );
  const sessionAppearanceTheme = sessionAppearance.theme;

  const handlePaneClick = useCallback(() => {
    if (activeWorkspaceId && !isFocusMode) {
      onSetWorkspaceFocusedSession?.(activeWorkspaceId, session.id);
    }
  }, [activeWorkspaceId, isFocusMode, onSetWorkspaceFocusedSession, session.id]);
  const handleOpenSystemForPane = useCallback(() => {
    if (activeWorkspaceId && !isFocusMode) {
      onSetWorkspaceFocusedSession?.(activeWorkspaceId, session.id);
    }
    onOpenSystem?.();
  }, [activeWorkspaceId, isFocusMode, onOpenSystem, onSetWorkspaceFocusedSession, session.id]);
  const handleRename = useCallback(() => {
    onStartSessionRename?.(session.id);
  }, [onStartSessionRename, session.id]);
  const handleDetach = useCallback(() => {
    onRemoveSessionFromWorkspace?.(session.id);
  }, [onRemoveSessionFromWorkspace, session.id]);
  const handleDetachDragStart = useCallback((e: React.DragEvent) => {
    if (!inActiveWorkspace) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(WORKSPACE_SESSION_DRAG_TYPE, session.id);
    e.dataTransfer.setData('session-id', session.id);
    e.dataTransfer.setData('text/plain', session.id);
    onStartSessionDrag?.(session.id);
  }, [inActiveWorkspace, onStartSessionDrag, session.id]);
  const handleDetachDragEnd = useCallback(() => {
    onEndSessionDrag?.();
  }, [onEndSessionDrag]);
  const handleDetachPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!inActiveWorkspace || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startPoint = { clientX: e.clientX, clientY: e.clientY };
    const dragLabel = resolveSessionTabTitle(session, terminalSettings?.dynamicTabTitleMode);
    let dragStarted = false;
    let ghostEl: HTMLDivElement | null = null;
    let insertEl: HTMLDivElement | null = null;

    const ensureDragElements = () => {
      if (!ghostEl) {
        ghostEl = document.createElement('div');
        ghostEl.textContent = dragLabel;
        ghostEl.style.position = 'fixed';
        ghostEl.style.left = '0';
        ghostEl.style.top = '0';
        ghostEl.style.zIndex = '2147483647';
        ghostEl.style.pointerEvents = 'none';
        ghostEl.style.maxWidth = '220px';
        ghostEl.style.padding = '5px 10px';
        ghostEl.style.borderRadius = '7px';
        ghostEl.style.border = '1px solid color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 60%, transparent)';
        ghostEl.style.background = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 90%, transparent)';
        ghostEl.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
        ghostEl.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.28)';
        ghostEl.style.fontSize = '12px';
        ghostEl.style.fontWeight = '600';
        ghostEl.style.whiteSpace = 'nowrap';
        ghostEl.style.overflow = 'hidden';
        ghostEl.style.textOverflow = 'ellipsis';
        document.body.appendChild(ghostEl);
      }

      if (!insertEl) {
        insertEl = document.createElement('div');
        insertEl.style.position = 'fixed';
        insertEl.style.zIndex = '2147483646';
        insertEl.style.pointerEvents = 'none';
        insertEl.style.width = '2px';
        insertEl.style.borderRadius = '999px';
        insertEl.style.background = 'var(--top-tabs-accent, hsl(var(--accent)))';
        insertEl.style.boxShadow = '0 0 10px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 70%, transparent)';
        insertEl.style.display = 'none';
        document.body.appendChild(insertEl);
      }
    };

    const removeDragElements = () => {
      ghostEl?.remove();
      insertEl?.remove();
      ghostEl = null;
      insertEl = null;
    };

    const updateDragElements = (event: PointerEvent) => {
      ensureDragElements();
      if (ghostEl) {
        ghostEl.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
      }

      const topTabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
      const insertionTarget = getTopTabInsertionTarget(event, topTabsRoot);
      if (!topTabsRoot || !insertionTarget || !insertEl) {
        if (insertEl) insertEl.style.display = 'none';
        return insertionTarget;
      }

      const targetTab = Array.from(topTabsRoot.querySelectorAll<HTMLElement>('[data-tab-id]'))
        .find((tab) => tab.dataset.tabId === insertionTarget.tabId);
      if (!targetTab) {
        insertEl.style.display = 'none';
        return insertionTarget;
      }

      const targetRect = targetTab.getBoundingClientRect();
      const rootRect = topTabsRoot.getBoundingClientRect();
      const lineX = insertionTarget.position === 'before' ? targetRect.left : targetRect.right;
      insertEl.style.display = 'block';
      insertEl.style.left = `${lineX - 1}px`;
      insertEl.style.top = `${Math.max(rootRect.top + 5, targetRect.top + 3)}px`;
      insertEl.style.height = `${Math.max(18, Math.min(rootRect.bottom - rootRect.top - 8, targetRect.height - 4))}px`;
      return insertionTarget;
    };

    const resolveStableInsertionTarget = (insertionTarget: ReturnType<typeof getTopTabInsertionTarget>) => {
      if (!insertionTarget || insertionTarget.tabId !== session.workspaceId) return insertionTarget;
      const sourceWorkspace = session.workspaceId ? workspaceById.get(session.workspaceId) : undefined;
      if (!sourceWorkspace) return insertionTarget;
      const remainingSessionIds = collectSessionIds(sourceWorkspace.root)
        .filter((candidateId) => candidateId !== session.id);
      if (remainingSessionIds.length !== 1) return insertionTarget;
      return {
        tabId: remainingSessionIds[0],
        position: insertionTarget.position,
      };
    };

    const startDragIfNeeded = (event: PointerEvent) => {
      if (dragStarted) return;
      const dx = event.clientX - startPoint.clientX;
      const dy = event.clientY - startPoint.clientY;
      if (Math.hypot(dx, dy) < 4) return;
      dragStarted = true;
      onStartSessionDrag?.(session.id);
      updateDragElements(event);
    };

    const cleanup = () => {
      document.removeEventListener('pointermove', handlePointerMove, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      document.removeEventListener('pointercancel', handlePointerCancel, true);
      removeDragElements();
      if (dragStarted) onEndSessionDrag?.();
    };

    const handlePointerMove = (event: PointerEvent) => {
      startDragIfNeeded(event);
      if (dragStarted) updateDragElements(event);
    };

    const handlePointerCancel = () => {
      cleanup();
    };

    const handlePointerUp = (event: PointerEvent) => {
      startDragIfNeeded(event);
      const topTabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
      const insertionTarget = dragStarted ? updateDragElements(event) : null;
      const shouldDetach = dragStarted && !!topTabsRoot && isPointInsideRect(event, topTabsRoot.getBoundingClientRect());
      cleanup();
      if (shouldDetach) {
        const stableInsertionTarget = resolveStableInsertionTarget(insertionTarget);
        if (onRemoveSessionFromWorkspace) {
          onRemoveSessionFromWorkspace(
            session.id,
            stableInsertionTarget
              ? {
                  tabId: stableInsertionTarget.tabId,
                  position: stableInsertionTarget.position,
                  additionalTabIds: [session.id, stableInsertionTarget.tabId],
                }
              : undefined,
          );
        } else if (stableInsertionTarget) {
          onReorderTabs?.(session.id, stableInsertionTarget.tabId, stableInsertionTarget.position, [
            session.id,
            stableInsertionTarget.tabId,
          ]);
        }
      }
    };

    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    document.addEventListener('pointercancel', handlePointerCancel, true);
  }, [
    inActiveWorkspace,
    onEndSessionDrag,
    onRemoveSessionFromWorkspace,
    onReorderTabs,
    onStartSessionDrag,
    session,
    terminalSettings?.dynamicTabTitleMode,
    workspaceById,
  ]);
  const handleTerminalFontSizeChange = useCallback((nextFontSize: number) => {
    onTerminalFontSizeChange?.(session.id, nextFontSize);
  }, [onTerminalFontSizeChange, session.id]);

  return (
    <div
      ref={paneElementRef}
      data-session-id={session.id}
      data-section="terminal-split-pane"
      data-focused={isFocusedPane ? 'true' : undefined}
      inert={isVisible ? undefined : true}
      className={cn(
        "absolute bg-background",
        inActiveWorkspace && "workspace-pane",
        isVisible && "z-10",
      )}
      style={style}
      tabIndex={-1}
      onClick={handlePaneClick}
    >
      <Terminal
        host={host}
        keys={keys}
        identities={identities}
        snippets={snippets}
        chainHosts={chainHosts}
        appearanceTheme={sessionAppearanceTheme}
        knownHosts={knownHosts}
        isVisible={isVisible}
        paneLayoutKey={paneLayoutKey}
        inWorkspace={keepsWorkspacePresentation}
        isResizing={isResizing}
        isFocusMode={layoutWorkspace?.viewMode === 'focus'}
        isFocused={isFocusedPane}
        fontFamilyId={terminalFontFamilyId}
        fontSize={fontSize}
        terminalTheme={terminalTheme}
        followAppTerminalTheme={followAppTerminalTheme}
        accentMode={accentMode}
        customAccent={customAccent}
        terminalSettings={terminalSettings}
        sessionId={session.id}
        workspaceId={session.workspaceId}
        restoreState={session.restoreState}
        shellType={session.shellType}
        lastCwd={session.lastCwd}
        restoreTerminalCwd={restoreTerminalCwd && sessionHostResolved}
        startupCommand={session.startupCommand}
        noAutoRun={session.noAutoRun}
        multiLineRunMode={session.multiLineRunMode}
        pendingScriptId={session.pendingScriptId}
        pendingScript={session.pendingScript}
        reuseConnectionFromSessionId={session.reuseConnectionFromSessionId}
        serialConfig={session.serialConfig}
        hotkeyScheme={hotkeyScheme}
        disableTerminalFontZoom={disableTerminalFontZoom}
        keyBindings={keyBindings}
        onHotkeyAction={onHotkeyAction}
        onTerminalFontSizeChange={handleTerminalFontSizeChange}
        onOpenSftp={onOpenSftp}
        onTerminalCwdChange={onTerminalCwdChange}
        onTerminalTitleChange={onTerminalTitleChange}
        onTerminalBell={onTerminalBell}
        onTerminalOutput={onTerminalOutput}
        onTerminalContextReaderChange={onTerminalContextReaderChange}
        onOpenScripts={onOpenScripts}
        onOpenHistory={onOpenHistory}
        onOpenTheme={onOpenTheme}
        onOpenSystem={handleOpenSystemForPane}
        onCloseSession={onCloseSession}
        onStatusChange={onStatusChange}
        onSessionExit={onSessionExit}
        onTerminalDataCapture={onTerminalDataCapture}
        onOsDetected={onOsDetected}
        onUpdateHost={onUpdateHost}
        onAddKnownHost={onAddKnownHost}
        onCommandExecuted={onCommandExecuted}
        onCommandSubmitted={onCommandSubmitted}
        onExpandToFocus={inActiveWorkspace && !isFocusMode ? workspaceFocusHandler : undefined}
        onSplitHorizontal={onSplitSession ? splitHorizontalHandler : undefined}
        onSplitVertical={onSplitSession ? splitVerticalHandler : undefined}
        isBroadcastEnabled={broadcastEnabled}
        onToggleBroadcast={inActiveWorkspace ? workspaceBroadcastHandler : undefined}
        onToggleComposeBar={inActiveWorkspace ? onToggleWorkspaceComposeBar : undefined}
        isWorkspaceComposeBarOpen={inActiveWorkspace ? isComposeBarOpen : undefined}
        onBroadcastInput={broadcastEnabled ? onBroadcastInput : undefined}
        onBroadcastInterruptPriorityChange={onBroadcastInterruptPriorityChange}
        onSnippetExecutorChange={onSnippetExecutorChange}
        onProgrammaticCommandLogRewriteChange={onProgrammaticCommandLogRewriteChange}
        sessionLog={sessionLog}
        sshDebugLogEnabled={sshDebugLogEnabled}
        sudoAutofillPassword={sudoAutofillPassword}
        sudoAutofillCandidates={sudoAutofillCandidates}
        sessionDisplayName={resolveSessionTabTitle(session, terminalSettings?.dynamicTabTitleMode)}
        showSelectionAIAction={showSelectionAIAction}
        onAddSelectionToAI={onAddSelectionToAI}
        onRename={handleRename}
        onDetach={inActiveWorkspace ? handleDetach : undefined}
        onStartSessionDrag={inActiveWorkspace ? onStartSessionDrag : undefined}
        onEndSessionDrag={inActiveWorkspace ? onEndSessionDrag : undefined}
        onDetachPointerDown={inActiveWorkspace ? handleDetachPointerDown : undefined}
        onDetachDragStart={inActiveWorkspace ? handleDetachDragStart : undefined}
        onDetachDragEnd={inActiveWorkspace ? handleDetachDragEnd : undefined}
      />
    </div>
  );
}, terminalPanePropsAreEqual);
TerminalPane.displayName = 'TerminalPane';

interface TerminalPanesHostProps {
  sessions: TerminalSession[];
  sessionHostsMap: Map<string, Host>;
  sessionChainHostsMap: Map<string, Host[]>;
  sessionSudoAutofillPasswordsMap: Map<string, string | undefined>;
  sessionSudoAutofillCandidatesMap: Map<
    string,
    import("../terminal/runtime/terminalSudoAutofill").SudoPasswordAutofillCandidate[] | undefined
  >;
  resolvedSessionHostIds: Set<string>;
  workspaceById: Map<string, Workspace>;
  workspaceRectsById: Map<string, Record<string, WorkspaceRect>>;
  isTerminalLayerVisible: boolean;
  workspaceFocusHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  workspaceBroadcastHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitHorizontalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitVerticalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  resolveSessionAppearance: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  hostMap: Map<string, Host>;
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  knownHosts: KnownHost[];
  terminalFontFamilyId: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  followAppTerminalTheme?: boolean;
  accentMode?: 'theme' | 'custom';
  customAccent?: string;
  terminalSettings?: TerminalSettings;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  disableTerminalFontZoom?: boolean;
  restoreTerminalCwd?: boolean;
  keyBindings?: KeyBinding[];
  isResizing: boolean;
  isComposeBarOpen: boolean;
  sessionLog?: { enabled: boolean; directory: string; format: "txt" | "raw" | "html"; timestampsEnabled?: boolean };
  sshDebugLogEnabled?: boolean;
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onTerminalFontSizeChange?: TerminalPaneProps['onTerminalFontSizeChange'];
  onOpenSftp: TerminalPaneProps['onOpenSftp'];
  onTerminalCwdChange: TerminalPaneProps['onTerminalCwdChange'];
  onTerminalTitleChange?: TerminalPaneProps['onTerminalTitleChange'];
  onTerminalBell?: TerminalPaneProps['onTerminalBell'];
  onTerminalOutput?: TerminalPaneProps['onTerminalOutput'];
  onTerminalContextReaderChange?: TerminalPaneProps['onTerminalContextReaderChange'];
  onOpenScripts: () => void;
  onOpenHistory?: () => void;
  onOpenTheme: () => void;
  onOpenSystem?: () => void;
  onCloseSession: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: TerminalSession['status']) => void;
  onSessionExit: (sessionId: string, evt: TerminalSessionExitEvent) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  shellHistory?: import('../../types').ShellHistoryEntry[];
  onCommandSubmitted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onBroadcastInput: (
    data: string,
    sourceSessionId: string,
    options?: TerminalBroadcastInputOptions,
  ) => string[] | void;
  onToggleWorkspaceComposeBar: () => void;
  onBroadcastInterruptPriorityChange: (
    sessionId: string,
    prioritize: (() => void) | null,
  ) => void;
  onSnippetExecutorChange: (
    sessionId: string,
    executor: SnippetExecutor | null,
  ) => void;
  onProgrammaticCommandLogRewriteChange: TerminalPaneProps['onProgrammaticCommandLogRewriteChange'];
  onAddSelectionToAI?: (sessionId: string, selection: string) => void;
  onStartSessionRename?: (sessionId: string) => void;
  onRemoveSessionFromWorkspace?: TerminalPaneProps['onRemoveSessionFromWorkspace'];
  onReorderTabs?: (draggedId: string, targetId: string, position: 'before' | 'after', additionalTabIds?: readonly string[]) => void;
  onStartSessionDrag?: (sessionId: string) => void;
  onEndSessionDrag?: () => void;
}

const terminalPanesHostPropsAreEqual = (
  prev: TerminalPanesHostProps,
  next: TerminalPanesHostProps,
): boolean => {
  if (prev.sessions !== next.sessions) return false;
  if (prev.sessionHostsMap !== next.sessionHostsMap) return false;
  if (prev.sessionChainHostsMap !== next.sessionChainHostsMap) return false;
  if (prev.sessionSudoAutofillPasswordsMap !== next.sessionSudoAutofillPasswordsMap) return false;
  if (prev.sessionSudoAutofillCandidatesMap !== next.sessionSudoAutofillCandidatesMap) return false;
  if (prev.resolvedSessionHostIds !== next.resolvedSessionHostIds) return false;
  if (prev.workspaceById !== next.workspaceById) return false;
  if (prev.isTerminalLayerVisible !== next.isTerminalLayerVisible) return false;
  if (prev.workspaceFocusHandlersRef !== next.workspaceFocusHandlersRef) return false;
  if (prev.workspaceBroadcastHandlersRef !== next.workspaceBroadcastHandlersRef) return false;
  if (prev.splitHorizontalHandlersRef !== next.splitHorizontalHandlersRef) return false;
  if (prev.splitVerticalHandlersRef !== next.splitVerticalHandlersRef) return false;
  if (prev.resolveSessionAppearance !== next.resolveSessionAppearance) return false;
  if (prev.hostMap !== next.hostMap) return false;
  if (prev.keys !== next.keys) return false;
  if (prev.identities !== next.identities) return false;
  if (prev.snippets !== next.snippets) return false;
  if (prev.knownHosts !== next.knownHosts) return false;
  if (prev.terminalFontFamilyId !== next.terminalFontFamilyId) return false;
  if (prev.fontSize !== next.fontSize) return false;
  if (prev.terminalTheme !== next.terminalTheme) return false;
  if (prev.followAppTerminalTheme !== next.followAppTerminalTheme) return false;
  if (prev.accentMode !== next.accentMode) return false;
  if (prev.customAccent !== next.customAccent) return false;
  if (prev.terminalSettings !== next.terminalSettings) return false;
  if (prev.hotkeyScheme !== next.hotkeyScheme) return false;
  if (prev.disableTerminalFontZoom !== next.disableTerminalFontZoom) return false;
  if (prev.restoreTerminalCwd !== next.restoreTerminalCwd) return false;
  if (prev.keyBindings !== next.keyBindings) return false;
  if (prev.isResizing !== next.isResizing) return false;
  if (prev.isComposeBarOpen !== next.isComposeBarOpen) return false;
  if (prev.sessionLog !== next.sessionLog) return false;
  if (prev.sshDebugLogEnabled !== next.sshDebugLogEnabled) return false;
  if (prev.onHotkeyAction !== next.onHotkeyAction) return false;
  if (prev.onTerminalFontSizeChange !== next.onTerminalFontSizeChange) return false;
  if (prev.onOpenSftp !== next.onOpenSftp) return false;
  if (prev.onTerminalCwdChange !== next.onTerminalCwdChange) return false;
  if (prev.onTerminalTitleChange !== next.onTerminalTitleChange) return false;
  if (prev.onTerminalBell !== next.onTerminalBell) return false;
  if (prev.onTerminalOutput !== next.onTerminalOutput) return false;
  if (prev.onTerminalContextReaderChange !== next.onTerminalContextReaderChange) return false;
  if (prev.onOpenScripts !== next.onOpenScripts) return false;
  if (prev.onOpenHistory !== next.onOpenHistory) return false;
  if (prev.onOpenTheme !== next.onOpenTheme) return false;
  if (prev.onOpenSystem !== next.onOpenSystem) return false;
  if (prev.onCloseSession !== next.onCloseSession) return false;
  if (prev.onStatusChange !== next.onStatusChange) return false;
  if (prev.onSessionExit !== next.onSessionExit) return false;
  if (prev.onTerminalDataCapture !== next.onTerminalDataCapture) return false;
  if (prev.onOsDetected !== next.onOsDetected) return false;
  if (prev.onUpdateHost !== next.onUpdateHost) return false;
  if (prev.onAddKnownHost !== next.onAddKnownHost) return false;
  if (prev.onCommandExecuted !== next.onCommandExecuted) return false;
  if (prev.onCommandSubmitted !== next.onCommandSubmitted) return false;
  if (prev.onSetWorkspaceFocusedSession !== next.onSetWorkspaceFocusedSession) return false;
  if (prev.onSplitSession !== next.onSplitSession) return false;
  if (prev.isBroadcastEnabled !== next.isBroadcastEnabled) return false;
  if (prev.onBroadcastInput !== next.onBroadcastInput) return false;
  if (prev.onBroadcastInterruptPriorityChange !== next.onBroadcastInterruptPriorityChange) return false;
  if (prev.onToggleWorkspaceComposeBar !== next.onToggleWorkspaceComposeBar) return false;
  if (prev.onSnippetExecutorChange !== next.onSnippetExecutorChange) return false;
  if (prev.onProgrammaticCommandLogRewriteChange !== next.onProgrammaticCommandLogRewriteChange) return false;
  if (prev.onAddSelectionToAI !== next.onAddSelectionToAI) return false;
  if (prev.onStartSessionRename !== next.onStartSessionRename) return false;
  if (prev.onRemoveSessionFromWorkspace !== next.onRemoveSessionFromWorkspace) return false;
  if (prev.onReorderTabs !== next.onReorderTabs) return false;
  if (prev.onStartSessionDrag !== next.onStartSessionDrag) return false;
  if (prev.onEndSessionDrag !== next.onEndSessionDrag) return false;

  if (prev.workspaceRectsById === next.workspaceRectsById) return true;

  if (!resolveTerminalHibernateEnabled(next.terminalSettings)) {
    return prev.sessions.every((session) => workspaceRectsEqual(
      getPaneWorkspaceRect({ session, workspaceRectsById: prev.workspaceRectsById }),
      getPaneWorkspaceRect({ session, workspaceRectsById: next.workspaceRectsById }),
    ));
  }

  const activeTabId = activeTabStore.getActiveTabId();
  const activeWorkspace = activeTabId ? next.workspaceById.get(activeTabId) : undefined;

  return prev.sessions.every((session) => {
    const isLocalTerminal = next.sessionHostsMap.get(session.id)?.protocol === 'local';
    const isInVisibleSplitWorkspace = activeWorkspace?.viewMode !== 'focus'
      && session.workspaceId === activeWorkspace?.id;
    if (!isLocalTerminal && !isInVisibleSplitWorkspace) return true;
    return workspaceRectsEqual(
      getPaneWorkspaceRect({ session, workspaceRectsById: prev.workspaceRectsById }),
      getPaneWorkspaceRect({ session, workspaceRectsById: next.workspaceRectsById }),
    );
  });
};

export const TerminalPanesHost: React.FC<TerminalPanesHostProps> = memo(({
  sessions,
  sessionHostsMap,
  sessionChainHostsMap,
  sessionSudoAutofillPasswordsMap,
  sessionSudoAutofillCandidatesMap,
  resolvedSessionHostIds,
  ...sharedProps
}) => {
  const [showSelectionAIAction] = useStoredBoolean(
    STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
    true,
  );

  return (
    <>
      {sessions.map((session) => {
        const host = sessionHostsMap.get(session.id);
        if (!host) return null;
        return (
          <TerminalPane
            key={session.id}
            session={session}
            host={host}
            sessionHostResolved={resolvedSessionHostIds.has(session.id)}
            chainHosts={sessionChainHostsMap.get(session.id)}
            sudoAutofillPassword={sessionSudoAutofillPasswordsMap.get(session.id)}
            sudoAutofillCandidates={sessionSudoAutofillCandidatesMap.get(session.id)}
            showSelectionAIAction={showSelectionAIAction}
            {...sharedProps}
          />
        );
      })}
    </>
  );
}, terminalPanesHostPropsAreEqual);
TerminalPanesHost.displayName = 'TerminalPanesHost';
