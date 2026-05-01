/**
 * TextEditorModal - Dialog shell for editing text files in SFTP.
 * Delegates all editor chrome to TextEditorPane.
 */
import type * as Monaco from 'monaco-editor';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { getLanguageId } from '../lib/sftpFileUtils';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { toast } from './ui/toast';
import { TextEditorPane } from './editor/TextEditorPane';
import { promptUnsavedChanges } from './editor/UnsavedChangesDialog';
import { useI18n } from '../application/i18n/I18nProvider';
import { scheduleWindowInputFocus } from '../application/state/windowInputFocus';
import type { HotkeyScheme, KeyBinding } from '../domain/models';

/** Snapshot passed to `onPromoteToTab` when the user clicks the maximize button. */
export interface TextEditorModalSnapshot {
  /** The file name at the time of promotion (modal's fileName prop). */
  fileName: string;
  /** The clean baseline content at the time of promotion. */
  baselineContent: string;
  /** The current (possibly-dirty) editor content. */
  content: string;
  /** The current language ID selected by the user (may differ from file-detected default). */
  languageId: string;
  /** The current word-wrap state (carried over so the tab opens with the same setting). */
  wordWrap: boolean;
  /** The latest Monaco view state (scroll position, cursor, etc.) — may be null before first edit. */
  viewState: Monaco.editor.ICodeEditorViewState | null;
}

interface TextEditorModalProps {
  open: boolean;
  onClose: () => void;
  fileName: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  editorWordWrap: boolean;
  onToggleWordWrap: () => void;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  /** If provided, a maximize button is shown in the Pane header. */
  onPromoteToTab?: (snapshot: TextEditorModalSnapshot) => void;
}

export const TextEditorModal: React.FC<TextEditorModalProps> = ({
  open,
  onClose,
  fileName,
  initialContent,
  onSave,
  editorWordWrap,
  onToggleWordWrap,
  hotkeyScheme,
  keyBindings,
  onPromoteToTab,
}) => {
  const { t } = useI18n();

  const [content, setContent] = useState(initialContent);
  const [baselineContent, setBaselineContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [languageId, setLanguageId] = useState(() => getLanguageId(fileName));
  const contentRef = useRef(initialContent);
  const baselineContentRef = useRef(initialContent);
  const savingRef = useRef(false);
  const closePromptRef = useRef<Promise<void> | null>(null);

  // Latest view state captured from Pane's onContentChange — used by handlePromote
  const viewStateRef = useRef<Monaco.editor.ICodeEditorViewState | null>(null);

  // Derived: whether the current content differs from the clean baseline
  const hasChanges = content !== baselineContent;

  // Reset all state when a new file is opened
  useEffect(() => {
    setContent(initialContent);
    setBaselineContent(initialContent);
    setSaveError(null);
    setSaving(false);
    setLanguageId(getLanguageId(fileName));
    contentRef.current = initialContent;
    baselineContentRef.current = initialContent;
    savingRef.current = false;
    closePromptRef.current = null;
    viewStateRef.current = null;
  }, [initialContent, fileName]);

  const saveContent = useCallback(async (contentToSave = contentRef.current): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(contentToSave);
      setBaselineContent(contentToSave);
      baselineContentRef.current = contentToSave;
      toast.success(t('sftp.editor.saved'), 'SFTP');
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('sftp.editor.saveFailed');
      setSaveError(msg);
      toast.error(msg, 'SFTP');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onSave, t]);

  const handleSave = useCallback(async () => {
    await saveContent();
  }, [saveContent]);

  const handleClose = useCallback(() => {
    if (closePromptRef.current) return;

    const closeTask = (async () => {
      if (contentRef.current !== baselineContentRef.current) {
        const choice = await promptUnsavedChanges(fileName);
        if (choice === 'cancel') return;
        if (choice === 'save') {
          const saved = await saveContent();
          if (!saved) return;
        }
      }
      onClose();
      scheduleWindowInputFocus();
    })().finally(() => {
      closePromptRef.current = null;
    });

    closePromptRef.current = closeTask;
  }, [fileName, onClose, saveContent]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    baselineContentRef.current = baselineContent;
  }, [baselineContent]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    if (!open) {
      closePromptRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (open) scheduleWindowInputFocus();
  }, [open]);

  const handleContentChange = useCallback(
    (nextContent: string, viewState: Monaco.editor.ICodeEditorViewState | null) => {
      setContent(nextContent);
      contentRef.current = nextContent;
      viewStateRef.current = viewState;
    },
    [],
  );

  const handlePromote = useCallback(() => {
    if (!onPromoteToTab) return;
    onPromoteToTab({
      fileName,
      baselineContent,
      content,
      languageId,
      wordWrap: editorWordWrap,
      viewState: viewStateRef.current,
    });
  }, [onPromoteToTab, fileName, baselineContent, content, languageId, editorWordWrap]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent
        className="max-w-5xl h-[85vh] flex flex-col p-0 gap-0"
        hideCloseButton
      >
        {/* Radix requires a DialogTitle inside every DialogContent for a11y.
            The Pane's own header already shows the filename visually, so we
            mirror it here inside an sr-only DialogTitle for screen readers. */}
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <TextEditorPane
          chrome="modal"
          fileName={`${fileName}${hasChanges ? ' *' : ''}`}
          content={content}
          languageId={languageId}
          wordWrap={editorWordWrap}
          saving={saving}
          saveError={saveError}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          onContentChange={handleContentChange}
          onLanguageChange={setLanguageId}
          onToggleWordWrap={onToggleWordWrap}
          onSave={handleSave}
          onRequestClose={handleClose}
          onPromoteToTab={onPromoteToTab ? handlePromote : undefined}
        />
      </DialogContent>
    </Dialog>
  );
};

export default TextEditorModal;
