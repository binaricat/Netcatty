import React, { useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { usePluginAgentHost } from '../../application/state/usePluginAgentHost';
import type { TerminalSession } from '../../domain/models';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

export function PluginAgentHost({ sessions }: { sessions: TerminalSession[] }) {
  const { t } = useI18n();
  const { choice } = usePluginAgentHost(sessions);
  const [selected, setSelected] = useState<string[]>([]);
  return <Dialog open={choice !== null} onOpenChange={(open) => { if (!open) choice?.cancel(); }}>
    <DialogContent data-host-security-surface="" onOpenAutoFocus={() => setSelected([])}>
      <DialogHeader>
        <DialogTitle>{t('plugins.agentTargets.title')}</DialogTitle>
        <DialogDescription>{t('plugins.agentTargets.description')}</DialogDescription>
      </DialogHeader>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {choice?.items.map((item) => <label key={item.sessionId} className="flex gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(item.sessionId)} disabled={selected.length >= 32 && !selected.includes(item.sessionId)}
            onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, item.sessionId] : ids.filter((id) => id !== item.sessionId))} />
          <span>{item.label} <span className="text-muted-foreground">{item.hostname}</span></span>
        </label>)}
        {choice?.items.length === 0 && <p className="text-sm text-muted-foreground">{t('plugins.agentTargets.empty')}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => choice?.cancel()}>{t('common.cancel')}</Button>
        <Button onClick={() => choice?.confirm(selected)}>{t('plugins.agentTargets.confirm')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
