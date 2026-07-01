import { Loader2, Play, X } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import type { Host, Snippet } from '@/domain/models';
import { DEFAULT_SCRIPT_TEMPLATE } from '@/domain/snippetScript.ts';
import { scheduleWindowInputFocus } from '@/application/state/windowInputFocus';
import { SelectHostDialog } from '@/components/SelectHostDialog';
import { ScriptCodeEditor } from './ScriptCodeEditor';
import { ScriptMetaFields } from './ScriptMetaFields';
import { SnippetTargetsSection } from '@/components/snippets/SnippetTargetsSection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface ScriptEditorModalProps {
  open: boolean;
  onClose: () => void;
  snippet: Snippet;
  onChange: (snippet: Snippet) => void;
  onSave?: () => void;
  onRun?: () => void;
  canRun?: boolean;
  targetHosts: Host[];
  hosts: Host[];
  customGroups?: string[];
  selectedHostIds: string[];
  onSelectHost: (host: Host) => void;
  targetsAllHosts?: boolean;
  onTargetsAllHostsChange?: (checked: boolean) => void;
}

function countLines(content: string): number {
  if (!content) return 1;
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

export const ScriptEditorModal: React.FC<ScriptEditorModalProps> = ({
  open,
  onClose,
  snippet,
  onChange,
  onSave,
  onRun,
  canRun = false,
  targetHosts,
  hosts,
  customGroups = [],
  selectedHostIds,
  onSelectHost,
  targetsAllHosts = false,
  onTargetsAllHostsChange,
}) => {
  const { t } = useI18n();
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      onClose();
      scheduleWindowInputFocus();
    }
  }, [onClose]);

  const handleClose = useCallback(() => {
    onClose();
    scheduleWindowInputFocus();
  }, [onClose]);

  const handleSave = useCallback(() => {
    onSave?.();
    onClose();
    scheduleWindowInputFocus();
  }, [onClose, onSave]);

  const handleTargetsConfirm = useCallback(() => {
    onChange({
      ...snippet,
      targets: selectedHostIds,
      targetsAllHosts: undefined,
    });
  }, [onChange, selectedHostIds, snippet]);

  const language = 'javascript';
  const editorValue = snippet.command || DEFAULT_SCRIPT_TEMPLATE;
  const title = snippet.label?.trim() || t('scripts.editor.modalTitle');
  const lineCount = useMemo(() => countLines(editorValue), [editorValue]);

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-w-5xl h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
          hideCloseButton
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>

          <div className="h-full flex flex-col min-h-0">
            <div className="h-9 px-3 py-1.5 border-b border-border/60 flex-shrink-0">
              <div className="flex h-full items-center justify-between gap-3">
                <span className="text-sm font-semibold leading-none truncate">{title}</span>
                <div className="flex h-6 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={handleSave}
                  >
                    {t('scripts.actions.save')}
                  </Button>
                  {onRun ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          className="h-6 px-2 text-xs gap-1"
                          onClick={onRun}
                          disabled={!canRun}
                        >
                          <Play size={12} />
                          {t('scripts.actions.runNow')}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('scripts.actions.runNowHint')}</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={handleClose}
                  >
                    <X size={13} />
                  </Button>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-b border-border/40 flex-shrink-0 bg-muted/20 space-y-3">
              <ScriptMetaFields snippet={snippet} onChange={onChange} layout="toolbar" />
              <SnippetTargetsSection
                variant="embedded"
                t={t}
                targetHosts={targetHosts}
                onEditTargets={() => {
                  if (!targetsAllHosts) setTargetPickerOpen(true);
                }}
                hint={t('scripts.targets.hint')}
                targetsAllHosts={targetsAllHosts}
                onTargetsAllHostsChange={onTargetsAllHostsChange}
              />
            </div>

            <div className="flex-1 min-h-0 relative">
              {open ? (
                <ScriptCodeEditor
                  value={editorValue}
                  onChange={(command) => onChange({ ...snippet, command })}
                  language={language}
                  fill
                  minimap
                  active={open}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-background">
                  <Loader2 size={24} className="animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            <div className="px-4 py-2 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground bg-muted/30 flex-shrink-0">
              <span>JavaScript</span>
              <span>{t('scripts.editor.lineCount', { count: lineCount })}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SelectHostDialog
        open={targetPickerOpen}
        onOpenChange={setTargetPickerOpen}
        title={t('snippets.targets.add')}
        hosts={hosts}
        customGroups={customGroups}
        selectedHostIds={selectedHostIds}
        multiSelect
        onSelect={onSelectHost}
        onConfirm={handleTargetsConfirm}
      />
    </>
  );
};
