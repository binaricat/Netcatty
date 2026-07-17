import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Snippet } from '../../types';
import { SnippetCommandPicker } from '../snippets/SnippetCommandPicker';
import { SnippetScriptEditor } from '../snippets/SnippetScriptEditor';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

type CommandTab = 'custom' | 'snippet';

interface TmuxNewSessionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, command: string) => Promise<void>;
  snippets: Snippet[];
  creating?: boolean;
  error?: string | null;
}

export const TmuxNewSessionModal = memo(function TmuxNewSessionModal({
  open,
  onOpenChange,
  onCreate,
  snippets,
  creating = false,
  error,
}: TmuxNewSessionModalProps) {
  const { t } = useI18n();
  const [commandTab, setCommandTab] = useState<CommandTab>('custom');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCommandTab('custom');
      setName('');
      setCommand('');
      setSelectedSnippetId(null);
      setLocalError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => nameInputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

  const handleSnippetSelect = useCallback((snippet: Snippet) => {
    setSelectedSnippetId(snippet.id);
    setCommand(snippet.command);
    if (!name.trim() && snippet.label.trim()) {
      setName(snippet.label.trim().slice(0, 64));
    }
  }, [name]);

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError(t('systemManager.tmux.newSessionRequired'));
      return;
    }
    setLocalError(null);
    await onCreate(trimmedName, command);
  }, [command, name, onCreate, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !creating && name.trim()) {
      e.preventDefault();
      void handleCreate();
    }
  }, [creating, handleCreate, name]);

  const handleSubmitShortcut = useCallback(() => {
    if (!creating && name.trim()) void handleCreate();
  }, [creating, handleCreate, name]);

  const handleCommandChange = useCallback((value: string) => {
    setCommand(value);
    if (selectedSnippetId) {
      const linked = snippets.find((snippet) => snippet.id === selectedSnippetId);
      if (linked && value !== linked.command) {
        setSelectedSnippetId(null);
      }
    }
  }, [selectedSnippetId, snippets]);

  const displayError = localError || error;
  const selectedSnippet = snippets.find((snippet) => snippet.id === selectedSnippetId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(88vh,680px)] w-[min(92vw,560px)] max-w-none flex-col overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t('systemManager.tmux.newSessionTitle')}</DialogTitle>
          <DialogDescription>{t('systemManager.tmux.newSessionDesc')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="tmux-new-session-name" className="text-xs">
              {t('systemManager.tmux.newSessionName')}
            </Label>
            <Input
              id="tmux-new-session-name"
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('systemManager.tmux.newSessionPlaceholder')}
              className="h-9"
              spellCheck={false}
              disabled={creating}
            />
          </div>

          <Tabs
            value={commandTab}
            onValueChange={(value) => setCommandTab(value as CommandTab)}
            className="flex min-h-0 flex-col"
          >
            <TabsList className="grid h-8 w-full grid-cols-2 bg-muted/50 p-0.5">
              <TabsTrigger value="custom" className="h-7 text-xs">
                {t('systemManager.tmux.newSessionTabCustom')}
              </TabsTrigger>
              <TabsTrigger value="snippet" className="h-7 text-xs">
                {t('systemManager.tmux.newSessionTabSnippet')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="custom" className="mt-3 space-y-3 focus-visible:outline-none">
              <SnippetScriptEditor
                id="tmux-new-session-command"
                label={t('systemManager.tmux.newSessionCommand')}
                value={command}
                onChange={handleCommandChange}
                onSubmitShortcut={handleSubmitShortcut}
                placeholder={t('systemManager.tmux.newSessionCommandPlaceholder')}
                defaultHeight={150}
                maxHeight={260}
                persistHeight={false}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('systemManager.tmux.newSessionCommandHint')}
              </p>
            </TabsContent>

            <TabsContent value="snippet" className="mt-3 space-y-3 focus-visible:outline-none">
              <SnippetCommandPicker
                snippets={snippets}
                selectedId={selectedSnippetId}
                onSelect={handleSnippetSelect}
                showTitle={false}
                className="h-[240px] min-h-[240px]"
              />
              {selectedSnippet && (
                <p className="text-[11px] text-muted-foreground">
                  {t('systemManager.tmux.selectedSnippet', { label: selectedSnippet.label })}
                </p>
              )}
            </TabsContent>
          </Tabs>

          {displayError && (
            <p className="text-xs text-destructive">{displayError}</p>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={creating || !name.trim()}>
            {creating ? t('systemManager.tmux.creating') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
