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
import { Textarea } from './ui/textarea';

export interface QuickAddSnippetDialogProps {
  snippets: Snippet[];
  packages: string[];
  onCreateSnippet: (snippet: Snippet) => void;
  onCreatePackage?: (packagePath: string) => void;
}

export const QuickAddSnippetDialog: React.FC<QuickAddSnippetDialogProps> = ({
  snippets,
  packages,
  onCreateSnippet,
  onCreatePackage,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Listen for the global "add snippet" request dispatched by the
  // terminal-side ScriptsSidePanel + button. We reset form state on
  // every open so stale input from a previous cancel does not leak.
  useEffect(() => {
    const handler = () => {
      setLabel('');
      setCommand('');
      setPackagePath('');
      setOpen(true);
    };
    window.addEventListener('netcatty:snippets:add', handler);
    return () => window.removeEventListener('netcatty:snippets:add', handler);
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
    onCreateSnippet({
      id: crypto.randomUUID(),
      label: label.trim(),
      command, // preserve whitespace in multi-line commands
      tags: [],
      package: trimmedPackage || '',
      targets: [],
    });
    setOpen(false);
  }, [canSave, packagePath, packages, onCreatePackage, onCreateSnippet, label, command]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd/Ctrl+Enter from anywhere in the dialog saves the snippet.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
        e.preventDefault();
        handleSave();
      }
    },
    [canSave, handleSave],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>{t('snippets.panel.newTitle')}</DialogTitle>
          <DialogDescription>
            {t('snippets.empty.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="quick-add-snippet-command" className="text-xs">
              {t('snippets.field.scriptRequired')}
            </Label>
            <Textarea
              id="quick-add-snippet-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="echo hello"
              className="min-h-[120px] font-mono text-xs"
              spellCheck={false}
            />
          </div>

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
        </div>

        <DialogFooter>
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
