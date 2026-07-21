/**
 * AddToWorkspaceDialog — lightweight multi-select picker for appending
 * new panes into the active workspace. Visually matches QuickSwitcher
 * (fixed top overlay, same header / row chrome) but with checkmarks on
 * the right and a thin footer to commit the selection.
 */
import { Check, Search, Terminal } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Host } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';

export type AddTarget =
  | { kind: 'local' }
  | { kind: 'host'; host: Host };

interface AddToWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: Host[];
  workspaceTitle?: string;
  onAdd: (targets: AddTarget[]) => void;
}

const LOCAL_ITEM_ID = '__local-terminal__';

type Item =
  | { type: 'local'; id: typeof LOCAL_ITEM_ID }
  | { type: 'host'; id: string; host: Host };

export function shouldToggleWorkspaceTarget(
  key: string,
  query: string,
  metaKey: boolean,
  ctrlKey: boolean,
): boolean {
  if (metaKey || ctrlKey) return false;
  return key === 'Enter' || (key === ' ' && query.length === 0);
}

export function getWorkspaceTargetRowStateClass(
  isCursor: boolean,
  isChecked: boolean,
): string {
  if (isCursor && isChecked) return 'bg-primary/20';
  if (isCursor) return 'bg-primary/15';
  if (isChecked) return 'bg-primary/10';
  return 'hover:bg-muted/50';
}

export const AddToWorkspaceDialog: React.FC<AddToWorkspaceDialogProps> = ({
  open,
  onOpenChange,
  hosts,
  workspaceTitle,
  onAdd,
}) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset on open + auto-focus the search input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(new Set());
    setSelectedIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onOpenChange]);

  // NOTE: no serial filter here — callers decide which subset of
  // hosts to pass based on mode. `appendHostToWorkspace` cannot build
  // a serial session, so append mode passes non-serial hosts only;
  // `createWorkspaceFromTargets` handles serial explicitly, so create
  // mode passes everything.
  const selectableHosts = hosts;

  const localMatches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return 'local terminal localhost'.includes(term);
  }, [query]);

  const filteredHosts = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return selectableHosts;
    return selectableHosts.filter((h) =>
      (h.label?.toLowerCase().includes(term))
      || (h.hostname?.toLowerCase().includes(term))
      || (h.username?.toLowerCase().includes(term))
      || (h.group?.toLowerCase().includes(term)),
    );
  }, [selectableHosts, query]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    if (localMatches) list.push({ type: 'local', id: LOCAL_ITEM_ID });
    for (const h of filteredHosts) list.push({ type: 'host', id: h.id, host: h });
    return list;
  }, [localMatches, filteredHosts]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleTargetClick = (index: number, id: string) => {
    setSelectedIndex(index);
    toggle(id);
    inputRef.current?.focus();
  };

  const handleCommit = () => {
    if (selected.size === 0) return;
    const targets: AddTarget[] = [];
    if (selected.has(LOCAL_ITEM_ID)) targets.push({ kind: 'local' });
    for (const host of selectableHosts) {
      if (selected.has(host.id)) targets.push({ kind: 'host', host });
    }
    if (targets.length === 0) return;
    onAdd(targets);
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (shouldToggleWorkspaceTarget(e.key, query, e.metaKey, e.ctrlKey)) {
      if (items.length === 0) return;
      e.preventDefault();
      toggle(items[selectedIndex].id);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleCommit();
    }
  };

  if (!open) return null;

  const count = selected.size;
  const localIndex = items.findIndex((it) => it.type === 'local');
  const firstHostIndex = items.findIndex((it) => it.type === 'host');

  return (
    <div
      className="fixed inset-x-0 top-12 z-50 flex justify-center pt-2"
      style={{ pointerEvents: 'none' }}
    >
      <div
        ref={containerRef}
        className="w-full max-w-2xl mx-4 bg-background border border-border rounded-xl shadow-2xl overflow-hidden max-h-[520px] flex flex-col"
        style={{ pointerEvents: 'auto' }}
      >
        {/* Search header — mirrors QuickSwitcher chrome. */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search hosts or local shells..."
            className="flex-1 h-8 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0 text-sm"
          />
          {workspaceTitle && (
            <span className="text-[11px] text-muted-foreground truncate max-w-[180px]">
              {workspaceTitle}
            </span>
          )}
        </div>

        <ScrollArea className="flex-1 h-full">
          <div>
            {/* Jump-to hint */}
            <div className="px-4 py-2 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Pick one or more</span>
              <kbd className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">Space / Enter</kbd>
              <span className="text-[10px] text-muted-foreground">toggle</span>
              <kbd className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">
                {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter
              </kbd>
              <span className="text-[10px] text-muted-foreground">add</span>
            </div>

            {/* Local Shells section */}
            {localIndex !== -1 && (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Local Shells
                  </span>
                </div>
                {(() => {
                  const idx = localIndex;
                  const isCursor = idx === selectedIndex;
                  const isChecked = selected.has(LOCAL_ITEM_ID);
                  return (
                    <div
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getWorkspaceTargetRowStateClass(isCursor, isChecked)}`}
                      onClick={() => handleTargetClick(idx, LOCAL_ITEM_ID)}
                    >
                      <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                        <Terminal size={16} />
                      </div>
                      <span className="text-sm font-medium flex-1 truncate">Local Terminal</span>
                      {isChecked && <Check size={14} className="text-primary flex-shrink-0" />}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Hosts section */}
            {filteredHosts.length > 0 && (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Hosts</span>
                </div>
                {filteredHosts.map((host, i) => {
                  const idx = firstHostIndex + i;
                  const isCursor = idx === selectedIndex;
                  const isChecked = selected.has(host.id);
                  return (
                    <div
                      key={host.id}
                      className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${getWorkspaceTargetRowStateClass(isCursor, isChecked)}`}
                      onClick={() => handleTargetClick(idx, host.id)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <DistroAvatar host={host} fallback={(host.label || host.hostname).slice(0, 2).toUpperCase()} size="sm" />
                        <span className="text-sm font-medium truncate">{host.label || host.hostname}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-[11px] text-muted-foreground">
                          {host.group ? `Personal / ${host.group}` : 'Personal'}
                        </div>
                        {isChecked && <Check size={14} className="text-primary flex-shrink-0" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {items.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No matches
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Slim footer to commit. Kept minimal so the layout feels like
            QuickSwitcher's chrome with a single action strip tacked on. */}
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={count === 0} onClick={handleCommit}>
            {count === 0 ? 'Add' : `Add ${count}`}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AddToWorkspaceDialog;
