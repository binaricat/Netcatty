import { useI18n } from '../../application/i18n/I18nProvider';
import { usePluginHostActions } from '../../application/state/usePluginHostActions';
import { applyGroupDefaults, resolveGroupDefaults } from '../../domain/groupConfig';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import { SelectHostPanelContent } from '../SelectHostPanelContent';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { PluginHostDraftPreview } from './PluginHostDraftPreview';

export function PluginHostActionHost() {
  const { t } = useI18n();
  const state = usePluginHostActions();
  const entry = state.review;
  if (!entry) return null;
  const request = entry.prompt.request;
  const selection = request.kind === 'vault.selectHosts';
  const connection = request.kind === 'vault.requestConnect';
  const effective = entry.host ? applyGroupDefaults(entry.host, entry.host.group ? resolveGroupDefaults(entry.host.group, entry.groups) : {}) : undefined;
  const protocol = effective ? resolveEffectiveTerminalProtocol(effective) : undefined;
  return <Dialog open onOpenChange={(open) => { if (!open) void state.respond('cancel'); }}>
    <DialogContent className={selection ? 'max-w-md h-[min(85vh,640px)] flex flex-col p-0 gap-0 overflow-hidden' : 'sm:max-w-[560px] max-h-[85vh] overflow-y-auto'} hideCloseButton>
      <DialogHeader className={selection ? 'px-4 pt-4 pb-2 shrink-0 border-b border-border/60' : undefined}>
        <DialogTitle>{t(selection ? 'plugins.hostActions.select' : connection ? 'plugins.hostActions.connect' : entry.host ? 'plugins.hostActions.edit' : 'plugins.hostActions.create')}</DialogTitle>
        <DialogDescription className="break-all">{entry.prompt.pluginId} · {entry.prompt.pluginVersion}</DialogDescription>
      </DialogHeader>
      {selection ? <>
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('plugins.hostActions.selectionNote')}</p>
        <p className="px-4 pt-2 text-sm font-medium break-words">{request.title}</p>
        {state.selectedIds.length > 50 && <p role="alert" className="px-4 text-sm text-destructive">{t('plugins.hostActions.selectionLimit')}</p>}
        <SelectHostPanelContent hosts={entry.candidates} customGroups={entry.customGroups} selectedHostIds={state.selectedIds} multiSelect className="flex-1 min-h-0" confirmDisabled={state.busy || state.selectedIds.length > 50} onSelect={(host) => state.setSelectedIds((ids) => ids.includes(host.id) ? ids.filter((id) => id !== host.id) : [...ids, host.id])} onSelectionChange={state.setSelectedIds} onConfirm={() => { if (!state.busy && state.selectedIds.length <= 50) void state.respond('submit'); }} />
      </> : connection && effective ? <>
        <p className="break-all text-sm font-medium">{effective.label}</p>
        <p className="break-all text-sm">{protocol !== 'local' && effective.username ? `${effective.username}@` : ''}{effective.hostname}{protocol !== 'local' && effective.port ? `:${effective.port}` : ''} ({protocol})</p>
        {protocol === 'local' && <p className="text-sm font-medium" role="note">{t('plugins.hostActions.localExecution')}</p>}
        <p className="text-sm" role="note">{t(entry.scriptsRun ? 'plugins.hostActions.scriptsRun' : 'plugins.hostActions.noScripts')}</p>
        <p className="text-xs text-muted-foreground">{t('plugins.hostActions.connectionNote')}</p>
      </> : request.kind === 'vault.requestHostDraft' ? <PluginHostDraftPreview key={entry.prompt.requestId} before={entry.host} draft={request.draft} managedSources={entry.managedSources} busy={state.busy} onConfirm={(draft) => void state.respond('submit', draft)} /> : null}
      {state.error && <p role="alert" className="text-sm text-destructive">{t('plugins.hostActions.failed')}</p>}
      <DialogFooter className={selection ? 'p-3 border-t' : undefined}>
        <Button variant="outline" disabled={state.busy} onClick={() => void state.respond('cancel')}>{t('common.cancel')}</Button>
        {connection && <Button disabled={state.busy} onClick={() => void state.respond('submit')}>{t('common.connect')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
