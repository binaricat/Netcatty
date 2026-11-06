import React, { useState } from 'react';
import type { TerminalSession } from '../../domain/models';
import { usePluginAgentHost } from '../../application/state/usePluginAgentHost';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

export function PluginAgentHost({ sessions }: { sessions: TerminalSession[] }) {
  const { choice } = usePluginAgentHost(sessions);
  const [selected, setSelected] = useState<string[]>([]);
  return <Dialog open={choice !== null} onOpenChange={(open) => { if (!open) choice?.cancel(); }}>
    <DialogContent data-host-security-surface="" onOpenAutoFocus={() => setSelected([])}>
      <DialogHeader><DialogTitle>Choose terminals for this Agent conversation</DialogTitle>
        <DialogDescription>The conversation is independent of the active tab or workspace. Only the terminals selected here are eligible targets. Tool actions follow this plugin's Allow / Ask / Deny setting.</DialogDescription></DialogHeader>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {choice?.items.map((item) => <label key={item.sessionId} className="flex gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(item.sessionId)} disabled={selected.length >= 32 && !selected.includes(item.sessionId)}
            onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, item.sessionId] : ids.filter((id) => id !== item.sessionId))} />
          <span>{item.label} <span className="text-muted-foreground">{item.hostname}</span></span>
        </label>)}
        {choice?.items.length === 0 && <p className="text-sm text-muted-foreground">No connected terminals. You can continue without targets.</p>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => choice?.cancel()}>Cancel</Button>
        <Button onClick={() => choice?.confirm(selected)}>Use selected terminals</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
