import React from 'react';
import { Monitor, TerminalSquare } from 'lucide-react';
import { Host } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface QuickSwitcherProps {
  isOpen: boolean;
  query: string;
  results: Host[];
  onQueryChange: (value: string) => void;
  onSelect: (host: Host) => void;
  onClose: () => void;
  onCreateLocalTerminal?: () => void;
}

export const QuickSwitcher: React.FC<QuickSwitcherProps> = ({
  isOpen,
  query,
  results,
  onQueryChange,
  onSelect,
  onClose,
  onCreateLocalTerminal,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-lg flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-w-5xl w-full mx-auto px-6 pt-14 space-y-4 app-no-drag">
        <div className="flex items-center gap-3">
          <Input
            autoFocus
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder="Search hosts or tabs..."
            className="h-12 text-sm bg-secondary border-primary/50 focus-visible:ring-primary"
          />
          <div className="text-xs text-muted-foreground">⌘K</div>
        </div>
        <div className="bg-secondary/90 border border-border/70 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-4 py-3 flex items-center justify-between text-xs font-semibold text-muted-foreground/90">
            <span>Recent connections</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled>Create a workspace</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled>Restore</Button>
              {onCreateLocalTerminal && (
                <Button
                  size="sm"
                  className="h-7 px-3 text-[11px]"
                  onClick={(e) => { e.stopPropagation(); onCreateLocalTerminal(); onClose(); }}
                >
                  <TerminalSquare size={12} className="mr-1" /> Terminal
                </Button>
              )}
            </div>
          </div>
          <div className="divide-y divide-border/70">
            {results.length > 0 ? results.map(host => (
              <div
                key={host.id}
                className="flex items-center justify-between px-4 py-3 hover:bg-primary/10 cursor-pointer transition-colors"
                onClick={(e) => { e.stopPropagation(); onSelect(host); }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-md flex items-center justify-center bg-primary/15 text-primary">
                    <Monitor size={14} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{host.label}</div>
                    <div className="text-[11px] text-muted-foreground font-mono truncate">{host.username}@{host.hostname}</div>
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">{host.group || 'Personal'}</div>
              </div>
            )) : (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">No matches. Start typing to search.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
