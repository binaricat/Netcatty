import React, { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { TerminalSession, TerminalTheme } from '../../types';
import { SessionInlineRenameInput } from '../terminal/SessionInlineRenameInput';

interface TerminalSessionTabsProps {
  sessions: TerminalSession[];
  selectedSessionId?: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  theme: TerminalTheme;
  t: (key: string) => string;
}

export function TerminalSessionTabs({ sessions, selectedSessionId, onSelect, onAdd, onClose, onRename, theme, t }: TerminalSessionTabsProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedSessionId]);

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-1"
      style={{ backgroundColor: theme.colors?.background, color: theme.colors?.foreground }}
      data-section="terminal-session-tabs">
      <div role="tablist" aria-label={t('terminal.sessions.title')} className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {sessions.map((session, index) => {
          const selected = session.id === selectedSessionId;
          const title = session.customName || `${t('terminal.sessions.title')} ${index + 1}`;
          return (
            <div key={session.id} ref={selected ? activeTabRef : undefined}
              role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1}
              aria-label={title}
              className={`flex h-6 max-w-48 shrink-0 cursor-pointer items-center gap-2 rounded border px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary ${selected ? 'border-primary text-primary' : 'border-border/60 opacity-70 hover:opacity-100'}`}
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => setRenamingId(session.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'F2') { event.preventDefault(); setRenamingId(session.id); }
                if (event.key === 'Delete') { event.preventDefault(); onClose(session.id); }
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + sessions.length) % sessions.length;
                  onSelect(sessions[next].id);
                  const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
                  tabs?.[next]?.focus();
                }
              }}>
              {renamingId === session.id ? (
                <SessionInlineRenameInput initialName={title} className="w-24 text-xs"
                  onCommit={(name) => { onRename(session.id, name); setRenamingId(null); }}
                  onCancel={() => setRenamingId(null)} />
              ) : <span className="truncate">{title}</span>}
              <button type="button" className="shrink-0 rounded opacity-60 hover:opacity-100 focus-visible:ring-1 focus-visible:ring-primary"
                aria-label={`${t('terminal.sessions.close')}: ${title}`}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onClose(session.id); }}>
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-70 hover:bg-primary/10 hover:opacity-100 focus-visible:ring-1 focus-visible:ring-primary"
        aria-label={t('terminal.sessions.add')} title={t('terminal.sessions.add')} onClick={onAdd}>
        <Plus size={14} />
      </button>
    </div>
  );
}
