/**
 * TextEditorModal - Modal for editing text files in SFTP with syntax highlighting
 */
import {
  CloudUpload,
  Loader2,
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

import { useI18n } from '../application/i18n/I18nProvider';
import { useClipboardBackend } from '../application/state/useClipboardBackend';
import { HotkeyScheme, KeyBinding, matchesKeyBinding } from '../domain/models';
import { getLanguageId, getLanguageName, getSupportedLanguages } from '../lib/sftpFileUtils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Combobox } from './ui/combobox';
import { toast } from './ui/toast';

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
}

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
}) => {
  const { t } = useI18n();
  const { readClipboardText: readClipboardTextFromBridge } = useClipboardBackend();
  const monaco = useMonaco();
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [languageId, setLanguageId] = useState(() => getLanguageId(fileName));
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // Ref to store the latest save function to avoid stale closure in keyboard shortcut
  const handleSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
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

  // Reset content when file changes
  useEffect(() => {
    setContent(initialContent);
    setHasChanges(false);
    setLanguageId(getLanguageId(fileName));
  }, [initialContent, fileName]);

  // Track changes
  useEffect(() => {
    setHasChanges(content !== initialContent);
  }, [content, initialContent]);

  const closeTabBinding = useMemo(
    () => keyBindings.find((binding) => binding.action === 'closeTab'),
    [keyBindings],
  );

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(content);
      setHasChanges(false);
      toast.success(t('sftp.editor.saved'), 'SFTP');
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t('sftp.editor.saveFailed'),
        'SFTP'
      );
    } finally {
      setSaving(false);
    }
  }, [content, onSave, saving, t]);

  // Keep the ref updated with the latest handleSave function
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

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

  const handleClose = useCallback(() => {
    if (hasChanges) {
      const confirmed = confirm(t('sftp.editor.unsavedChanges'));
      if (!confirmed) return;
    }
    onClose();
  }, [hasChanges, onClose, t]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    setContent(value || '');
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

    // Add save shortcut - use ref to avoid stale closure
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSaveRef.current();
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
  }, []);

  useEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const handleDialogKeyDownCapture = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (hotkeyScheme === 'disabled' || !closeTabBinding) return;

    const isMac = hotkeyScheme === 'mac';
    const keyStr = isMac ? closeTabBinding.mac : closeTabBinding.pc;
    if (!matchesKeyBinding(e.nativeEvent, keyStr, isMac)) return;

    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
    handleClose();
  }, [closeTabBinding, handleClose, hotkeyScheme]);

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

  const handleLanguageChange = useCallback((nextValue: string) => {
    setLanguageId(nextValue || 'plaintext');
  }, []);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent
        className="max-w-5xl h-[85vh] flex flex-col p-0 gap-0"
        hideCloseButton
        data-hotkey-close-tab="true"
        onKeyDownCapture={handleDialogKeyDownCapture}
      >
        {/* Header */}
        <DialogHeader className="px-4 py-3 border-b border-border/60 flex-shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <DialogTitle className="text-sm font-semibold truncate">
                {fileName}
                {hasChanges && <span className="text-primary ml-1">*</span>}
              </DialogTitle>
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
                variant={editorWordWrap ? 'secondary' : 'ghost'}
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
                onValueChange={handleLanguageChange}
                placeholder={t('sftp.editor.syntaxHighlight')}
                triggerClassName="h-7 max-w-[180px] min-w-[120px] text-xs"
              />

              {/* Save button */}
              <Button
                variant="default"
                size="sm"
                className="h-7"
                onClick={handleSave}
                disabled={saving || !hasChanges}
              >
                {saving ? (
                  <Loader2 size={14} className="mr-1.5 animate-spin" />
                ) : (
                  <CloudUpload size={14} className="mr-1.5" />
                )}
                {saving ? t('sftp.editor.saving') : t('sftp.editor.save')}
              </Button>

              {/* Close button */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleClose}
              >
                <X size={14} />
              </Button>
            </div>
          </div>
        </DialogHeader>

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
              wordWrap: editorWordWrap ? 'on' : 'off',
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
      </DialogContent>
    </Dialog>
  );
};

export default TextEditorModal;
