/**
 * TextEditorPane — pure Monaco editor body + toolbar.
 * Extracted from TextEditorModal.tsx. Contains no Dialog shell.
 * Parents (modal or tab) own content state, saving state, and toast calls.
 */
import {
  CloudUpload,
  Loader2,
  Maximize2,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import Editor, { type OnMount, loader, useMonaco } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';

// Configure Monaco to use local files instead of CDN
const viteEnv = import.meta.env ?? { BASE_URL: "/" };
const monacoBasePath = viteEnv.DEV
  ? './node_modules/monaco-editor/min/vs'
  : `${viteEnv.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoBasePath } });

import { useI18n } from '../../application/i18n/I18nProvider';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
import { HotkeyScheme, KeyBinding, matchesKeyBinding } from '../../domain/models';
import { useNetcattyMonacoTheme } from '../../infrastructure/monaco/useNetcattyMonacoTheme';
import { getLanguageName, getSupportedLanguages } from '../../lib/sftpFileUtils';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

// Map our language IDs to Monaco language IDs
const languageIdToMonaco = (langId: string): string => {
  const mapping: Record<string, string> = {
    'javascript': 'javascript',
    'typescript': 'typescript',
    'python': 'python',
    'shell': 'shell',
    'batch': 'bat',
    'powershell': 'powershell',
    'c': 'c',
    'cpp': 'cpp',
    'java': 'java',
    'kotlin': 'kotlin',
    'go': 'go',
    'rust': 'rust',
    'ruby': 'ruby',
    'php': 'php',
    'perl': 'perl',
    'lua': 'lua',
    'r': 'r',
    'swift': 'swift',
    'dart': 'dart',
    'csharp': 'csharp',
    'fsharp': 'fsharp',
    'vb': 'vb',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'json': 'json',
    'jsonc': 'json',
    'json5': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'toml': 'ini',
    'ini': 'ini',
    'sql': 'sql',
    'graphql': 'graphql',
    'markdown': 'markdown',
    'plaintext': 'plaintext',
    'vue': 'html',
    'svelte': 'html',
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'diff': 'diff',
  };
  return mapping[langId] || 'plaintext';
};

export interface TextEditorPaneProps {
  fileName: string;
  content: string;
  languageId: string;
  wordWrap: boolean;
  saving: boolean;
  saveError: string | null;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  /** Layout mode — affects header chrome (modal shows close+maximize; tab-form only shows content controls since tab has its own close). */
  chrome: 'modal' | 'tab';
  /** Optional secondary label shown next to the filename in muted text — used by the tab form to display `host:remotePath`. */
  subtitle?: string;
  onContentChange: (content: string, viewState: Monaco.editor.ICodeEditorViewState | null) => void;
  onLanguageChange: (nextLanguageId: string) => void;
  onToggleWordWrap: () => void;
  onSave: () => void;
  onRequestClose?: () => void;   // modal only
  onPromoteToTab?: () => void;   // modal only — omit to hide the maximize button
  initialViewState?: Monaco.editor.ICodeEditorViewState | null;
}

export const isTextEditorReadOnly = ({ saving }: { saving: boolean }): boolean => saving;

export const canPromoteTextEditor = ({ saving }: { saving: boolean }): boolean => !saving;

export function getTextEditorContentStats(content: string): { lineCount: number; charCount: number } {
  let lineCount = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lineCount += 1;
  }
  return { lineCount, charCount: content.length };
}

export const TextEditorPromoteButton: React.FC<{
  saving: boolean;
  onPromoteToTab: () => void;
  title: string;
}> = React.memo(({ saving, onPromoteToTab, title }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={onPromoteToTab}
        disabled={!canPromoteTextEditor({ saving })}
      >
        <Maximize2 size={13} />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{title}</TooltipContent>
  </Tooltip>
));
TextEditorPromoteButton.displayName = 'TextEditorPromoteButton';

const TextEditorPaneInner: React.FC<TextEditorPaneProps> = ({
  fileName,
  content,
  languageId,
  wordWrap,
  saving,
  saveError,
  hotkeyScheme,
  keyBindings,
  chrome,
  subtitle,
  onContentChange,
  onLanguageChange,
  onToggleWordWrap,
  onSave,
  onRequestClose,
  onPromoteToTab,
  initialViewState,
}) => {
  const { t } = useI18n();
  const { readClipboardText: readClipboardTextFromBridge } = useClipboardBackend();
  const monaco = useMonaco();
  const customThemeName = useNetcattyMonacoTheme(monaco);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // Ref to store the latest save function to avoid stale closure in keyboard shortcut
  const handleSaveRef = useRef<() => void>(() => {});
  const handleCloseRef = useRef<(() => void) | null>(null);
  const handlePasteRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const readClipboardTextRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));

  const closeTabBinding = useMemo(
    () => keyBindings.find((binding) => binding.action === 'closeTab'),
    [keyBindings],
  );

  const handleSave = useCallback(() => {
    if (saving) return;
    onSave();
  }, [saving, onSave]);

  // Keep the ref updated with the latest handleSave function
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  // Keep the close ref fresh so the Monaco Cmd/Ctrl+W command invokes the
  // latest onRequestClose handler without re-binding the Monaco command.
  useEffect(() => {
    handleCloseRef.current = onRequestClose ?? null;
  }, [onRequestClose]);

  const readClipboardText = useCallback(async (): Promise<string | null> => {
    try {
      if (navigator.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
    } catch {
      // Fall through to Electron bridge
    }

    try {
      return await readClipboardTextFromBridge();
    } catch {
      // Both clipboard APIs unavailable; signal failure so caller can fall back.
      return null;
    }
  }, [readClipboardTextFromBridge]);

  useEffect(() => {
    readClipboardTextRef.current = readClipboardText;
  }, [readClipboardText]);

  const handlePaste = useCallback(async () => {
    if (saving) return;
    const editor = editorRef.current;
    if (!editor) return;

    const text = await readClipboardText();
    if (text === null) {
      // Clipboard read unavailable; fall back to Monaco's native paste.
      editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
      return;
    }
    if (!text) return;

    const selections = editor.getSelections();
    if (!selections || selections.length === 0) return;

    // Match Monaco's default multicursorPaste:'spread' behavior:
    // distribute one line per cursor when line count equals cursor count.
    const lines = text.split(/\r\n|\n/);
    const distribute = selections.length > 1 && lines.length === selections.length;

    editor.executeEdits(
      'netcatty-paste',
      selections.map((selection, i) => ({
        range: selection,
        text: distribute ? lines[i] : text,
        forceMoveMarkers: true,
      })),
    );
    editor.focus();
  }, [readClipboardText, saving]);

  useEffect(() => {
    handlePasteRef.current = handlePaste;
  }, [handlePaste]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (saving) return;
    const editor = editorRef.current;
    onContentChange(value ?? '', editor ? editor.saveViewState() : null);
  }, [onContentChange, saving]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

    if (initialViewState) editor.restoreViewState(initialViewState);

    // Add save shortcut - use ref to avoid stale closure
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSaveRef.current();
    });

    // Close-tab shortcut inside Monaco. The capture-phase keydown on the
    // Pane's root div also tries to handle this, but Monaco's internal
    // key-event dispatcher fires first for focused editor keystrokes, so
    // registering the command here is the reliable path.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
      handleCloseRef.current?.();
    });

    // Add find shortcut (Ctrl+F / Cmd+F)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
      // Trigger Monaco's built-in find widget
      editor.trigger('keyboard', 'actions.find', null);
    });

    // Fallback paste path for Electron environments where Monaco paste can fail.
    // Skip custom paste when focus is inside the find/replace widget so that
    // its input fields receive the pasted text via default browser behavior.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {
      const active = document.activeElement;
      if (active?.closest('.find-widget')) {
        // Read clipboard and insert into the find/replace input field.
        void (async () => {
          try {
            const text = await readClipboardTextRef.current();
            if (!text) return;
            // Monaco find widget inputs are <textarea> elements inside .monaco-inputbox
            if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
              const start = active.selectionStart ?? active.value.length;
              const end = active.selectionEnd ?? active.value.length;
              active.focus();
              active.setSelectionRange(start, end);
              document.execCommand('insertText', false, text);
            }
          } catch {
            // Ignore – paste simply won't work
          }
        })();
        return;
      }
      void handlePasteRef.current();
    });

    editor.focus();
  }, [initialViewState]);

  // Capture-phase close-tab hotkey handler. Runs in both modal and tab chrome
  // so Cmd/Ctrl+W works even when focus is inside Monaco (which otherwise
  // swallows the event). Requires an `onRequestClose` prop from the parent.
  const handleDialogKeyDownCapture = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (hotkeyScheme === 'disabled' || !closeTabBinding || !onRequestClose) return;

    const isMac = hotkeyScheme === 'mac';
    const keyStr = isMac ? closeTabBinding.mac : closeTabBinding.pc;
    if (!matchesKeyBinding(e.nativeEvent, keyStr, isMac)) return;

    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
    onRequestClose();
  }, [closeTabBinding, hotkeyScheme, onRequestClose]);

  // Trigger search dialog
  const handleSearch = useCallback(() => {
    if (editorRef.current) {
      editorRef.current.trigger('keyboard', 'actions.find', null);
      editorRef.current.focus();
    }
  }, []);

  const supportedLanguages = useMemo(() => getSupportedLanguages(), []);
  const monacoLanguage = useMemo(() => languageIdToMonaco(languageId), [languageId]);
  const languageName = useMemo(() => getLanguageName(languageId), [languageId]);
  const contentStats = useMemo(() => getTextEditorContentStats(content), [content]);
  const languageOptions = useMemo(
    () => supportedLanguages.map((lang) => ({ value: lang.id, label: lang.name })),
    [supportedLanguages],
  );

  return (
    <div
      className="h-full flex flex-col"
      onKeyDownCapture={handleDialogKeyDownCapture}
      data-hotkey-close-tab={chrome === 'modal' ? 'true' : undefined}
    >
      {/* Header */}
      <div className="h-9 px-3 py-1.5 border-b border-border/60 flex-shrink-0">
        <div className="flex h-full items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-sm font-semibold leading-none truncate flex-shrink-0">
              {fileName}
            </span>
            {subtitle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs leading-none text-muted-foreground truncate cursor-default">
                    {subtitle}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{subtitle}</TooltipContent>
              </Tooltip>
            )}
            {saveError && <span className="text-xs leading-none text-destructive truncate">{saveError}</span>}
          </div>
          <div className="flex h-6 items-center gap-2 min-w-0">
            {/* Search button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleSearch}
                >
                  <Search size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('common.search')}</TooltipContent>
            </Tooltip>

            {/* Word wrap toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={wordWrap ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-6 w-6"
                  onClick={onToggleWordWrap}
                >
                  <WrapText size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sftp.editor.wordWrap')}</TooltipContent>
            </Tooltip>

            {/* Language selector */}
            <Combobox
              options={languageOptions}
              value={languageId}
              onValueChange={(v) => onLanguageChange(v || 'plaintext')}
              placeholder={t('sftp.editor.syntaxHighlight')}
              triggerClassName="h-6 max-w-[170px] min-w-[112px] text-xs"
            />

            {/* Save button */}
            <Button
              variant="default"
              size="sm"
              className="h-6 px-2.5 text-xs"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <Loader2 size={13} className="mr-1 animate-spin" />
              ) : (
                <CloudUpload size={13} className="mr-1" />
              )}
              {saving ? t('sftp.editor.saving') : t('sftp.editor.save')}
            </Button>

            {/* Maximize button — modal chrome only, when onPromoteToTab is provided */}
            {chrome === 'modal' && onPromoteToTab && (
              <TextEditorPromoteButton
                saving={saving}
                onPromoteToTab={onPromoteToTab}
                title={t('sftp.editor.maximize')}
              />
            )}

            {/* Close button — modal chrome only */}
            {chrome === 'modal' && onRequestClose && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={onRequestClose}
              >
                <X size={13} />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          language={monacoLanguage}
          value={content}
          onChange={handleEditorChange}
          onMount={handleEditorMount}
          theme={customThemeName}
          loading={
            <div className="absolute inset-0 flex items-center justify-center bg-background">
              <Loader2 size={32} className="animate-spin text-muted-foreground" />
            </div>
          }
          options={{
            // Prefer native context menu in Electron so right-click Paste uses OS clipboard path.
            contextmenu: false,
            minimap: { enabled: true },
            fontSize: 14,
            lineNumbers: 'on',
            roundedSelection: false,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            insertSpaces: true,
            wordWrap: wordWrap ? 'on' : 'off',
            readOnly: isTextEditorReadOnly({ saving }),
            domReadOnly: isTextEditorReadOnly({ saving }),
            folding: true,
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'selection',
            },
          }}
        />
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground bg-muted/30 flex-shrink-0">
        <span>
          {languageName}
        </span>
        <span>
          {contentStats.lineCount} lines • {contentStats.charCount} characters
        </span>
      </div>
    </div>
  );
};

export const TextEditorPane = React.memo(TextEditorPaneInner);
TextEditorPane.displayName = 'TextEditorPane';

export default TextEditorPane;
