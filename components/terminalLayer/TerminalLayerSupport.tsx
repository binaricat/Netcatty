import React, { Suspense, createContext, lazy, memo, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';

import { activeTabStore } from '../../application/state/activeTabStore';
import type { TerminalSessionExitEvent } from '../../application/state/resolveTerminalSessionExitIntent';
import { createTerminalSelectionAttachment } from '../../application/state/terminalSelectionAttachment';
import { useAIState } from '../../application/state/useAIState';
import { SplitDirection } from '../../domain/workspace';
import { KeyBinding, TerminalSettings } from '../../domain/models';
import { cn } from '../../lib/utils';
import type { DropEntry } from '../../lib/sftpFileUtils';
import type { GroupConfig, Host, Identity, KnownHost, ProxyProfile, SSHKey, Snippet, TerminalSession, TerminalTheme, Workspace } from '../../types';
import type { ExecutorContext } from '../../infrastructure/ai/cattyAgent/executor';
import Terminal from '../Terminal';
import { getTerminalPaneSnapshot, parseTerminalPaneSnapshot } from '../terminalPaneVisibility';

export type SidePanelTab = 'sftp' | 'scripts' | 'theme' | 'ai';

const LazyAIChatSidePanel = lazy(() =>
  import('../AIChatSidePanel').then((m) => ({ default: m.AIChatSidePanel })),
);

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
  options?: { broadcast?: boolean },
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
  removeStylePropertyIfSet(tabsRoot, '--primary');
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
};

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
): AITerminalSessionInfo => {
  const protocol = session?.protocol || host?.protocol;
  const isLocalSession = protocol === 'local' || session?.hostId?.startsWith('local-');
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

const AIChatPanelsHostInner: React.FC<AIChatPanelsHostProps> = ({
  mountedTabIds,
  activeTabId,
  activeSidePanelTab,
  contextsByTabId,
  resolveExecutorContext,
  pendingTerminalSelection,
  onPendingTerminalSelectionConsumed,
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
            {isVisible && (
              <Suspense fallback={null}>
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
                  maxIterations={aiState.maxIterations}
                  webSearchConfig={aiState.webSearchConfig}
                  scopeType={context.scopeType}
                  scopeTargetId={context.scopeTargetId}
                  scopeHostIds={context.scopeHostIds}
                  scopeLabel={context.scopeLabel}
                  terminalSessions={context.terminalSessions}
                  resolveExecutorContext={resolveExecutorContext}
                  isVisible={isVisible}
                />
              </Suspense>
            )}
          </div>
        );
      })}
    </>
  );
};

export const AIChatPanelsHost = memo(AIChatPanelsHostInner);
AIChatPanelsHost.displayName = 'AIChatPanelsHost';

