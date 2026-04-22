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
import { useI18n } from '../application/i18n/I18nProvider';
import type { HotkeyScheme, KeyBinding } from '../domain/models';

/** Snapshot passed to `onPromoteToTab` when the user clicks the maximize button. */
export interface TextEditorModalSnapshot {
  /** The file name at the time of promotion (modal's fileName prop). */
  fileName: string;
  /** The clean baseline content at the time the modal was opened. */
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [languageId, setLanguageId] = useState(() => getLanguageId(fileName));

  // Latest view state captured from Pane's onContentChange — used by handlePromote
  const viewStateRef = useRef<Monaco.editor.ICodeEditorViewState | null>(null);

  // Derived: whether the current content differs from the clean baseline
  const hasChanges = content !== initialContent;

  // Reset all state when a new file is opened
  useEffect(() => {
    setContent(initialContent);
    setSaveError(null);
    setLanguageId(getLanguageId(fileName));
    viewStateRef.current = null;
  }, [initialContent, fileName]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(content);
      toast.success(t('sftp.editor.saved'), 'SFTP');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('sftp.editor.saveFailed');
      setSaveError(msg);
      toast.error(msg, 'SFTP');
    } finally {
      setSaving(false);
    }
  }, [content, onSave, saving, t]);

  const handleClose = useCallback(() => {
    if (hasChanges) {
      const confirmed = confirm(t('sftp.editor.unsavedChanges'));
      if (!confirmed) return;
    }
    onClose();
  }, [hasChanges, onClose, t]);

  const handleContentChange = useCallback(
    (nextContent: string, viewState: Monaco.editor.ICodeEditorViewState | null) => {
      setContent(nextContent);
      viewStateRef.current = viewState;
    },
    [],
  );

  const handlePromote = useCallback(() => {
    if (!onPromoteToTab) return;
    onPromoteToTab({
      fileName,
      baselineContent: initialContent,
      content,
      languageId,
      wordWrap: editorWordWrap,
      viewState: viewStateRef.current,
    });
  }, [onPromoteToTab, fileName, initialContent, content, languageId, editorWordWrap]);

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
