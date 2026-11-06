import React, { useState } from 'react';
import { PLUGIN_HOST_INTERACTION_LIMITS } from '@netcatty/plugin-contract';
import { useI18n } from '../../application/i18n/I18nProvider';
import { usePluginHostInteractions } from '../../application/state/usePluginHostInteractions';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

export function PluginHostInteractionHost() {
  const state = usePluginHostInteractions();
  if (!state.prompt) return null;
  return <HostInteractionDialog key={state.prompt.requestId} state={state} prompt={state.prompt} />;
}

function HostInteractionDialog({ state, prompt }: {
  state: ReturnType<typeof usePluginHostInteractions>;
  prompt: NonNullable<ReturnType<typeof usePluginHostInteractions>['prompt']>;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const request = prompt.request;
  const terminalShare = request.kind === 'terminal.selection.read';
  const inputDraft = request.kind === 'terminal.input.propose';
  const previewClipboard = request.kind === 'clipboard.read' && prompt.phase === 'request';
  const needsPreview = previewClipboard || (terminalShare && prompt.phase === 'request');
  const textBytes = new TextEncoder().encode(state.value).length;
  const canSubmit = request.kind === 'quickPick' ? request.items.some((item) => item.id === state.value) : textBytes <= PLUGIN_HOST_INTERACTION_LIMITS.textBytes;
  return <Dialog open onOpenChange={(open) => { if (!open) void state.respond('cancel'); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]" hideCloseButton>
      <DialogHeader>
        <DialogTitle>{t('plugins.interaction.title')}</DialogTitle>
        <DialogDescription className="break-all">{prompt.pluginId} · {prompt.pluginVersion}</DialogDescription>
      </DialogHeader>
      <p className="break-words text-sm font-medium">{request.title}</p>
      <p className="text-xs text-muted-foreground">{t(inputDraft ? 'plugins.interaction.draftNote' : terminalShare ? 'plugins.interaction.terminalDisclosure' : 'plugins.interaction.sharing')}</p>
      {(terminalShare || inputDraft) && <p className="break-all text-sm">{t('plugins.interaction.terminalTarget')}: {prompt.terminalLabel} ({prompt.terminalSessionId})</p>}
      {inputDraft && <textarea aria-label={t('plugins.interaction.draft')} className="min-h-28 max-h-64 w-full rounded-md border bg-muted/30 p-3 font-mono text-xs" value={state.value} maxLength={PLUGIN_HOST_INTERACTION_LIMITS.textBytes} disabled={state.busy} onChange={(event) => state.setValue(event.target.value)} />}
      {(inputDraft || (terminalShare && prompt.phase === 'preview')) && <pre aria-label={t('plugins.interaction.exactText')} className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2 font-mono text-xs">{JSON.stringify(inputDraft ? state.value : prompt.previewText)}</pre>}
      {request.kind === 'input' && <Input aria-label={t('plugins.interaction.input')} value={state.value} maxLength={PLUGIN_HOST_INTERACTION_LIMITS.textBytes} autoComplete="off" autoFocus disabled={state.busy} onChange={(event) => state.setValue(event.target.value)} />}
      {request.kind === 'quickPick' && <>
        <Input aria-label={t('plugins.interaction.filter')} value={search} onChange={(event) => setSearch(event.target.value)} autoFocus disabled={state.busy} />
        <div className="max-h-64 space-y-2 overflow-y-auto" role="radiogroup" aria-label={request.title}>
          {request.items.filter((item) => `${item.label} ${item.description ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item) => <label key={item.id} className="flex items-start gap-3 rounded-md border p-3">
            <input type="radio" name="plugin-host-choice" value={item.id} checked={state.value === item.id} disabled={state.busy} onChange={() => state.setValue(item.id)} />
            <span className="min-w-0 break-words text-sm">{item.label}{item.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}</span>
          </label>)}
        </div>
      </>}
      {previewClipboard && <p className="text-sm">{t('plugins.interaction.previewNote')}</p>}
      {(request.kind === 'clipboard.write' || prompt.phase === 'preview') && <textarea aria-label={t('plugins.interaction.preview')} readOnly className="min-h-28 max-h-64 w-full resize-none rounded-md border bg-muted/30 p-3 font-mono text-xs" value={request.kind === 'clipboard.write' ? request.text : prompt.previewText ?? ''} />}
      {state.error && <p role="alert" className="text-sm text-destructive">{t('plugins.interaction.failed')}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={state.busy} onClick={() => void state.respond('cancel')}>{t('common.cancel')}</Button>
        <Button disabled={state.busy || !canSubmit} onClick={() => void state.respond(needsPreview ? 'preview' : 'submit')}>
          {t(needsPreview ? terminalShare ? 'plugins.interaction.terminalPreview' : 'plugins.interaction.previewAction' : inputDraft ? 'plugins.interaction.closeDraft' : request.kind === 'clipboard.read' || terminalShare ? 'plugins.interaction.share' : request.kind === 'clipboard.write' ? 'plugins.interaction.copy' : 'common.continue')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
