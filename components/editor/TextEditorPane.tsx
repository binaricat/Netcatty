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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Configure Monaco to use local files instead of CDN
const monacoBasePath = import.meta.env.DEV
  ? './node_modules/monaco-editor/min/vs'
  : `${import.meta.env.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoBasePath } });

import { useI18n } from '../../application/i18n/I18nProvider';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
import { HotkeyScheme, KeyBinding, matchesKeyBinding } from '../../domain/models';
import { getLanguageName, getSupportedLanguages } from '../../lib/sftpFileUtils';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';

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

// Convert HSL string "h s% l%" to hex color
const hslToHex = (hslString: string): string => {
  const parts = hslString.trim().split(/\s+/);
  if (parts.length < 3) return '#1e1e1e';
  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1].replace('%', '')) / 100;
  const l = parseFloat(parts[2].replace('%', '')) / 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

// Read a CSS custom-property and convert from HSL to hex
const getCssColor = (varName: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return value ? hslToHex(value) : fallback;
};

interface EditorColors {
  bg: string;
  fg: string;
  primary: string;
  card: string;
  mutedFg: string;
  border: string;
}

/** Read all UI CSS variables that matter for the Monaco theme. */
const getEditorColors = (isDark: boolean): EditorColors => ({
  bg: getCssColor('--background', isDark ? '#1e1e1e' : '#ffffff'),
  fg: getCssColor('--foreground', isDark ? '#d4d4d4' : '#1e1e1e'),
  primary: getCssColor('--primary', isDark ? '#569cd6' : '#0078d4'),
  card: getCssColor('--card', isDark ? '#252526' : '#f3f3f3'),
  mutedFg: getCssColor('--muted-foreground', isDark ? '#858585' : '#858585'),
  border: getCssColor('--border', isDark ? '#3c3c3c' : '#d4d4d4'),
});

/** Build a fingerprint string so we can detect immersive-mode color changes cheaply. */
const getThemeSignal = (): string => {
  const root = document.documentElement;
  return root.dataset.immersiveTheme
    ?? getComputedStyle(root).getPropertyValue('--background').trim();
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

export const TextEditorPane: React.FC<TextEditorPaneProps> = ({
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
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // Ref to store the latest save function to avoid stale closure in keyboard shortcut
  const handleSaveRef = useRef<() => void>(() => {});
  const handleCloseRef = useRef<(() => void) | null>(null);
  const handlePasteRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const readClipboardTextRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));

  // Track theme from document.documentElement class (syncs with app theme)
  const [isDarkTheme, setIsDarkTheme] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  // Track a signal that changes whenever immersive-mode or base theme colors change
  const [themeSignal, setThemeSignal] = useState(() => getThemeSignal());

  // Custom theme name
  const customThemeName = isDarkTheme ? 'netcatty-dark' : 'netcatty-light';

  // Define and update custom Monaco themes — syncs with immersive-mode / base UI colors
  useEffect(() => {
    if (!monaco) return;

    const colors = getEditorColors(isDarkTheme);

    const themeColors: Record<string, string> = {
      'editor.background': colors.bg,
      'editor.foreground': colors.fg,
      'editorCursor.foreground': colors.primary,
      'editor.selectionBackground': colors.primary + '40',
      'editor.inactiveSelectionBackground': colors.primary + '25',
      'editorLineNumber.foreground': colors.mutedFg,
      'editorLineNumber.activeForeground': colors.fg,
      'editor.lineHighlightBackground': colors.fg + '08',
      'editorWidget.background': colors.card,
      'editorWidget.foreground': colors.fg,
      'editorWidget.border': colors.border,
      'input.background': colors.card,
      'input.foreground': colors.fg,
      'input.border': colors.border,
    };

    monaco.editor.defineTheme('netcatty-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: themeColors,
    });

    monaco.editor.defineTheme('netcatty-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: themeColors,
    });

    monaco.editor.setTheme(customThemeName);
  }, [monaco, isDarkTheme, themeSignal, customThemeName]);

  // Listen for theme changes via MutationObserver on <html> class, style, and immersive data attr
  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => {
      setIsDarkTheme(root.classList.contains('dark'));
      setThemeSignal(getThemeSignal());
    };
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-immersive-theme'],
    });
    return () => observer.disconnect();
  }, []);

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
  }, [readClipboardText]);

  useEffect(() => {
    handlePasteRef.current = handlePaste;
  }, [handlePaste]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    const editor = editorRef.current;
    onContentChange(value ?? '', editor ? editor.saveViewState() : null);
  }, [onContentChange]);

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
      <div className="px-4 py-3 border-b border-border/60 flex-shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-2 flex-1 min-w-0">
            <span className="text-sm font-semibold truncate flex-shrink-0">
              {fileName}
            </span>
            {subtitle && (
              <span className="text-xs text-muted-foreground truncate" title={subtitle}>
                {subtitle}
              </span>
            )}
            {saveError && <span className="text-xs text-destructive truncate">{saveError}</span>}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            {/* Search button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleSearch}
              title={t('common.search')}
            >
              <Search size={14} />
            </Button>

            {/* Word wrap toggle */}
            <Button
              variant={wordWrap ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={onToggleWordWrap}
              title={t('sftp.editor.wordWrap')}
            >
              <WrapText size={14} />
            </Button>

            {/* Language selector */}
            <Combobox
              options={languageOptions}
              value={languageId}
              onValueChange={(v) => onLanguageChange(v || 'plaintext')}
              placeholder={t('sftp.editor.syntaxHighlight')}
              triggerClassName="h-7 max-w-[180px] min-w-[120px] text-xs"
            />

            {/* Save button */}
            <Button
              variant="default"
              size="sm"
              className="h-7"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              ) : (
                <CloudUpload size={14} className="mr-1.5" />
              )}
              {saving ? t('sftp.editor.saving') : t('sftp.editor.save')}
            </Button>

            {/* Maximize button — modal chrome only, when onPromoteToTab is provided */}
            {chrome === 'modal' && onPromoteToTab && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onPromoteToTab}
                title={t('sftp.editor.maximize')}
              >
                <Maximize2 size={14} />
              </Button>
            )}

            {/* Close button — modal chrome only */}
            {chrome === 'modal' && onRequestClose && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onRequestClose}
              >
                <X size={14} />
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
          {getLanguageName(languageId)}
        </span>
        <span>
          {content.split('\n').length} lines • {content.length} characters
        </span>
      </div>
    </div>
  );
};

export default TextEditorPane;
