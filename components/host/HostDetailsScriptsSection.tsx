import { Globe, Link2, Play, Trash2 } from 'lucide-react';
import React, { useCallback, useMemo, useState, type DragEvent } from 'react';
import type { Host, Snippet } from '@/domain/models';
import {
  appendHostConnectScript,
  getGlobalConnectScripts,
  getHostConnectScriptIds,
  removeHostConnectScript,
  reorderHostConnectScript,
} from '@/domain/hostConnectScripts.ts';
import { isScriptSnippet } from '@/domain/snippetScript.ts';
import { cn } from '@/lib/utils';
import { getVaultDropPosition } from '@/components/vault/vaultReorderDrag';
import {
  VaultEntityIcon,
  vaultAutomationScriptIconClass,
  vaultEntityIconSmClass,
} from '@/components/vault/VaultEntityIcon';
import { HostDetailsSection } from '../host-details';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';

const CONNECT_QUEUE_DRAG_TYPE = 'application/x-netcatty-connect-script-id';

export interface HostDetailsScriptsSectionProps {
  host: Host;
  onHostChange: (host: Host) => void;
  snippets: Snippet[];
  t: (key: string, params?: Record<string, unknown>) => string;
}

function triggerLabel(
  snippet: Snippet,
  t: HostDetailsScriptsSectionProps['t'],
): string {
  if (snippet.trigger === 'onConnect') return t('scripts.trigger.onConnect');
  if (snippet.trigger === 'onOutput') return t('scripts.trigger.onOutput');
  return t('scripts.trigger.manual');
}

function scriptById(snippets: Snippet[], scriptId: string): Snippet | undefined {
  return snippets.find((snippet) => snippet.id === scriptId && isScriptSnippet(snippet));
}

export const HostDetailsScriptsSection: React.FC<HostDetailsScriptsSectionProps> = ({
  host,
  onHostChange,
  snippets,
  t,
}) => {
  const [draggingScriptId, setDraggingScriptId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ scriptId: string; position: 'before' | 'after' } | null>(null);

  const scripts = useMemo(
    () => snippets.filter(isScriptSnippet),
    [snippets],
  );
  const globalScripts = useMemo(
    () => getGlobalConnectScripts(snippets),
    [snippets],
  );
  const queueIds = useMemo(
    () => getHostConnectScriptIds(host, snippets),
    [host, snippets],
  );
  const queuedScripts = useMemo(
    () => queueIds
      .map((id) => scriptById(snippets, id))
      .filter((snippet): snippet is Snippet => Boolean(snippet)),
    [queueIds, snippets],
  );
  const linkableScripts = useMemo(
    () => scripts.filter((script) => {
      if (script.targetsAllHosts) return false;
      if (script.id && queueIds.includes(script.id)) return false;
      return true;
    }),
    [queueIds, scripts],
  );
  const linkOptions = useMemo(
    () => linkableScripts.map((script) => ({
      value: script.id,
      label: script.label || t('scripts.running.unnamed'),
    })),
    [linkableScripts, t],
  );

  const clearDragState = useCallback(() => {
    setDraggingScriptId(null);
    setDropIndicator(null);
  }, []);

  if (scripts.length === 0) return null;

  const handleAddToQueue = (scriptId: string) => {
    if (!scriptId) return;
    const snippet = scriptById(snippets, scriptId);
    if (!snippet) return;
    onHostChange(appendHostConnectScript(host, scriptId, snippets));
  };

  const handleRemoveFromQueue = (scriptId: string) => {
    onHostChange(removeHostConnectScript(host, scriptId, snippets));
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, scriptId: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CONNECT_QUEUE_DRAG_TYPE, scriptId);
    setDraggingScriptId(scriptId);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, scriptId: string) => {
    if (!event.dataTransfer.types.includes(CONNECT_QUEUE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const position = getVaultDropPosition(event.currentTarget, event.clientX, event.clientY, false);
    setDropIndicator((prev) => (
      prev?.scriptId === scriptId && prev.position === position
        ? prev
        : { scriptId, position }
    ));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetScriptId: string) => {
    event.preventDefault();
    const draggedScriptId = event.dataTransfer.getData(CONNECT_QUEUE_DRAG_TYPE);
    if (!draggedScriptId || draggedScriptId === targetScriptId) {
      clearDragState();
      return;
    }
    const position = getVaultDropPosition(event.currentTarget, event.clientX, event.clientY, false);
    onHostChange(reorderHostConnectScript(host, draggedScriptId, targetScriptId, position, snippets));
    clearDragState();
  };

  return (
    <HostDetailsSection
      icon={<Play size={14} className="text-muted-foreground" />}
      title={t('hostDetails.section.automation')}
      hint={t('hostDetails.automation.queueHint')}
    >
      <div className="space-y-4">
        {globalScripts.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Globe size={12} className="text-muted-foreground shrink-0" />
              <label className="text-xs text-muted-foreground">{t('hostDetails.automation.globalScripts')}</label>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              {t('hostDetails.automation.globalScriptsHint')}
            </p>
            <div className="space-y-1.5">
              {globalScripts.map((script) => (
                <div
                  key={script.id}
                  className="flex items-center gap-2.5 px-2.5 py-2 rounded-md border border-border/50 bg-muted/20"
                >
                  <VaultEntityIcon
                    className={cn(vaultEntityIconSmClass, vaultAutomationScriptIconClass)}
                    icon={<Play size={14} />}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{script.label || t('scripts.running.unnamed')}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{triggerLabel(script, t)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          {queuedScripts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('hostDetails.automation.connectQueueEmpty')}</p>
          ) : (
            <div className="space-y-1.5" onDragEnd={clearDragState}>
              {queuedScripts.map((script) => {
                const scriptId = script.id!;
                const isDragging = draggingScriptId === scriptId;
                const indicator = dropIndicator?.scriptId === scriptId ? dropIndicator.position : null;

                return (
                  <div
                    key={scriptId}
                    draggable
                    data-vault-drop-position={indicator ?? undefined}
                    data-vault-drop-axis="y"
                    className={cn(
                      'vault-drop-indicator-row relative flex items-center gap-2.5 px-2.5 py-2 rounded-md border border-border/70 bg-background/60 transition-opacity cursor-grab active:cursor-grabbing',
                      isDragging && 'opacity-40',
                    )}
                    aria-label={t('hostDetails.automation.dragHandle')}
                    onDragStart={(event) => handleDragStart(event, scriptId)}
                    onDragOver={(event) => handleDragOver(event, scriptId)}
                    onDrop={(event) => handleDrop(event, scriptId)}
                  >
                    <VaultEntityIcon
                      className={cn(vaultEntityIconSmClass, vaultAutomationScriptIconClass)}
                      icon={<Play size={14} />}
                    />
                    <div className="min-w-0 flex-1 select-none">
                      <div className="text-sm font-medium truncate">{script.label || t('scripts.running.unnamed')}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{triggerLabel(script, t)}</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => handleRemoveFromQueue(scriptId)}
                      aria-label={t('hostDetails.automation.removeFromQueue')}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {linkOptions.length > 0 ? (
            <Combobox
              options={linkOptions}
              value=""
              onValueChange={handleAddToQueue}
              placeholder={t('hostDetails.automation.addToQueuePlaceholder')}
              icon={<Link2 size={14} />}
              triggerClassName="h-9"
            />
          ) : null}
        </div>
      </div>
    </HostDetailsSection>
  );
};
