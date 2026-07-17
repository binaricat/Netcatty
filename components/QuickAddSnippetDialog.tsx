/**
 * QuickAddSnippetDialog — lightweight "new snippet" modal mounted at the
 * App root and triggered by the `netcatty:snippets:add` window event.
 *
 * Intentionally minimal: label + command + package only. Advanced fields
 * (target hosts, shortkey, tags) can be set later via the full Snippets
 * manager. This keeps the user in their terminal context instead of
 * navigating to the Vault view just to add a command.
 */

import { Package } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { Snippet } from '../domain/models';
import { isScriptSnippet } from '../domain/snippetScript.ts';
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
import { SnippetScriptEditor } from './snippets/SnippetScriptEditor';

export interface QuickAddSnippetDialogProps {
  snippets: Snippet[];
  packages: string[];
  onCreateSnippet: (snippet: Snippet) => void;
  onUpdateSnippet?: (snippet: Snippet) => void;
  onCreatePackage?: (packagePath: string) => void;
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
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const [noAutoRun, setNoAutoRun] = useState(false);
  const [multiLineRunMode, setMultiLineRunMode] = useState<Snippet["multiLineRunMode"]>(undefined);
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
      setOpen(true);
    };
    window.addEventListener('netcatty:snippets:edit', handler);
    return () => window.removeEventListener('netcatty:snippets:edit', handler);
  }, []);

  // Auto-focus the label input once the dialog renders, so the user can
  // start typing immediately after clicking the + button.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => labelInputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

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

  const handleSave = useCallback(() => {
    if (!canSave) return;
    const trimmedPackage = packagePath.trim();
    // If the user typed a brand new package name, surface it to the parent
    // so it can be added to the user's package list alongside the snippet.
    if (trimmedPackage && !packages.includes(trimmedPackage)) {
      onCreatePackage?.(trimmedPackage);
    }
    if (editing && onUpdateSnippet) {
      // Preserve tags/targets/shortkey/noAutoRun etc. that this lightweight
      // dialog does not expose — only the three quick-edit fields change.
      onUpdateSnippet({
        ...editing,
        label: label.trim(),
        command,
        package: trimmedPackage || '',
        noAutoRun: noAutoRun || undefined,
        multiLineRunMode,
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
      });
    }
    setOpen(false);
  }, [canSave, packagePath, packages, onCreatePackage, onCreateSnippet, onUpdateSnippet, editing, label, command, noAutoRun, multiLineRunMode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Cmd/Ctrl+Enter from anywhere in the dialog saves the snippet.
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-md max-h-[min(90vh,720px)] flex flex-col overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t(editing ? 'snippets.panel.editTitle' : 'snippets.panel.newTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('snippets.empty.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
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
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => setOpen(false)}>
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
