import React from 'react';
import type { TerminalSession, Workspace } from '../../domain/models';
import { usePluginAIContextHost } from '../../application/state/usePluginAIContextHost';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

export function PluginAIContextHost({ sessions, workspaces }: { sessions: TerminalSession[]; workspaces: Workspace[] }) {
  const { choice, noteId, setNoteId, noteChoices } = usePluginAIContextHost({ sessions, workspaces });
  return <Dialog open={choice !== null} onOpenChange={(open) => { if (!open) choice?.cancel(); }}>
    <DialogContent data-host-security-surface="">
      <DialogHeader><DialogTitle>Choose a reference for the plugin</DialogTitle>
        <DialogDescription>Share a Note summary and the current selected workspace, tab, session, and host summaries. Content access follows this plugin's Allow / Ask / Deny settings; this chooser shares summaries only.</DialogDescription></DialogHeader>
      <label className="text-sm" htmlFor="plugin-ai-note">Note</label>
      <select id="plugin-ai-note" value={noteId} onChange={(event) => setNoteId(event.target.value)} className="rounded border border-border bg-background p-2 text-foreground">
        <option value="">No Note</option>
        {noteChoices.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
      </select>
      <DialogFooter><Button variant="outline" onClick={() => choice?.cancel()}>Cancel</Button>
        <Button onClick={() => choice?.confirm(noteId)}>Share selected summaries</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
