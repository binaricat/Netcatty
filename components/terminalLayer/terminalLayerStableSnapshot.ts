/* eslint-disable @typescript-eslint/no-explicit-any */
import type React from 'react';

import type { DropEntry } from '../../lib/sftpFileUtils';
import type { ProgrammaticCommandLogRewrite } from '../terminal/programmaticCommandLog';
import type {
  GroupConfig,
  Host,
  Identity,
  KnownHost,
  ProxyProfile,
  SSHKey,
  Snippet,
  TerminalSession,
  TerminalTheme,
  VaultNote,
  Workspace,
} from '../../types';
import type {
  PendingSftpUpload,
  PendingTerminalSelectionForAI,
  SidePanelTab,
  SnippetExecutor,
  TerminalLayerProps,
} from './TerminalLayerSupport';

export type TerminalLayerStableSnapshot = {
  props: TerminalLayerProps;
  t: (key: string) => string;
  terminalBackend: ReturnType<typeof import('../../application/state/useTerminalBackend').useTerminalBackend>;
  terminalRendererCwdBySessionRef: React.MutableRefObject<Map<string, string>>;
  hosts: Host[];
  customGroups: string[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  draggingSessionId: string | null;
  hostMap: Map<string, Host>;
  hostMapRef: React.MutableRefObject<Map<string, Host>>;
  effectiveHosts: Host[];
  sessionHostsMap: Map<string, Host>;
  sessionHostsMapRef: React.MutableRefObject<Map<string, Host>>;
  resolvedSessionHostIds: Set<string>;
  sessionChainHostsMap: Map<string, Host[]>;
  sessionSudoAutofillPasswordsMap: Map<string, string | undefined>;
  workspaceById: Map<string, Workspace>;
  snippetExecutorsRef: React.MutableRefObject<Map<string, SnippetExecutor>>;
  programmaticCommandLogRewriteHandlersRef: React.MutableRefObject<Map<string, (rewrite: ProgrammaticCommandLogRewrite) => void>>;
  activeTabIdRef: React.MutableRefObject<string>;
  activeWorkspaceRef: React.MutableRefObject<Workspace | undefined>;
  activeSessionRef: React.MutableRefObject<TerminalSession | undefined>;
  focusedSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionsRef: React.MutableRefObject<TerminalSession[]>;
  workspacesRef: React.MutableRefObject<Workspace[]>;
  hostsRef: React.MutableRefObject<Host[]>;
  portForwardingRules: import('../../domain/models').PortForwardingRule[];
  portForwardingRulesRef: React.MutableRefObject<import('../../domain/models').PortForwardingRule[]>;
  onSetWorkspaceFocusedSessionRef: React.MutableRefObject<TerminalLayerProps['onSetWorkspaceFocusedSession']>;
  sidePanelOpenTabs: Map<string, SidePanelTab>;
  setSidePanelOpenTabs: React.Dispatch<React.SetStateAction<Map<string, SidePanelTab>>>;
  sidePanelOpenTabsRef: React.MutableRefObject<Map<string, SidePanelTab>>;
  sidePanelWidth: number;
  setSidePanelWidth: (value: number) => void;
  sidePanelPosition: 'left' | 'right';
  setSidePanelPosition: (value: 'left' | 'right') => void;
  sftpHostForTab: Map<string, Host>;
  setSftpHostForTab: React.Dispatch<React.SetStateAction<Map<string, Host>>>;
  sftpHostForTabRef: React.MutableRefObject<Map<string, Host>>;
  sftpInitialLocationForTab: Map<string, { hostId: string; path: string }>;
  setSftpInitialLocationForTab: React.Dispatch<React.SetStateAction<Map<string, { hostId: string; path: string }>>>;
  sftpPendingUploadsForTab: Map<string, PendingSftpUpload>;
  setSftpPendingUploadsForTab: React.Dispatch<React.SetStateAction<Map<string, PendingSftpUpload>>>;
  pendingTerminalSelectionForAI: PendingTerminalSelectionForAI | null;
  setPendingTerminalSelectionForAI: React.Dispatch<React.SetStateAction<PendingTerminalSelectionForAI | null>>;
  lastSidePanelTabRef: React.MutableRefObject<Map<string, SidePanelTab>>;
  notesMountedTabIds: string[];
  setNotesMountedTabIds: React.Dispatch<React.SetStateAction<string[]>>;
  notesOpenNoteByTab: Map<string, { noteId: string; requestId: number }>;
  setNotesOpenNoteByTab: React.Dispatch<React.SetStateAction<Map<string, { noteId: string; requestId: number }>>>;
  isComposeBarOpen: boolean;
  setIsComposeBarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  splitHorizontalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  splitVerticalHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  onSplitSessionRef: React.MutableRefObject<TerminalLayerProps['onSplitSession']>;
  workspaceFocusHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  workspaceBroadcastHandlersRef: React.MutableRefObject<Map<string, () => void>>;
  onToggleWorkspaceViewModeRef: React.MutableRefObject<TerminalLayerProps['onToggleWorkspaceViewMode']>;
  onToggleBroadcastRef: React.MutableRefObject<TerminalLayerProps['onToggleBroadcast']>;
  validAIScopeTargetIds: Set<string>;
  validSessionActivityIds: Set<string>;
  activityTrackedSessions: TerminalSession[];
  handleCloseSession: (sessionId: string) => void;
  handleStatusChange: (sessionId: string, status: TerminalSession['status']) => void;
  handleSessionExit: (sessionId: string, evt: any) => void;
  handleOsDetected: (hostId: string, distro: string) => void;
  handleUpdateHost: (host: Host) => void;
  handleAddKnownHost: (knownHost: KnownHost) => void;
  handleCommandExecuted: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  handleTerminalDataCapture: (sessionId: string, data: string) => void;
  handleBroadcastInput: (data: string, sourceSessionId: string) => void;
  handleBroadcastInterruptPriorityChange: (sessionId: string, prioritize: (() => void) | null) => void;
  handleSnippetExecutorChange: (sessionId: string, executor: SnippetExecutor | null) => void;
  handleProgrammaticCommandLogRewriteChange: (
    sessionId: string,
    queueRewrite: ((rewrite: ProgrammaticCommandLogRewrite) => void) | null,
  ) => void;
  handleTerminalFontSizeChange: (sessionId: string, nextFontSize: number) => void;
  handleOpenSftp: (host: Host, initialPath?: string, pendingUploadEntries?: DropEntry[], sourceSessionId?: string) => void;
  handlePendingUploadHandled: (tabId: string, requestId: string) => void;
  handleSftpInitialLocationApplied: (tabId: string, location: { hostId: string; path: string }) => void;
  handleSftpCurrentPathChange: (memoryKey: string, location: { hostId: string; path: string }) => void;
  handleSidePanelResizeStart: (e: React.MouseEvent) => void;
  handleToggleWorkspaceComposeBar: () => void;
  handleSwitchSidePanelTab: (tab: SidePanelTab) => void;
  handleToggleSftpFromBar: () => void;
  handleOpenScripts: () => void;
  handleOpenHistory: () => void;
  handleHistoryPaste: (command: string) => void;
  handleHistoryRun: (command: string) => void;
  handleToggleScriptsSidePanel: () => void;
  handleToggleSidePanel: () => void;
  handleOpenTheme: () => void;
  handleOpenAI: () => void;
  handleOpenSystem: () => void;
  handleOpenNotes: () => void;
  handleBackFromNotes: () => void;
  handleOpenHostFromNotes: (host: Host, source?: { noteId?: string }) => void;
  handleAddSelectionToAI: (sourceSessionId: string, selection: string) => void;
  handlePendingTerminalSelectionConsumed: (requestId: string) => void;
  handleToggleAiFromTopBar: () => void;
  resolveSftpHostForTab: (tabId: string) => Host | null;
  handleCloseSidePanel: () => void;
  getTerminalCwd: () => Promise<string | null>;
  refocusTerminalSession: (sessionId?: string | null) => void;
  refocusActiveTerminalSession: () => void;
  onSessionData: ReturnType<typeof import('../../application/state/useTerminalBackend').useTerminalBackend>['onSessionData'];
  toggleScriptsSidePanelRef?: React.MutableRefObject<(() => void) | null>;
  toggleSidePanelRef?: React.MutableRefObject<(() => void) | null>;
  accentMode: 'theme' | 'custom';
  customAccent: string;
  followAppTerminalTheme: boolean;
  terminalTheme: TerminalTheme;
  terminalFontFamilyId: string;
  fontSize: number;
  terminalSettings: TerminalLayerProps['terminalSettings'];
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  snippetPackages: string[];
  notes: VaultNote[];
  noteGroups: string[];
  knownHosts: KnownHost[];
  hotkeyScheme: TerminalLayerProps['hotkeyScheme'];
  disableTerminalFontZoom: TerminalLayerProps['disableTerminalFontZoom'];
  restoreTerminalCwd: TerminalLayerProps['restoreTerminalCwd'];
  keyBindings: TerminalLayerProps['keyBindings'];
  onHotkeyAction: TerminalLayerProps['onHotkeyAction'];
  onConnectToHost: TerminalLayerProps['onConnectToHost'];
  onCreateLocalTerminal: TerminalLayerProps['onCreateLocalTerminal'];
  onReorderWorkspaceSessions: TerminalLayerProps['onReorderWorkspaceSessions'];
  onReorderTabs: TerminalLayerProps['onReorderTabs'];
  onCopySession: TerminalLayerProps['onCopySession'];
  onCopySessionToNewWindow: TerminalLayerProps['onCopySessionToNewWindow'];
  onUpdateSessionRestoreCwd: TerminalLayerProps['onUpdateSessionRestoreCwd'];
  onUpdateSessionDynamicTitle: TerminalLayerProps['onUpdateSessionDynamicTitle'];
  onUpdateSessionCodingCliProvider: TerminalLayerProps['onUpdateSessionCodingCliProvider'];
  onRequestAddToWorkspace: TerminalLayerProps['onRequestAddToWorkspace'];
  onSetWorkspaceFocusedSession: TerminalLayerProps['onSetWorkspaceFocusedSession'];
  onToggleWorkspaceViewMode: TerminalLayerProps['onToggleWorkspaceViewMode'];
  onSplitSession: TerminalLayerProps['onSplitSession'];
  isBroadcastEnabled: TerminalLayerProps['isBroadcastEnabled'];
  updateHosts: TerminalLayerProps['updateHosts'];
  updateSnippets: TerminalLayerProps['updateSnippets'];
  updateSnippetPackages: TerminalLayerProps['updateSnippetPackages'];
  updateNotes: TerminalLayerProps['updateNotes'];
  updateNoteGroups: TerminalLayerProps['updateNoteGroups'];
  sftpDefaultViewMode: TerminalLayerProps['sftpDefaultViewMode'];
  sftpDoubleClickBehavior: TerminalLayerProps['sftpDoubleClickBehavior'];
  sftpAutoSync: TerminalLayerProps['sftpAutoSync'];
  sftpShowHiddenFiles: TerminalLayerProps['sftpShowHiddenFiles'];
  sftpUseCompressedUpload: TerminalLayerProps['sftpUseCompressedUpload'];
  sessionLogConfig: { enabled: true; directory: string; format: string; timestampsEnabled?: boolean } | undefined;
  sshDebugLogsEnabled: boolean;
  groupConfigs: GroupConfig[];
  proxyProfiles: ProxyProfile[];
  shellHistory: import('../../types').ShellHistoryEntry[];
};