export interface TerminalLayerProps {
  hosts: Host[];
  groupConfigs: GroupConfig[];
  proxyProfiles: ProxyProfile[];
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  snippetPackages: string[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  knownHosts?: KnownHost[];
  draggingSessionId: string | null;
  terminalTheme: TerminalTheme;
  followAppTerminalTheme?: boolean;
  accentMode?: 'theme' | 'custom';
  customAccent?: string;
  terminalSettings?: TerminalSettings;
  terminalFontFamilyId: string;
  fontSize?: number;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  keyBindings?: KeyBinding[];
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onUpdateTerminalThemeId?: (themeId: string) => void;
  onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
  onUpdateTerminalFontSize?: (fontSize: number) => void;
  onUpdateTerminalFontWeight?: (fontWeight: number) => void;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onUpdateSessionStatus: (sessionId: string, status: TerminalSession['status']) => void;
  onUpdateHostDistro: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onRequestAddToWorkspace?: (workspaceId: string) => void;
  onUpdateSplitSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  onSetDraggingSessionId: (id: string | null) => void;
  onToggleWorkspaceViewMode?: (workspaceId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onReorderWorkspaceSessions?: (workspaceId: string, draggedSessionId: string, targetSessionId: string, position: 'before' | 'after') => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  // Broadcast mode
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onToggleBroadcast?: (workspaceId: string) => void;
  // SFTP side panel
  updateHosts: (hosts: Host[]) => void;
  sftpDefaultViewMode: 'list' | 'tree';
  sftpDoubleClickBehavior: 'open' | 'transfer';
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  sftpAutoOpenSidebar: boolean;
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  // Session log settings for real-time streaming
  sessionLogsEnabled?: boolean;
  sessionLogsDir?: string;
  sessionLogsFormat?: string;
  sessionLogsTimestampsEnabled?: boolean;
  sshDebugLogsEnabled?: boolean;
  toggleScriptsSidePanelRef?: React.MutableRefObject<(() => void) | null>;
  toggleSidePanelRef?: React.MutableRefObject<(() => void) | null>;
}

interface TerminalPaneProps {
  session: TerminalSession;
  host: Host;
  chainHosts?: Host[];
  sudoAutofillPassword?: string;
  workspaceById: Map<string, Workspace>;
  workspaceRectsById: Map<string, Record<string, WorkspaceRect>>;
  isTerminalLayerVisible: boolean;
  workspaceFocusHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  workspaceBroadcastHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitHorizontalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitVerticalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  themePreview: { targetSessionId: string | null; themeId: string | null };
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
  keyBindings?: KeyBinding[];
  isResizing: boolean;
  isComposeBarOpen: boolean;
  sessionLog?: { enabled: true; directory: string; format: string; timestampsEnabled?: boolean };
  sshDebugLogEnabled?: boolean;
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onTerminalFontSizeChange?: (sessionId: string, fontSize: number) => void;
  onOpenSftp: (
    host: Host,
    initialPath?: string,
    pendingUploadEntries?: DropEntry[],
    sourceSessionId?: string,
  ) => void;
  onTerminalCwdChange: (sessionId: string, cwd: string | null) => void;
  onOpenScripts: () => void;
  onOpenTheme: () => void;
  onCloseSession: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: TerminalSession['status']) => void;
  onSessionExit: (sessionId: string, evt: TerminalSessionExitEvent) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onBroadcastInput: (data: string, sourceSessionId: string) => void;
  onToggleWorkspaceComposeBar: () => void;
  onSnippetExecutorChange: (
    sessionId: string,
    executor: SnippetExecutor | null,
  ) => void;
  onAddSelectionToAI?: (sessionId: string, selection: string) => void;
}

const getPaneThemePreviewId = (props: TerminalPaneProps): string | null => (
  props.session.id === props.themePreview.targetSessionId
    ? props.themePreview.themeId
    : null
);

const terminalPanePropsAreEqual = (
  prev: TerminalPaneProps,
  next: TerminalPaneProps,
): boolean => (
  prev.session === next.session &&
  prev.host === next.host &&
  prev.chainHosts === next.chainHosts &&
  prev.sudoAutofillPassword === next.sudoAutofillPassword &&
  prev.workspaceById === next.workspaceById &&
  prev.workspaceRectsById === next.workspaceRectsById &&
  prev.isTerminalLayerVisible === next.isTerminalLayerVisible &&
  prev.workspaceFocusHandlersRef === next.workspaceFocusHandlersRef &&
  prev.workspaceBroadcastHandlersRef === next.workspaceBroadcastHandlersRef &&
  prev.splitHorizontalHandlersRef === next.splitHorizontalHandlersRef &&
  prev.splitVerticalHandlersRef === next.splitVerticalHandlersRef &&
  getPaneThemePreviewId(prev) === getPaneThemePreviewId(next) &&
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
  prev.keyBindings === next.keyBindings &&
  prev.isResizing === next.isResizing &&
  prev.isComposeBarOpen === next.isComposeBarOpen &&
  prev.sessionLog === next.sessionLog &&
  prev.sshDebugLogEnabled === next.sshDebugLogEnabled &&
  prev.onHotkeyAction === next.onHotkeyAction &&
  prev.onTerminalFontSizeChange === next.onTerminalFontSizeChange &&
  prev.onOpenSftp === next.onOpenSftp &&
  prev.onTerminalCwdChange === next.onTerminalCwdChange &&
  prev.onOpenScripts === next.onOpenScripts &&
  prev.onOpenTheme === next.onOpenTheme &&
  prev.onCloseSession === next.onCloseSession &&
  prev.onStatusChange === next.onStatusChange &&
  prev.onSessionExit === next.onSessionExit &&
  prev.onTerminalDataCapture === next.onTerminalDataCapture &&
  prev.onOsDetected === next.onOsDetected &&
  prev.onUpdateHost === next.onUpdateHost &&
  prev.onAddKnownHost === next.onAddKnownHost &&
  prev.onCommandExecuted === next.onCommandExecuted &&
  prev.onSetWorkspaceFocusedSession === next.onSetWorkspaceFocusedSession &&
  prev.onSplitSession === next.onSplitSession &&
  prev.isBroadcastEnabled === next.isBroadcastEnabled &&
  prev.onBroadcastInput === next.onBroadcastInput &&
  prev.onToggleWorkspaceComposeBar === next.onToggleWorkspaceComposeBar &&
  prev.onSnippetExecutorChange === next.onSnippetExecutorChange &&
  prev.onAddSelectionToAI === next.onAddSelectionToAI
);

const TerminalPane: React.FC<TerminalPaneProps> = memo(({
  session,
  host,
  chainHosts,
  sudoAutofillPassword,
  workspaceById,
  workspaceRectsById,
  isTerminalLayerVisible,
  workspaceFocusHandlersRef,
  workspaceBroadcastHandlersRef,
  splitHorizontalHandlersRef,
  splitVerticalHandlersRef,
  themePreview,
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
  keyBindings,
  isResizing,
  isComposeBarOpen,
  sessionLog,
  sshDebugLogEnabled,
  onHotkeyAction,
  onTerminalFontSizeChange,
  onOpenSftp,
  onTerminalCwdChange,
  onOpenScripts,
  onOpenTheme,
  onCloseSession,
  onStatusChange,
  onSessionExit,
  onTerminalDataCapture,
  onOsDetected,
  onUpdateHost,
  onAddKnownHost,
  onCommandExecuted,
  onSetWorkspaceFocusedSession,
  onSplitSession,
  isBroadcastEnabled,
  onBroadcastInput,
  onToggleWorkspaceComposeBar,
  onSnippetExecutorChange,
  onAddSelectionToAI,
}) => {
  const getPaneSnapshot = useCallback(
    () => getTerminalPaneSnapshot({
      activeTabId: activeTabStore.getActiveTabId(),
      sessionId: session.id,
      sessionWorkspaceId: session.workspaceId,
      workspaceById,
      isTerminalLayerVisible,
    }),
    [isTerminalLayerVisible, session.id, session.workspaceId, workspaceById],
  );
  const paneSnapshot = useSyncExternalStore(activeTabStore.subscribe, getPaneSnapshot);
  const paneState = parseTerminalPaneSnapshot(paneSnapshot);
  const activeWorkspaceId = paneState.workspaceId;
  const isVisible = paneState.isVisible;
  const inActiveWorkspace = !!activeWorkspaceId;
  const isFocusMode = paneState.mode === 'focus';
  const isSplitViewVisible = paneState.mode === 'split';
  const isFocusedPane = inActiveWorkspace && !isFocusMode && session.id === paneState.focusedSessionId;
  const rect = activeWorkspaceId && isSplitViewVisible
    ? workspaceRectsById.get(activeWorkspaceId)?.[session.id] ?? null
    : null;
  const layoutStyle = rect
    ? {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    }
    : { left: 0, top: 0, width: '100%', height: '100%' };
  const style: React.CSSProperties = { ...layoutStyle };

  if (!isVisible) {
    style.visibility = 'hidden';
    style.pointerEvents = 'none';
    // Preserve xterm state while keeping hidden terminals out of layout.
    style.left = '-9999px';
    style.top = '-9999px';
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
  const themePreviewId = session.id === themePreview.targetSessionId
    ? themePreview.themeId ?? undefined
    : undefined;

  const handlePaneClick = useCallback(() => {
    if (activeWorkspaceId && !isFocusMode) {
      onSetWorkspaceFocusedSession?.(activeWorkspaceId, session.id);
    }
  }, [activeWorkspaceId, isFocusMode, onSetWorkspaceFocusedSession, session.id]);
  const handleTerminalFontSizeChange = useCallback((nextFontSize: number) => {
    onTerminalFontSizeChange?.(session.id, nextFontSize);
  }, [onTerminalFontSizeChange, session.id]);

  return (
    <div
      data-session-id={session.id}
      data-section="terminal-split-pane"
      data-focused={isFocusedPane ? 'true' : undefined}
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
        themePreviewId={themePreviewId}
        knownHosts={knownHosts}
        isVisible={isVisible}
        inWorkspace={inActiveWorkspace}
        isResizing={isResizing}
        isFocusMode={isFocusMode}
        isFocused={isFocusedPane}
        fontFamilyId={terminalFontFamilyId}
        fontSize={fontSize}
        terminalTheme={terminalTheme}
        followAppTerminalTheme={followAppTerminalTheme}
        accentMode={accentMode}
        customAccent={customAccent}
        terminalSettings={terminalSettings}
        sessionId={session.id}
        startupCommand={session.startupCommand}
        noAutoRun={session.noAutoRun}
        reuseConnectionFromSessionId={session.reuseConnectionFromSessionId}
        serialConfig={session.serialConfig}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
        onHotkeyAction={onHotkeyAction}
        onTerminalFontSizeChange={handleTerminalFontSizeChange}
        onOpenSftp={onOpenSftp}
        onTerminalCwdChange={onTerminalCwdChange}
        onOpenScripts={onOpenScripts}
        onOpenTheme={onOpenTheme}
        onCloseSession={onCloseSession}
        onStatusChange={onStatusChange}
        onSessionExit={onSessionExit}
        onTerminalDataCapture={onTerminalDataCapture}
        onOsDetected={onOsDetected}
        onUpdateHost={onUpdateHost}
        onAddKnownHost={onAddKnownHost}
        onCommandExecuted={onCommandExecuted}
        onExpandToFocus={inActiveWorkspace && !isFocusMode ? workspaceFocusHandler : undefined}
        onSplitHorizontal={onSplitSession ? splitHorizontalHandler : undefined}
        onSplitVertical={onSplitSession ? splitVerticalHandler : undefined}
        isBroadcastEnabled={broadcastEnabled}
        onToggleBroadcast={inActiveWorkspace ? workspaceBroadcastHandler : undefined}
        onToggleComposeBar={inActiveWorkspace ? onToggleWorkspaceComposeBar : undefined}
        isWorkspaceComposeBarOpen={inActiveWorkspace ? isComposeBarOpen : undefined}
        onBroadcastInput={broadcastEnabled ? onBroadcastInput : undefined}
        onSnippetExecutorChange={onSnippetExecutorChange}
        sessionLog={sessionLog}
        sshDebugLogEnabled={sshDebugLogEnabled}
        sudoAutofillPassword={sudoAutofillPassword}
        onAddSelectionToAI={onAddSelectionToAI}
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
  workspaceById: Map<string, Workspace>;
  workspaceRectsById: Map<string, Record<string, WorkspaceRect>>;
  isTerminalLayerVisible: boolean;
  workspaceFocusHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  workspaceBroadcastHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitHorizontalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitVerticalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  themePreview: { targetSessionId: string | null; themeId: string | null };
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
  keyBindings?: KeyBinding[];
  isResizing: boolean;
  isComposeBarOpen: boolean;
  sessionLog?: { enabled: true; directory: string; format: string; timestampsEnabled?: boolean };
  sshDebugLogEnabled?: boolean;
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onTerminalFontSizeChange?: TerminalPaneProps['onTerminalFontSizeChange'];
  onOpenSftp: TerminalPaneProps['onOpenSftp'];
  onTerminalCwdChange: TerminalPaneProps['onTerminalCwdChange'];
  onOpenScripts: () => void;
  onOpenTheme: () => void;
  onCloseSession: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: TerminalSession['status']) => void;
  onSessionExit: (sessionId: string, evt: TerminalSessionExitEvent) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onBroadcastInput: (data: string, sourceSessionId: string) => void;
  onToggleWorkspaceComposeBar: () => void;
  onSnippetExecutorChange: (
    sessionId: string,
    executor: SnippetExecutor | null,
  ) => void;
  onAddSelectionToAI?: (sessionId: string, selection: string) => void;
}

export const TerminalPanesHost: React.FC<TerminalPanesHostProps> = memo(({
  sessions,
  sessionHostsMap,
  sessionChainHostsMap,
  sessionSudoAutofillPasswordsMap,
  ...sharedProps
}) => (
  <>
    {sessions.map((session) => {
      const host = sessionHostsMap.get(session.id);
      if (!host) return null;
      return (
        <TerminalPane
          key={session.id}
          session={session}
          host={host}
          chainHosts={sessionChainHostsMap.get(session.id)}
          sudoAutofillPassword={sessionSudoAutofillPasswordsMap.get(session.id)}
          {...sharedProps}
        />
      );
    })}
  </>
));
TerminalPanesHost.displayName = 'TerminalPanesHost';
