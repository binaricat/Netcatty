/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { Suspense, lazy } from 'react';
import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import { activeTabStore, toEditorTabId } from '../state/activeTabStore';
import { editorTabStore } from '../state/editorTabStore';
import { releaseEditorTabSaveCoordinator, saveEditorTab } from '../state/editorTabSave';
import { TopTabs } from '../../components/TopTabs';
import { VaultView } from '../../components/VaultView';
import { QuickAddSnippetDialog } from '../../components/QuickAddSnippetDialog';
import { AddToWorkspaceDialog } from '../../components/workspace/AddToWorkspaceDialog';
import { KeyboardInteractiveModal } from '../../components/KeyboardInteractiveModal';
import { PassphraseModal } from '../../components/PassphraseModal';
import { TextEditorTabView } from '../../components/editor/TextEditorTabView';
import { UnsavedChangesProvider } from '../../components/editor/UnsavedChangesDialog';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from '../../components/ui/toast';
import { cn } from '../../lib/utils';

const LazyProtocolSelectDialog = lazy(() => import('../../components/ProtocolSelectDialog'));
const LazyQuickSwitcher = lazy(() =>
  import('../../components/QuickSwitcher').then((m) => ({ default: m.QuickSwitcher })),
);
const LazyCreateWorkspaceDialog = lazy(() =>
  import('../../components/CreateWorkspaceDialog').then((m) => ({ default: m.CreateWorkspaceDialog })),
);

type AppViewContext = Record<string, any>;

