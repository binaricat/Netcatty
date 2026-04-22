/**
 * TextEditorTabView — thin wrapper that binds an editorTab entry to TextEditorPane.
 *
 * Each tab has its own instance (keyed by tabId), so Monaco is never torn down
 * on tab-switch — we just toggle CSS visibility via the `isVisible` prop.
 */
import type * as Monaco from 'monaco-editor';
import React, { useCallback } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { editorSftpWrite } from '../../application/state/editorSftpBridge';
import { editorTabStore, useEditorTab, type EditorTabId } from '../../application/state/editorTabStore';
import type { HotkeyScheme, KeyBinding } from '../../domain/models';
import type { Host } from '../../types';
import { toast } from '../ui/toast';
import { TextEditorPane } from './TextEditorPane';

export interface TextEditorTabViewProps {
  tabId: EditorTabId;
  /** When false the view is hidden via display:none so the Monaco instance persists. */
  isVisible: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  /** Host lookup for building the `host:remotePath` subtitle next to the filename. */
  hostById: Map<string, Host>;
  /** Routed into Monaco's Cmd/Ctrl+W command so closing the editor tab works
   * even when focus is inside the editor (Monaco otherwise swallows the event). */
  onRequestClose: (tabId: EditorTabId) => void;
}

export const TextEditorTabView: React.FC<TextEditorTabViewProps> = ({
  tabId,
  isVisible,
  hotkeyScheme,
  keyBindings,
  hostById,
  onRequestClose,
}) => {
  const { t } = useI18n();
  const tab = useEditorTab(tabId);

  const handleContentChange = useCallback(
    (content: string, viewState: Monaco.editor.ICodeEditorViewState | null) => {
      editorTabStore.updateContent(tabId, content, viewState);
    },
    [tabId],
  );

  const handleLanguageChange = useCallback(
    (lang: string) => {
      editorTabStore.setLanguage(tabId, lang);
    },
    [tabId],
  );

  const handleToggleWordWrap = useCallback(() => {
    const current = editorTabStore.getTab(tabId);
    if (!current) return;
    editorTabStore.setWordWrap(tabId, !current.wordWrap);
  }, [tabId]);

  const handleSave = useCallback(async () => {
    // Read live store state at call time — React state snapshot lags the store
    // by one microtask, so a keystroke between onChange and this save would
    // otherwise leave us writing stale content and marking a stale baseline.
    const current = editorTabStore.getTab(tabId);
    if (!current) return;
    if (current.savingState === 'saving') return;

    editorTabStore.setSavingState(tabId, 'saving');
    try {
      await editorSftpWrite(current.sessionId, current.hostId, current.remotePath, current.content);
      editorTabStore.markSaved(tabId, current.content);
      toast.success(t('sftp.editor.saved'), 'SFTP');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('sftp.editor.saveFailed');
      editorTabStore.setSavingState(tabId, 'error', msg);
      toast.error(msg, 'SFTP');
    }
  }, [tabId, t]);

  // Tab has been closed — render nothing (parent should remove this instance,
  // but guard here in case of a transient render before unmount).
  if (!tab) return null;

  const isDirty = tab.content !== tab.baselineContent;
  // Subtitle shown next to the filename in the Pane header, e.g.
  // "Rainyun-114.66.26.174:/root/hello-server.go". Falls back to hostId when
  // we don't have a Host record (session may have been removed).
  const host = hostById.get(tab.hostId);
  const hostLabel = host?.label ?? tab.hostId;
  const subtitle = `${hostLabel}:${tab.remotePath}`;

  return (
    // Sibling tab panels (VaultView, SftpView, TerminalLayerMount, LogView)
    // all fill their flex-1 parent via `absolute inset-0`. Match that here so
    // an inactive editor tab doesn't collapse to zero height in normal flow,
    // and an active one fills the viewport instead of stacking beneath others.
    // z-index high enough to stay above the TerminalLayer's inner `z-10` panels
    // (TerminalLayer root is visibility:hidden when editor tabs are active, but
    // its children's stacking contexts can still overlap without an explicit z.)
    <div
      style={{ display: isVisible ? undefined : 'none', zIndex: 20 }}
      className="absolute inset-0 min-h-0 flex flex-col bg-background"
    >
      <TextEditorPane
        chrome="tab"
        fileName={`${tab.fileName}${isDirty ? ' *' : ''}`}
        subtitle={subtitle}
        onRequestClose={() => onRequestClose(tabId)}
        content={tab.content}
        languageId={tab.languageId}
        wordWrap={tab.wordWrap}
        saving={tab.savingState === 'saving'}
        saveError={tab.saveError}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
        onContentChange={handleContentChange}
        onLanguageChange={handleLanguageChange}
        onToggleWordWrap={handleToggleWordWrap}
        onSave={handleSave}
        initialViewState={tab.viewState}
      />
    </div>
  );
};

export default TextEditorTabView;
