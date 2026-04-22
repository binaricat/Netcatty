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
import { toast } from '../ui/toast';
import { TextEditorPane } from './TextEditorPane';

export interface TextEditorTabViewProps {
  tabId: EditorTabId;
  /** When false the view is hidden via display:none so the Monaco instance persists. */
  isVisible: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
}

export const TextEditorTabView: React.FC<TextEditorTabViewProps> = ({
  tabId,
  isVisible,
  hotkeyScheme,
  keyBindings,
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
    if (!tab) return;
    editorTabStore.setWordWrap(tabId, !tab.wordWrap);
  }, [tabId, tab]);

  const handleSave = useCallback(async () => {
    if (!tab) return;
    if (tab.savingState === 'saving') return;

    editorTabStore.setSavingState(tabId, 'saving');
    try {
      await editorSftpWrite(tab.sessionId, tab.hostId, tab.remotePath, tab.content);
      editorTabStore.markSaved(tabId, tab.content);
      toast.success(t('sftp.editor.saved'), 'SFTP');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('sftp.editor.saveFailed');
      editorTabStore.setSavingState(tabId, 'error', msg);
      toast.error(msg, 'SFTP');
    }
  }, [tab, tabId, t]);

  // Tab has been closed — render nothing (parent should remove this instance,
  // but guard here in case of a transient render before unmount).
  if (!tab) return null;

  const isDirty = tab.content !== tab.baselineContent;

  return (
    <div style={{ display: isVisible ? undefined : 'none' }} className="h-full">
      <TextEditorPane
        chrome="tab"
        fileName={`${tab.fileName}${isDirty ? ' *' : ''}`}
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