export function AppView({ ctx }: { ctx: AppViewContext }) {
  const {
    accentMode, activeTabId, activeTerminalTheme, addShellHistoryEntry, addSessionToWorkspace, addToWorkspaceDialog, appendHostToWorkspace, appendLocalTerminalToWorkspace,
    clearAndRemoveSource, clearAndRemoveSources, clearUnsavedConnectionLogs, closeLogView, closeSession, closeTabsBatch, closeWorkspace, copySessionWithCurrentShell,
    connectionLogs, convertKnownHostToHost, createWorkspaceFromSessions, createWorkspaceFromTargets, createWorkspaceWithHosts, customAccent,
    customGroups, currentTerminalTheme, deleteConnectionLog, draggingSessionId, effectiveKnownHosts, editorTabs, editorWordWrap, emptyVaultConflict,
    followAppTerminalTheme, groupConfigs, handleAddKnownHost, handleConnectSerial, handleConnectToHost, handleCreateLocalTerminal, handleDeleteHost,
    handleEndSessionDrag, handleHostConnectWithProtocolCheck, handleHotkeyAction, handleKeyboardInteractiveCancel, handleKeyboardInteractiveSubmit,
    handleOpenQuickSwitcher, handleOpenSettings, handleRootContextMenu, handlePassphraseCancel, handlePassphraseSkip, handlePassphraseSubmit, handleProtocolSelect,
    handleRequestCloseEditorTabRef, handleSessionStatusChange, handleSyncNowManual, handleTerminalDataCapture, handleToggleTheme, handleUpdateHostFromTerminal,
    hostById, hosts, hotkeyScheme, identities, importOrReuseKey, isBroadcastEnabled, isCreateWorkspaceOpen, isMacClient, isQuickSwitcherOpen,
    keyBindings, keyboardInteractiveQueue, keys, logViews, managedSources, navigateToSection, openLogView, orderedTabsWithEditors, orphanSessions,
    passphraseQueue, protocolSelectHost, proxyProfiles, quickResults, quickSearch, reorderTabs, reorderWorkspaceSessions, resetSessionRename,
    resetWorkspaceRename, resolveEmptyVaultConflict, resolvedTheme, runSnippet, sessionLogsDir, sessionLogsEnabled, sessionLogsFormat, sessionRenameTarget,
    sessionRenameValue, sessions, setActiveTabId, setAddToWorkspaceDialog, setDraggingSessionId, setEditorWordWrap, setIsCreateWorkspaceOpen, setIsQuickSwitcherOpen,
    setNavigateToSection, setProtocolSelectHost, setQuickSearch, setSessionRenameValue, setTerminalFontFamilyId, setTerminalFontSize, setTerminalThemeId,
    setWorkspaceFocusedSession, setWorkspaceRenameValue, settings, sftpAutoOpenSidebar, sftpAutoSync, sftpDefaultViewMode, sftpDoubleClickBehavior,
    sftpShowHiddenFiles, sftpUseCompressedUpload, shellHistory, snippetPackages, snippets, splitSessionWithCurrentShell, startSessionRename,
    startWorkspaceRename, submitSessionRename, submitWorkspaceRename, t, terminalFontFamilyId, terminalFontSize, terminalSettings, terminalThemeId,
    toggleBroadcast, toggleConnectionLogSaved, toggleScriptsSidePanelRef, toggleSidePanelRef, toggleWorkspaceViewMode, unmanageSource, updateConnectionLog,
    updateCustomGroups, updateGroupConfigs, updateHostDistro, updateHosts, updateIdentities, updateKeys, updateKnownHosts, updateManagedSources,
    updateProxyProfiles, updateSnippetPackages, updateSnippets, updateSplitSizes, updateTerminalSetting, workspaceRenameTarget, workspaceRenameValue, workspaces,
    VaultViewContainer, SftpViewMount, TerminalLayerMount, LogViewWrapper,
  } = ctx;

  return (
    <UnsavedChangesProvider>
      {({ prompt }) => {
        // Helper: close an editor tab and activate the neighbor (left-preference), or vault.
        const closeEditorAndActivateNeighbor = (id: string) => {
          const closingTabId = toEditorTabId(id);
          const list = orderedTabsWithEditors;
          const idx = list.indexOf(closingTabId);
          releaseEditorTabSaveCoordinator(id);
          editorTabStore.close(id);
          if (activeTabStore.getActiveTabId() !== closingTabId) return;
          const next = list[idx - 1] ?? list[idx + 1] ?? 'vault';
          activeTabStore.setActiveTabId(next === closingTabId ? 'vault' : next);
        };

        // Real dirty-confirm close handler.
        const handleRequestCloseEditorTab = async (id: string) => {
          const tab = editorTabStore.getTab(id);
          if (!tab) return;
          const dirty = tab.content !== tab.baselineContent;
          if (!dirty) {
            closeEditorAndActivateNeighbor(id);
            return;
          }
          const choice = await prompt(tab.fileName);
          if (choice === 'cancel') return;
          if (choice === 'discard') {
            closeEditorAndActivateNeighbor(id);
            return;
          }
          if (choice === 'save') {
            const ok = await saveEditorTab(id);
            if (!ok) {
              const msg = editorTabStore.getTab(id)?.saveError ?? 'Save failed';
              toast.error(msg, 'SFTP');
              return;
            }
            const latest = editorTabStore.getTab(id);
            if (!latest || latest.content !== latest.baselineContent) return;
            closeEditorAndActivateNeighbor(id);
          }
        };

        // Expose to the hotkey dispatcher (Cmd/Ctrl+W).
        handleRequestCloseEditorTabRef.current = handleRequestCloseEditorTab;

        return (
    <div className={cn("flex flex-col h-screen text-foreground font-sans netcatty-shell", activeTerminalTheme && "immersive-transition")} onContextMenu={handleRootContextMenu}>
      <TopTabs
        theme={resolvedTheme}
        followAppTerminalTheme={followAppTerminalTheme}
        hosts={hosts}
        sessions={sessions}
        orphanSessions={orphanSessions}
        workspaces={workspaces}
        logViews={logViews}
        orderedTabs={orderedTabsWithEditors}
        draggingSessionId={draggingSessionId}
        isMacClient={isMacClient}
        onCloseSession={closeSession}
        onRenameSession={startSessionRename}
        onCopySession={copySessionWithCurrentShell}
        onRenameWorkspace={startWorkspaceRename}
        onCloseWorkspace={closeWorkspace}
        onCloseLogView={closeLogView}
        onCloseTabsBatch={closeTabsBatch}
        onOpenQuickSwitcher={handleOpenQuickSwitcher}
        onToggleTheme={handleToggleTheme}
        onOpenSettings={handleOpenSettings}
        onSyncNow={handleSyncNowManual}
        isImmersiveActive={activeTerminalTheme !== null}
        onStartSessionDrag={setDraggingSessionId}
        onEndSessionDrag={handleEndSessionDrag}
        onReorderTabs={reorderTabs}
        showSftpTab={settings.showSftpTab}
        editorTabs={editorTabs}
        onRequestCloseEditorTab={handleRequestCloseEditorTab}
        hostById={hostById}
      />

      <div className="flex-1 relative min-h-0">
        <VaultViewContainer>
          <VaultView
            hosts={hosts}
            keys={keys}
            identities={identities}
            proxyProfiles={proxyProfiles}
            snippets={snippets}
            snippetPackages={snippetPackages}
            customGroups={customGroups}
            knownHosts={effectiveKnownHosts}
            shellHistory={shellHistory}
            connectionLogs={connectionLogs}
            managedSources={managedSources}
            sessionCount={sessions.length}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            terminalThemeId={terminalThemeId}
            terminalFontSize={terminalFontSize}
            onOpenSettings={handleOpenSettings}
            onOpenQuickSwitcher={handleOpenQuickSwitcher}
            onCreateLocalTerminal={handleCreateLocalTerminal}
            onConnectSerial={handleConnectSerial}
            onDeleteHost={handleDeleteHost}
            onConnect={handleConnectToHost}
            groupConfigs={groupConfigs}
            onUpdateGroupConfigs={updateGroupConfigs}
            onUpdateHosts={updateHosts}
            onUpdateKeys={updateKeys}
            onImportOrReuseKey={importOrReuseKey}
            onUpdateIdentities={updateIdentities}
            onUpdateProxyProfiles={updateProxyProfiles}
            onUpdateSnippets={updateSnippets}
            onUpdateSnippetPackages={updateSnippetPackages}
            onUpdateCustomGroups={updateCustomGroups}
            onUpdateKnownHosts={updateKnownHosts}
            onUpdateManagedSources={updateManagedSources}
            onClearAndRemoveManagedSource={clearAndRemoveSource}
            onClearAndRemoveManagedSources={clearAndRemoveSources}
            onUnmanageSource={unmanageSource}
            onConvertKnownHost={convertKnownHostToHost}
            onToggleConnectionLogSaved={toggleConnectionLogSaved}
            onDeleteConnectionLog={deleteConnectionLog}
            onClearUnsavedConnectionLogs={clearUnsavedConnectionLogs}
            onRunSnippet={runSnippet}
            onOpenLogView={openLogView}
            showRecentHosts={settings.showRecentHosts}
            showOnlyUngroupedHostsInRoot={settings.showOnlyUngroupedHostsInRoot}
            navigateToSection={navigateToSection}
            onNavigateToSectionHandled={() => setNavigateToSection(null)}
            terminalSettings={terminalSettings}
          />
        </VaultViewContainer>

        <SftpViewMount
          hosts={hosts}
          keys={keys}
          identities={identities}
          proxyProfiles={proxyProfiles}
          groupConfigs={groupConfigs}
          updateHosts={updateHosts}
          sftpDefaultViewMode={sftpDefaultViewMode}
          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
          sftpAutoSync={sftpAutoSync}
          sftpShowHiddenFiles={sftpShowHiddenFiles}
          sftpUseCompressedUpload={sftpUseCompressedUpload}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          terminalSettings={terminalSettings}
        />

        <TerminalLayerMount
          hosts={hosts}
          groupConfigs={groupConfigs}
          proxyProfiles={proxyProfiles}
          keys={keys}
          identities={identities}
          snippets={snippets}
          snippetPackages={snippetPackages}
          sessions={sessions}
          workspaces={workspaces}
          knownHosts={effectiveKnownHosts}
          draggingSessionId={draggingSessionId}
          terminalTheme={currentTerminalTheme}
          followAppTerminalTheme={followAppTerminalTheme}
          accentMode={accentMode}
          customAccent={customAccent}
          terminalSettings={terminalSettings}
          terminalFontFamilyId={terminalFontFamilyId}
          fontSize={terminalFontSize}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          onHotkeyAction={handleHotkeyAction}
          onUpdateTerminalThemeId={setTerminalThemeId}
          onUpdateTerminalFontFamilyId={setTerminalFontFamilyId}
          onUpdateTerminalFontSize={setTerminalFontSize}
          onUpdateTerminalFontWeight={(w) => updateTerminalSetting('fontWeight', w)}
          onCloseSession={closeSession}
          onUpdateSessionStatus={handleSessionStatusChange}
          onUpdateHostDistro={updateHostDistro}
          onUpdateHost={handleUpdateHostFromTerminal}
          onAddKnownHost={handleAddKnownHost}
          onCommandExecuted={(command, hostId, hostLabel, sessionId) => {
            addShellHistoryEntry({ command, hostId, hostLabel, sessionId });
          }}
          onTerminalDataCapture={handleTerminalDataCapture}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onRequestAddToWorkspace={(workspaceId) =>
            setAddToWorkspaceDialog({ mode: 'append', workspaceId })
          }
          onUpdateSplitSizes={updateSplitSizes}
          onSetDraggingSessionId={setDraggingSessionId}
          onToggleWorkspaceViewMode={toggleWorkspaceViewMode}
          onSetWorkspaceFocusedSession={setWorkspaceFocusedSession}
          onReorderWorkspaceSessions={reorderWorkspaceSessions}
          onSplitSession={splitSessionWithCurrentShell}
          isBroadcastEnabled={isBroadcastEnabled}
          onToggleBroadcast={toggleBroadcast}
          updateHosts={updateHosts}
          sftpDefaultViewMode={sftpDefaultViewMode}
          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
          sftpAutoSync={sftpAutoSync}
          sftpShowHiddenFiles={sftpShowHiddenFiles}
          sftpUseCompressedUpload={sftpUseCompressedUpload}
          sftpAutoOpenSidebar={sftpAutoOpenSidebar}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          sessionLogsEnabled={sessionLogsEnabled}
          sessionLogsDir={sessionLogsDir}
          sessionLogsFormat={sessionLogsFormat}
          toggleScriptsSidePanelRef={toggleScriptsSidePanelRef}
          toggleSidePanelRef={toggleSidePanelRef}
        />

        {/* Log Views - readonly terminal replays */}
        {logViews.map(logView => {
          // Get the latest log data from connectionLogs to reflect updates
          const latestLog = connectionLogs.find(l => l.id === logView.connectionLogId) || logView.log;
          return (
            <LogViewWrapper
              key={logView.id}
              logView={{ ...logView, log: latestLog }}
              defaultTerminalTheme={currentTerminalTheme}
              defaultFontSize={terminalFontSize}
              onClose={() => closeLogView(logView.id)}
              onUpdateLog={updateConnectionLog}
            />
          );
        })}

        {/* Editor Tabs — kept mounted for Monaco instance persistence; visibility toggled via CSS */}
        {editorTabs.map((tab) => (
          <TextEditorTabView
            key={tab.id}
            tabId={tab.id}
            isVisible={activeTabId === toEditorTabId(tab.id)}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            hostById={hostById}
            onRequestClose={(id) => handleRequestCloseEditorTabRef.current(id)}
          />
        ))}
      </div>

      {/* Global "quick add / edit snippet" dialog, triggered by the
          netcatty:snippets:add and :edit window events (from ScriptsSidePanel
          "+" button and right-click menu). Delete is handled by a sibling
          useEffect above — it does not need a dialog. */}
      <QuickAddSnippetDialog
        snippets={snippets}
        packages={snippetPackages}
        onCreateSnippet={(snippet) => updateSnippets([...snippets, snippet])}
        onUpdateSnippet={(snippet) =>
          updateSnippets(snippets.map((s) => (s.id === snippet.id ? snippet : s)))
        }
        onCreatePackage={(pkg) =>
          updateSnippetPackages(Array.from(new Set([...snippetPackages, pkg])))
        }
      />

      {/* Root-mounted AddToWorkspaceDialog — triggered by the focus-mode
          "+" button (mode='append') or QuickSwitcher's "New Workspace"
          button (mode='create'). Single instance so dialog state and
          styling stay consistent across entry points. */}
      {addToWorkspaceDialog && (
        <AddToWorkspaceDialog
          open
          onOpenChange={(open) => { if (!open) setAddToWorkspaceDialog(null); }}
          // Filter serial hosts only in append mode — appendHostToWorkspace
          // has no serial code path. Create mode goes through
          // createWorkspaceFromTargets, which builds a SerialConfig-backed
          // session for serial hosts, so those should remain pickable.
          hosts={addToWorkspaceDialog.mode === 'append'
            ? hosts.filter((h) => h.protocol !== 'serial')
            : hosts}
          workspaceTitle={
            addToWorkspaceDialog.mode === 'append'
              ? workspaces.find((w) => w.id === addToWorkspaceDialog.workspaceId)?.title
              : 'New Workspace'
          }
          onAdd={(targets) => {
            if (addToWorkspaceDialog.mode === 'append') {
              // Match the workspace root's current split direction so
              // the new panes peer the existing siblings instead of
              // wrapping the whole tree into one side of a fresh split
              // (which would happen if we always passed the helper's
              // default 'vertical').
              const ws = workspaces.find((w) => w.id === addToWorkspaceDialog.workspaceId);
              const rootDir = ws && ws.root.type === 'split' ? ws.root.direction : 'vertical';
              for (const target of targets) {
                if (target.kind === 'local') {
                  appendLocalTerminalToWorkspace(addToWorkspaceDialog.workspaceId, undefined, rootDir);
                } else {
                  appendHostToWorkspace(addToWorkspaceDialog.workspaceId, target.host, rootDir);
                }
              }
            } else {
              createWorkspaceFromTargets(targets);
            }
          }}
        />
      )}

      {isQuickSwitcherOpen && (
        <Suspense fallback={null}>
          <LazyQuickSwitcher
            isOpen={isQuickSwitcherOpen}
            query={quickSearch}
            results={quickResults}
            sessions={sessions}
            workspaces={workspaces}
            showSftpTab={settings.showSftpTab}
            onQueryChange={setQuickSearch}
            onSelect={handleHostConnectWithProtocolCheck}
            onSelectTab={(tabId) => {
              setActiveTabId(tabId);
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
            }}
            onCreateLocalTerminal={(shell) => {
              handleCreateLocalTerminal(shell);
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
            }}
            onCreateWorkspace={() => {
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
              setAddToWorkspaceDialog({ mode: 'create' });
            }}
            onClose={() => {
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
            }}
            keyBindings={keyBindings}
          />
        </Suspense>
      )}

      <Dialog open={!!sessionRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetSessionRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameSession.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="session-name">{t('field.name')}</Label>
            <Input
              id="session-name"
              value={sessionRenameValue}
              onChange={(e) => setSessionRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSessionRename(); }}
              autoFocus
              placeholder={t('placeholder.sessionName')}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetSessionRename}>{t('common.cancel')}</Button>
            <Button onClick={submitSessionRename} disabled={!sessionRenameValue.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!workspaceRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetWorkspaceRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameWorkspace.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-name">{t('field.name')}</Label>
            <Input
              id="workspace-name"
              value={workspaceRenameValue}
              onChange={(e) => setWorkspaceRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitWorkspaceRename(); }}
              autoFocus
              placeholder={t('placeholder.workspaceName')}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetWorkspaceRename}>{t('common.cancel')}</Button>
            <Button onClick={submitWorkspaceRename} disabled={!workspaceRenameValue.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isCreateWorkspaceOpen && (
        <Suspense fallback={null}>
          <LazyCreateWorkspaceDialog
            isOpen={isCreateWorkspaceOpen}
            onClose={() => setIsCreateWorkspaceOpen(false)}
            hosts={hosts}
            onCreate={createWorkspaceWithHosts}
          />
        </Suspense>
      )}

      {/* Protocol Select Dialog for QuickSwitcher */}
      {protocolSelectHost && (
        <Suspense fallback={null}>
          <LazyProtocolSelectDialog
            host={protocolSelectHost}
            onSelect={handleProtocolSelect}
            onCancel={() => setProtocolSelectHost(null)}
          />
        </Suspense>
      )}

      {/* Global Keyboard-Interactive Authentication Modal (2FA/MFA) - processes queue */}
      <KeyboardInteractiveModal
        request={keyboardInteractiveQueue[0] || null}
        onSubmit={handleKeyboardInteractiveSubmit}
        onCancel={handleKeyboardInteractiveCancel}
      />
      {/* Indicator when more 2FA requests are pending */}
      {keyboardInteractiveQueue.length > 1 && (
        <div className="fixed bottom-4 right-4 z-50 bg-muted/90 backdrop-blur-sm text-sm px-3 py-1.5 rounded-full border shadow-sm">
          {keyboardInteractiveQueue.length - 1} more pending
        </div>
      )}

      {/* Global Passphrase Modal for encrypted SSH keys */}
      <PassphraseModal
        request={passphraseQueue[0] || null}
        onSubmit={handlePassphraseSubmit}
        onCancel={handlePassphraseCancel}
        onSkip={handlePassphraseSkip}
      />

      {/* Empty vault vs cloud data confirmation dialog (#679).
          This dialog intentionally cannot be dismissed — the user MUST
          choose "Restore" or "Keep Empty" before the sync flow can
          proceed. hideCloseButton removes the X button, onOpenChange
          is a no-op so ESC also does nothing, and onInteractOutside
          prevents click-away. */}
      <Dialog open={!!emptyVaultConflict} onOpenChange={() => { /* intentionally non-dismissable */ }}>
        <DialogContent className="max-w-md" hideCloseButton onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              {t('sync.autoSync.emptyVaultConflict.title')}
            </DialogTitle>
            <DialogDescription>
              {t('sync.autoSync.emptyVaultConflict.description')}
            </DialogDescription>
          </DialogHeader>
          {emptyVaultConflict && (
            <div className="bg-muted/30 rounded-lg p-3 text-sm">
              <div className="font-medium text-muted-foreground mb-1">{t('sync.autoSync.emptyVaultConflict.cloudLabel')}</div>
              <div>{t('sync.autoSync.emptyVaultConflict.cloudSummary', {
                hosts: emptyVaultConflict.hostCount,
                keys: emptyVaultConflict.keyCount,
                snippets: emptyVaultConflict.snippetCount,
                proxyProfiles: emptyVaultConflict.proxyProfileCount,
              })}</div>
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              onClick={() => resolveEmptyVaultConflict('restore')}
              className="w-full justify-start gap-2"
            >
              <Download className="w-4 h-4" />
              <span>
                {t('sync.autoSync.emptyVaultConflict.restore')}
                <span className="text-xs opacity-70 ml-1">— {t('sync.autoSync.emptyVaultConflict.restoreDesc')}</span>
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={() => resolveEmptyVaultConflict('keep-empty')}
              className="w-full justify-start gap-2"
            >
              <Trash2 className="w-4 h-4" />
              <span>
                {t('sync.autoSync.emptyVaultConflict.keepEmpty')}
                <span className="text-xs opacity-70 ml-1">— {t('sync.autoSync.emptyVaultConflict.keepEmptyDesc')}</span>
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
        );
      }}
    </UnsavedChangesProvider>
  );
}
