import React, { useMemo, useState } from 'react';
import { parseSnippetVariables } from '../domain/snippetVariables';
import { Check, Clock, Keyboard, Loader2, Package, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import SelectHostPanel from './SelectHostPanel';
import { AsidePanel, AsidePanelContent, AsidePanelFooter } from './ui/aside-panel';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { SnippetScriptEditor } from './snippets/SnippetScriptEditor';
import { SnippetTargetsSection } from './snippets/SnippetTargetsSection';
import { ScriptEditorPanel } from './scripts/ScriptEditorPanel';
import { ScriptEditorModal } from './scripts/ScriptEditorModal';
import { isScriptSnippet } from '../domain/snippetScript.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Combobox } from './ui/combobox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { HistoryItem } from './SnippetsHistoryItem';
import type { Snippet } from '@/domain/models';
import { getRunnableHostsForSnippet } from '@/domain/snippetTargets.ts';
import { STORAGE_KEY_SNIPPETS_PANEL_WIDTH } from '@/infrastructure/config/storageKeys.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SnippetsRightPanelProps = Record<string, any>;

export const SnippetsRightPanel: React.FC<SnippetsRightPanelProps> = ({
  rightPanelMode,
  hosts,
  customGroups,
  targetSelection,
  setTargetSelection,
  handleTargetSelect,
  handleTargetPickerBack,
  availableKeys,
  proxyProfiles,
  managedSources,
  onSaveHost,
  onCreateGroup,
  t,
  handleClosePanel,
  editingSnippet,
  onDelete,
  handleSave,
  handleSaveAndRun,
  setEditingSnippet,
  packageOptions,
  selectedPackage,
  packages,
  onPackagesChange,
  shortkeyError,
  setShortkeyError,
  isRecordingShortkey,
  setIsRecordingShortkey,
  openTargetPicker,
  targetHosts,
  shellHistory,
  handleHistoryScroll,
  historyScrollRef,
  visibleHistory,
  saveHistoryAsSnippet,
  handleCopy,
  copiedId,
  hasMoreHistory,
  isLoadingMore,
  loadMoreHistory,
  onRunSnippet,
}) => {
  const detectedVariables = useMemo(
    () => parseSnippetVariables(editingSnippet?.command || ''),
    [editingSnippet?.command],
  );
  const [scriptEditorModalOpen, setScriptEditorModalOpen] = useState(false);
  const isEditingScript = isScriptSnippet(editingSnippet as import('../types').Snippet);
  const snippetsPanelResizeProps = {
    resizable: true as const,
    persistWidthStorageKey: STORAGE_KEY_SNIPPETS_PANEL_WIDTH,
    resizeAriaLabel: t('snippets.panel.resizeWidth'),
  };

  const runnableEditingSnippet = useMemo(() => ({
    ...(editingSnippet as Snippet),
    targets: editingSnippet.targetsAllHosts ? [] : targetSelection,
    targetsAllHosts: editingSnippet.targetsAllHosts || undefined,
  }), [editingSnippet, targetSelection]);

  const runTargets = useMemo(
    () => getRunnableHostsForSnippet(runnableEditingSnippet, hosts),
    [hosts, runnableEditingSnippet],
  );

  const runEditingScript = () => {
    if (runTargets.length === 0) return;
    onRunSnippet?.(runnableEditingSnippet, runTargets);
  };

  const canRunEditingScript = Boolean(editingSnippet.command?.trim()) && runTargets.length > 0;

  const handleTargetsAllHostsChange = (checked: boolean) => {
    if (checked) {
      setTargetSelection([]);
      setEditingSnippet({
        ...editingSnippet,
        targetsAllHosts: true,
        targets: [],
      });
      return;
    }
    setEditingSnippet({
      ...editingSnippet,
      targetsAllHosts: undefined,
    });
  };

    if (rightPanelMode === 'select-targets') {
      return (
        <SelectHostPanel
          hosts={hosts}
          customGroups={customGroups}
          selectedHostIds={targetSelection}
          multiSelect={true}
          onSelect={handleTargetSelect}
          onBack={handleTargetPickerBack}
          onContinue={handleTargetPickerBack}
          availableKeys={availableKeys}
          proxyProfiles={proxyProfiles}
          managedSources={managedSources}
          onSaveHost={onSaveHost}
          onCreateGroup={onCreateGroup}
          title={t('snippets.targets.add')}
          layout="inline"
          {...snippetsPanelResizeProps}
        />
      );
    }

    if (rightPanelMode === 'edit-snippet') {
      return (
        <AsidePanel
          open={true}
          onClose={handleClosePanel}
          title={isEditingScript
            ? t(editingSnippet.id ? 'snippets.panel.editAutomationTitle' : 'snippets.panel.newAutomationTitle')
            : t(editingSnippet.id ? 'snippets.panel.editTitle' : 'snippets.panel.newTitle')}
          layout="inline"
          {...snippetsPanelResizeProps}
          actions={
            <>
              {editingSnippet.id && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => {
                        const id = editingSnippet.id;
                        if (!id) return;
                        onDelete(id);
                      }}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('common.delete')}</TooltipContent>
                </Tooltip>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleSave}
                disabled={!editingSnippet.label || !editingSnippet.command}
                aria-label={t('common.save')}
              >
                <Check size={16} />
              </Button>
            </>
          }
        >
          <AsidePanelContent>
            {!isEditingScript ? (
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.description')}</p>
              <Input
                placeholder={t('snippets.field.descriptionPlaceholder')}
                value={editingSnippet.label || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
                className="h-10"
                spellCheck={false}
              />
            </Card>
            ) : null}

            {/* Package */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.package')}</p>
              <Combobox
                options={packageOptions}
                value={editingSnippet.package || selectedPackage || ''}
                onValueChange={(val) => {
                  setEditingSnippet({ ...editingSnippet, package: val });
                  // If selecting an implicit parent path, persist it to packages
                  if (val && !packages.includes(val)) {
                    onPackagesChange([...packages, val]);
                  }
                }}
                placeholder={t('snippets.field.packagePlaceholder')}
                allowCreate={true}
                onCreateNew={(val) => {
                  if (!packages.includes(val)) {
                    onPackagesChange([...packages, val]);
                  }
                }}
                createText={t('snippets.field.createPackage')}
                icon={<Package size={16} />}
                triggerClassName="h-10"
              />
            </Card>

            {/* Script / Snippet body */}
            {isEditingScript ? (
              <ScriptEditorPanel
                snippet={editingSnippet as import('../types').Snippet}
                onChange={setEditingSnippet}
                canRun={canRunEditingScript}
                onExpand={() => setScriptEditorModalOpen(true)}
                onRun={canRunEditingScript ? runEditingScript : undefined}
              />
            ) : (
            <Card className="p-3 space-y-2 bg-card border-border/80">
                  <SnippetScriptEditor
                    label={t('snippets.field.scriptRequired')}
                    placeholder="ls -l"
                    value={editingSnippet.command || ''}
                    onChange={(command) => setEditingSnippet({ ...editingSnippet, command })}
                  />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {t('snippets.field.variablesHelp')}
                  </p>
                  {detectedVariables.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="text-[10px] font-semibold text-muted-foreground shrink-0">
                        {t('snippets.field.variablesDetected')}:
                      </span>
                      {detectedVariables.map((variable) => (
                        <span
                          key={variable.name}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-mono"
                        >
                          {variable.name}
                          {variable.defaultValue !== undefined && (
                            <span className="text-muted-foreground font-sans ml-1">
                              ({t('snippets.field.variableDefault', { value: variable.defaultValue })})
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
            </Card>
            )}

            <SnippetTargetsSection
              t={t}
              targetHosts={targetHosts}
              onEditTargets={openTargetPicker}
              hint={isEditingScript
                ? (editingSnippet.trigger === 'onConnect'
                  ? t('scripts.targets.connectOrderHint')
                  : t('scripts.targets.hint'))
                : undefined}
              targetsAllHosts={Boolean(editingSnippet.targetsAllHosts)}
              onTargetsAllHostsChange={handleTargetsAllHostsChange}
            />

            {!isEditingScript ? (
            <>
            <label className="flex items-center gap-2 cursor-pointer px-1">
              <input
                type="checkbox"
                checked={editingSnippet.noAutoRun ?? false}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, noAutoRun: e.target.checked || undefined })}
                className="rounded border-input"
              />
              <span className="text-xs text-muted-foreground">{t('snippets.field.noAutoRun')}</span>
            </label>

            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.multiLineRunMode')}</p>
              <Select
                value={editingSnippet.multiLineRunMode ?? 'paste'}
                onValueChange={(value) => setEditingSnippet({
                  ...editingSnippet,
                  multiLineRunMode: value === 'lineDelay' ? 'lineDelay' : undefined,
                })}
              >
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paste">{t('snippets.field.multiLineRunMode.paste')}</SelectItem>
                  <SelectItem value="lineDelay">{t('snippets.field.multiLineRunMode.lineDelay')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t('snippets.field.multiLineRunModeHint')}
              </p>
            </Card>

            {/* Shortkey */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.shortkey')}</p>
                {editingSnippet.shortkey && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          setEditingSnippet(prev => ({ ...prev, shortkey: undefined }));
                          setShortkeyError(null);
                        }}
                      >
                        <RotateCcw size={12} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('snippets.shortkey.clear')}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsRecordingShortkey(true);
                  setShortkeyError(null);
                }}
                className={cn(
                  "w-full h-10 px-3 text-sm font-mono rounded-lg border transition-colors flex items-center justify-center gap-2",
                  isRecordingShortkey
                    ? "border-primary bg-primary/10 animate-pulse"
                    : "border-border hover:border-primary/50 bg-background"
                )}
              >
                <Keyboard size={14} className="text-muted-foreground" />
                {isRecordingShortkey
                  ? t('snippets.shortkey.recording')
                  : editingSnippet.shortkey || t('snippets.shortkey.placeholder')}
              </button>
              {shortkeyError && (
                <p className="text-xs text-destructive">{shortkeyError}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{t('snippets.shortkey.hint')}</p>
            </Card>
            </>
            ) : null}
          </AsidePanelContent>

          {/* Footer */}
          <AsidePanelFooter>
            <Button
              className="w-full"
              onClick={canRunEditingScript ? handleSaveAndRun : handleSave}
              disabled={!editingSnippet.label || !editingSnippet.command}
            >
              {canRunEditingScript ? t('action.run') : t('common.save')}
            </Button>
          </AsidePanelFooter>
          {isEditingScript ? (
            <ScriptEditorModal
              open={scriptEditorModalOpen}
              onClose={() => setScriptEditorModalOpen(false)}
              snippet={editingSnippet as import('../types').Snippet}
              onChange={setEditingSnippet}
              onSave={handleSave}
              canRun={canRunEditingScript}
              onRun={canRunEditingScript ? runEditingScript : undefined}
              targetHosts={targetHosts}
              hosts={hosts}
              customGroups={customGroups}
              selectedHostIds={targetSelection}
              onSelectHost={handleTargetSelect}
              targetsAllHosts={Boolean(editingSnippet.targetsAllHosts)}
              onTargetsAllHostsChange={handleTargetsAllHostsChange}
            />
          ) : null}
        </AsidePanel>
      );
    }

    if (rightPanelMode === 'history') {
      return (
        <AsidePanel
          open={true}
          onClose={handleClosePanel}
          title={t('snippets.history.title')}
          subtitle={t('snippets.history.subtitle', { count: shellHistory.length })}
          showBackButton={true}
          onBack={handleClosePanel}
          layout="inline"
          {...snippetsPanelResizeProps}
        >
          {/* History List */}
          <div
            className="flex-1 overflow-y-auto p-3 space-y-2"
            onScroll={handleHistoryScroll}
            ref={historyScrollRef}
          >
            {visibleHistory.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Clock size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-sm">{t('snippets.history.emptyTitle')}</p>
                <p className="text-xs mt-1">{t('snippets.history.emptyDesc')}</p>
              </div>
            ) : (
              <>
                {visibleHistory.map((entry) => (
                  <HistoryItem
                    key={entry.id}
                    entry={entry}
                    onSaveAsSnippet={saveHistoryAsSnippet}
                    onCopy={() => handleCopy(entry.id, entry.command)}
                    isCopied={copiedId === entry.id}
                  />
                ))}
                {hasMoreHistory && (
                  <div className="py-4 text-center">
                    {isLoadingMore ? (
                      <Loader2 size={20} className="animate-spin mx-auto text-muted-foreground" />
                    ) : (
                      <Button variant="ghost" size="sm" onClick={loadMoreHistory}>
                        {t('snippets.history.loadMore')}
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </AsidePanel>
      );
    }

    return null;
  };
