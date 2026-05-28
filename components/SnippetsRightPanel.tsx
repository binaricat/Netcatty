import React from 'react';
import { Check, Clock, Keyboard, Loader2, Package, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import SelectHostPanel from './SelectHostPanel';
import { AsidePanel, AsidePanelContent, AsidePanelFooter } from './ui/aside-panel';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Combobox } from './ui/combobox';
import { DistroAvatar } from './DistroAvatar';
import { HistoryItem } from './SnippetsHistoryItem';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SnippetsRightPanelProps = Record<string, any>;

export const SnippetsRightPanel: React.FC<SnippetsRightPanelProps> = ({
  rightPanelMode,
  hosts,
  customGroups,
  targetSelection,
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
  handleSubmit,
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
}) => {
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
        />
      );
    }

    if (rightPanelMode === 'edit-snippet') {
      return (
        <AsidePanel
          open={true}
          onClose={handleClosePanel}
          title={editingSnippet.id ? t('snippets.panel.editTitle') : t('snippets.panel.newTitle')}
          layout="inline"
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
                        handleClosePanel();
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
                onClick={handleSubmit}
                disabled={!editingSnippet.label || !editingSnippet.command}
                aria-label={t('common.save')}
              >
                <Check size={16} />
              </Button>
            </>
          }
        >
          <AsidePanelContent>
            {/* Action Description */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.description')}</p>
              <Input
                placeholder={t('snippets.field.descriptionPlaceholder')}
                value={editingSnippet.label || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
                className="h-10"
              />
            </Card>

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

            {/* Script */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.scriptRequired')}</p>
              <Textarea
                placeholder="ls -l"
                className="min-h-[120px] font-mono text-xs"
                value={editingSnippet.command || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, command: e.target.value })}
              />
            </Card>

            {/* No Auto Run */}
            <label className="flex items-center gap-2 cursor-pointer px-1">
              <input
                type="checkbox"
                checked={editingSnippet.noAutoRun ?? false}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, noAutoRun: e.target.checked || undefined })}
                className="rounded border-input"
              />
              <span className="text-xs text-muted-foreground">{t('snippets.field.noAutoRun')}</span>
            </label>

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

            {/* Targets */}
            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">{t('snippets.targets.title')}</p>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary" onClick={openTargetPicker}>
                  {t('action.edit')}
                </Button>
              </div>

              {targetHosts.length === 0 ? (
                <Button
                  variant="secondary"
                  className="w-full h-10"
                  onClick={openTargetPicker}
                >
                  {t('snippets.targets.add')}
                </Button>
              ) : (
                <div className="space-y-2">
                  {targetHosts.map((h) => (
                    <div key={h.id} className="flex items-center gap-3 px-3 py-2 bg-background/60 border border-border/70 rounded-lg">
                      <DistroAvatar host={h} fallback={h.os[0].toUpperCase()} className="h-10 w-10" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold truncate">{h.hostname}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {h.protocol || 'ssh'}, {h.username}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </AsidePanelContent>

          {/* Footer */}
          <AsidePanelFooter>
            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={!editingSnippet.label || !editingSnippet.command}
            >
              {editingSnippet.targets?.length ? t('action.run') : t('common.save')}
            </Button>
          </AsidePanelFooter>
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
