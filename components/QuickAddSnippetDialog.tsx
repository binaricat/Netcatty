/**
 * QuickAddSnippetDialog — lightweight "new / edit snippet" modal mounted at the
 * App root and triggered by the `netcatty:snippets:add` / `:edit` window events.
 *
 * Opens as a centered Dialog so it does not compete with the scripts side panel.
 * Fields: label, command, package, shortkey, multi-line mode.
 * Advanced fields (target hosts, tags) can still be set later in the full
 * Snippets manager.
 */

import { Keyboard, Package, RotateCcw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { Snippet } from '../domain/models';
import { findActiveSystemShortcutConflict } from '../domain/activeKeyBindings';
import {
  type HotkeyScheme,
  type KeyBinding,
  keyEventToString,
  keyStringToKeyboardEvent,
  matchesKeyBinding,
} from '../domain/models';
import { isScriptSnippet } from '../domain/snippetScript.ts';
import { cn, isMacPlatform } from '../lib/utils';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { SnippetScriptEditor } from './snippets/SnippetScriptEditor';

export interface QuickAddSnippetDialogProps {
  snippets: Snippet[];
  packages: string[];
  onCreateSnippet: (snippet: Snippet) => void;
  onUpdateSnippet?: (snippet: Snippet) => void;
  onCreatePackage?: (packagePath: string) => void;
  /** Optional — used to validate shortkey conflicts with system bindings. */
  hotkeyScheme?: HotkeyScheme;
  keyBindings?: KeyBinding[];
}

export function getQuickAddSnippetInitialCommand(event: Event): string {
  const detail = (event as CustomEvent<{ command?: unknown }>).detail;
  return typeof detail?.command === 'string' ? detail.command : '';
}

export const QuickAddSnippetDialog: React.FC<QuickAddSnippetDialogProps> = ({
  snippets,
  packages,
  onCreateSnippet,
  onUpdateSnippet,
  onCreatePackage,
  hotkeyScheme = 'disabled',
  keyBindings = [],
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const [noAutoRun, setNoAutoRun] = useState(false);
  const [multiLineRunMode, setMultiLineRunMode] = useState<Snippet['multiLineRunMode']>(undefined);
  const [shortkey, setShortkey] = useState<string | undefined>(undefined);
  const [isRecordingShortkey, setIsRecordingShortkey] = useState(false);
  const [shortkeyError, setShortkeyError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Listen for the global "add snippet" request dispatched by the
  // terminal-side ScriptsSidePanel + button. We reset form state on
  // every open so stale input from a previous cancel does not leak.
  useEffect(() => {
    const handler = (event: Event) => {
      setEditing(null);
      setLabel('');
      setCommand(getQuickAddSnippetInitialCommand(event));
      setPackagePath('');
      setNoAutoRun(false);
      setMultiLineRunMode(undefined);
      setShortkey(undefined);
      setShortkeyError(null);
      setIsRecordingShortkey(false);
      setOpen(true);
    };
    window.addEventListener('netcatty:snippets:add', handler);
    return () => window.removeEventListener('netcatty:snippets:add', handler);
  }, []);

  // Sibling event for editing an existing snippet from the ScriptsSidePanel
  // context menu. Prefills the form and flips the dialog into update mode.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ snippet?: Snippet }>).detail;
      const snippet = detail?.snippet;
      if (!snippet || isScriptSnippet(snippet)) return;
      setEditing(snippet);
      setLabel(snippet.label ?? '');
      setCommand(snippet.command ?? '');
      setPackagePath(snippet.package ?? '');
      setNoAutoRun(snippet.noAutoRun ?? false);
      setMultiLineRunMode(snippet.multiLineRunMode);
      setShortkey(snippet.shortkey);
      setShortkeyError(null);
      setIsRecordingShortkey(false);
      setOpen(true);
    };
    window.addEventListener('netcatty:snippets:edit', handler);
    return () => window.removeEventListener('netcatty:snippets:edit', handler);
  }, []);

  // Focus the label field when the modal opens.
  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => labelInputRef.current?.focus(), 50);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  const isMac = useMemo(() => (
    hotkeyScheme === 'mac' || (hotkeyScheme === 'disabled' && isMacPlatform())
  ), [hotkeyScheme]);

  const existingShortkeys = useMemo(() => (
    snippets.filter((s) => Boolean(s.shortkey) && s.id !== editing?.id)
  ), [snippets, editing?.id]);

  const normalizeKeyString = useCallback((value: string) => (
    value.toLowerCase().replace(/\s+/g, '')
  ), []);

  const validateShortkey = useCallback((key: string): string | null => {
    if (!key) return null;

    const systemConflict = findActiveSystemShortcutConflict(key, hotkeyScheme, keyBindings);
    if (systemConflict) {
      const nameKey = `settings.shortcuts.binding.${systemConflict.id}`;
      const name = t(nameKey) !== nameKey ? t(nameKey) : systemConflict.label;
      return t('snippets.shortkey.error.systemConflict', { name });
    }

    const syntheticEvent = keyStringToKeyboardEvent(key);
    if (syntheticEvent) {
      for (const snippet of existingShortkeys) {
        if (snippet.shortkey && matchesKeyBinding(syntheticEvent, snippet.shortkey, isMac)) {
          return t('snippets.shortkey.error.snippetConflict', { name: snippet.label });
        }
      }
    } else {
      const normalizedKey = normalizeKeyString(key);
      const conflictingSnippet = existingShortkeys.find((snippet) => (
        snippet.shortkey && normalizeKeyString(snippet.shortkey) === normalizedKey
      ));
      if (conflictingSnippet) {
        return t('snippets.shortkey.error.snippetConflict', { name: conflictingSnippet.label });
      }
    }

    return null;
  }, [
    existingShortkeys,
    hotkeyScheme,
    isMac,
    keyBindings,
    normalizeKeyString,
    t,
  ]);

  // Shortkey recording capture. Escape cancels recording only (does not close the modal).
  useEffect(() => {
    if (!isRecordingShortkey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setIsRecordingShortkey(false);
        setShortkeyError(null);
        return;
      }

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      const keyString = keyEventToString(e, isMac);
      const error = validateShortkey(keyString);
      if (error) {
        setShortkeyError(error);
        return;
      }

      setShortkeyError(null);
      setShortkey(keyString);
      setIsRecordingShortkey(false);
    };

    const handleClick = () => {
      setIsRecordingShortkey(false);
      setShortkeyError(null);
    };

    const timer = setTimeout(() => {
      window.addEventListener('click', handleClick, true);
    }, 100);

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, [isRecordingShortkey, isMac, validateShortkey]);

  // Derive combobox options from the union of existing packages (from
  // props) and any package path referenced by an existing snippet, so
  // the user can reuse anything they see in the main snippets view.
  const packageOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of packages) {
      if (p) set.add(p);
    }
    for (const s of snippets) {
      if (s.package) set.add(s.package);
    }
    return Array.from(set).sort().map((value) => ({ value, label: value }));
  }, [packages, snippets]);

  const canSave = label.trim().length > 0 && command.trim().length > 0;

  const handleClose = useCallback(() => {
    setOpen(false);
    setIsRecordingShortkey(false);
    setShortkeyError(null);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      // Escape while recording is gated by onEscapeKeyDown; X/backdrop always close.
      handleClose();
      return;
    }
    setOpen(true);
  }, [handleClose]);

  const handleSave = useCallback(() => {
    if (!canSave) return;
    const trimmedPackage = packagePath.trim();
    // If the user typed a brand new package name, surface it to the parent
    // so it can be added to the user's package list alongside the snippet.
    if (trimmedPackage && !packages.includes(trimmedPackage)) {
      onCreatePackage?.(trimmedPackage);
    }
    if (editing && onUpdateSnippet) {
      // Preserve tags/targets/etc. that this lightweight panel does not expose.
      onUpdateSnippet({
        ...editing,
        label: label.trim(),
        command,
        package: trimmedPackage || '',
        noAutoRun: noAutoRun || undefined,
        multiLineRunMode,
        shortkey: shortkey || undefined,
      });
    } else {
      onCreateSnippet({
        id: crypto.randomUUID(),
        label: label.trim(),
        command, // preserve whitespace in multi-line commands
        tags: [],
        package: trimmedPackage || '',
        targets: [],
        noAutoRun: noAutoRun || undefined,
        multiLineRunMode,
        shortkey: shortkey || undefined,
      });
    }
    handleClose();
  }, [
    canSave,
    packagePath,
    packages,
    onCreatePackage,
    onCreateSnippet,
    onUpdateSnippet,
    editing,
    label,
    command,
    noAutoRun,
    multiLineRunMode,
    shortkey,
    handleClose,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Cmd/Ctrl+Enter from anywhere in the modal saves the snippet.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
        e.preventDefault();
        handleSave();
      }
    },
    [canSave, handleSave],
  );

  const handleSubmitShortcut = useCallback(() => {
    if (canSave) handleSave();
  }, [canSave, handleSave]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-2xl w-[min(42rem,calc(100vw-2rem))] max-h-[min(90vh,720px)] flex flex-col gap-0 p-0 overflow-hidden"
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(e) => {
          if (isRecordingShortkey) {
            e.preventDefault();
            setIsRecordingShortkey(false);
            setShortkeyError(null);
          }
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle>
            {t(editing ? 'snippets.panel.editTitle' : 'snippets.panel.newTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('snippets.empty.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="quick-add-snippet-label" className="text-xs">
              {t('snippets.field.description')}
            </Label>
            <Input
              id="quick-add-snippet-label"
              ref={labelInputRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('snippets.field.descriptionPlaceholder')}
              className="h-9"
              spellCheck={false}
            />
          </div>

          <SnippetScriptEditor
            id="quick-add-snippet-command"
            label={t('snippets.field.scriptRequired')}
            value={command}
            onChange={setCommand}
            onSubmitShortcut={handleSubmitShortcut}
            placeholder="echo hello"
          />

          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Package size={12} /> {t('snippets.field.package')}
            </Label>
            <Combobox
              value={packagePath}
              onValueChange={setPackagePath}
              options={packageOptions}
              placeholder={t('snippets.field.packagePlaceholder')}
              allowCreate
              onCreateNew={setPackagePath}
              createText={t('snippets.field.createPackage')}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer px-1">
            <input
              type="checkbox"
              checked={noAutoRun}
              onChange={(e) => setNoAutoRun(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-xs text-muted-foreground">{t('snippets.field.noAutoRun')}</span>
          </label>

          <div className="space-y-2">
            <Label className="text-xs">{t('snippets.field.multiLineRunMode')}</Label>
            <Select
              value={multiLineRunMode ?? 'paste'}
              onValueChange={(value) => setMultiLineRunMode(value === 'lineDelay' ? 'lineDelay' : undefined)}
            >
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="paste">{t('snippets.field.multiLineRunMode.paste')}</SelectItem>
                <SelectItem value="lineDelay">{t('snippets.field.multiLineRunMode.lineDelay')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('snippets.field.shortkey')}</Label>
              {shortkey ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => {
                        setShortkey(undefined);
                        setShortkeyError(null);
                      }}
                    >
                      <RotateCcw size={12} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('snippets.shortkey.clear')}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <button
              type="button"
              aria-pressed={isRecordingShortkey}
              onClick={(e) => {
                e.stopPropagation();
                setIsRecordingShortkey(true);
                setShortkeyError(null);
              }}
              className={cn(
                'w-full h-10 px-3 text-sm font-mono rounded-lg border transition-colors flex items-center justify-center gap-2',
                isRecordingShortkey
                  ? 'border-primary bg-primary/10 animate-pulse'
                  : 'border-border hover:border-primary/50 bg-background',
              )}
            >
              <Keyboard size={14} className="text-muted-foreground" />
              {isRecordingShortkey
                ? t('snippets.shortkey.recording')
                : shortkey || t('snippets.shortkey.placeholder')}
            </button>
            {shortkeyError ? (
              <p className="text-xs text-destructive">{shortkeyError}</p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">{t('snippets.shortkey.hint')}</p>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border/60 shrink-0 sm:justify-end">
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default QuickAddSnippetDialog;
