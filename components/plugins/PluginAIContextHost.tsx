import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { usePluginAIContextHost } from '../../application/state/usePluginAIContextHost';
import type { TerminalSession, Workspace } from '../../domain/models';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

export function PluginAIContextHost({ sessions, workspaces }: { sessions: TerminalSession[]; workspaces: Workspace[] }) {
  const { t } = useI18n();
  const { choice, noteId, setNoteId, noteChoices } = usePluginAIContextHost({ sessions, workspaces });
  return <Dialog open={choice !== null} onOpenChange={(open) => { if (!open) choice?.cancel(); }}>
    <DialogContent data-host-security-surface="">
      <DialogHeader>
        <DialogTitle>{t('plugins.contextPicker.title')}</DialogTitle>
        <DialogDescription>{t('plugins.contextPicker.description')}</DialogDescription>
      </DialogHeader>
      <label className="text-sm" htmlFor="plugin-ai-note">{t('plugins.contextPicker.note')}</label>
      <select id="plugin-ai-note" value={noteId} onChange={(event) => setNoteId(event.target.value)} className="rounded border border-border bg-background p-2 text-foreground">
        <option value="">{t('plugins.contextPicker.noNote')}</option>
        {noteChoices.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
      </select>
      <DialogFooter>
        <Button variant="outline" onClick={() => choice?.cancel()}>{t('common.cancel')}</Button>
        <Button onClick={() => choice?.confirm(noteId)}>{t('plugins.contextPicker.confirm')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
