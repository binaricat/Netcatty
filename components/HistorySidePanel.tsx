/**
 * HistorySidePanel — remote shell history browser for the terminal side panel.
 * Reads the remote host's shell history from the focused session and exposes
 * search, paste-to-terminal, and save-as-snippet actions.
 *
 * Uses VariableSizeVirtualList for performance with large history files (up to
 * 1000 entries). Long commands are truncated in the list; click a row to expand
 * the full text inline below that row.
 */

import {
  Clipboard as ClipboardIcon,
  FileCode,
  Play,
  RefreshCw,
  Search,
  Terminal as TerminalIcon,
} from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { Host, RemoteHistoryEntry } from '../domain/models';
import { cn } from '../lib/utils';
import type { RemoteHistoryHostState } from '../application/state/useRemoteHistoryState';
import {
  VariableSizeVirtualList,
  type VariableSizeVirtualListHandle,
} from './ui/VariableSizeVirtualList';
import { Input } from './ui/input';

export interface HistorySidePanelProps {
  focusedHost: Host | null;
  focusedSessionId: string | null;
  state: RemoteHistoryHostState;
  onFetch: (sessionId: string, hostId: string) => void;
  /** Paste into the terminal without executing (no trailing Enter). */
  onPasteToTerminal: (command: string) => void;
  /** Write to the terminal and execute (append Enter). */
  onRunInTerminal: (command: string) => void;
  isVisible?: boolean;
}

const SUPPORTED_PROTOCOLS = new Set(['ssh', 'mosh', 'et']);
const HISTORY_ROW_HEIGHT = 36;
const DETAIL_PADDING_Y = 12;
const DETAIL_LINE_HEIGHT = 16;
const DETAIL_MAX_COMMAND_LINES = 3;
const DETAIL_TIMESTAMP_HEIGHT = 14;
const DETAIL_ACTIONS_HEIGHT = 24;

function getDetailRowHeight(entry: RemoteHistoryEntry): number {
  const lineCount = Math.min(
    entry.command.split('\n').length,
    DETAIL_MAX_COMMAND_LINES,
  );
  const commandHeight = Math.max(lineCount, 1) * DETAIL_LINE_HEIGHT;
  const timestampBlock = entry.timestamp ? DETAIL_TIMESTAMP_HEIGHT + 4 : 0;
  return DETAIL_PADDING_Y + commandHeight + timestampBlock + 4 + DETAIL_ACTIONS_HEIGHT;
}

type HistoryListRow =
  | { type: 'entry'; entry: RemoteHistoryEntry }
  | { type: 'detail'; entry: RemoteHistoryEntry };

function buildHistoryListRows(
  entries: RemoteHistoryEntry[],
  selectedEntryId: string | null,
): HistoryListRow[] {
  const rows: HistoryListRow[] = [];
  for (const entry of entries) {
    rows.push({ type: 'entry', entry });
    if (selectedEntryId === entry.id) {
      rows.push({ type: 'detail', entry });
    }
  }
  return rows;
}

const HistorySidePanelInner: React.FC<HistorySidePanelProps> = ({
  focusedHost,
  focusedSessionId,
  state,
  onFetch,
  onPasteToTerminal,
  onRunInTerminal,
  isVisible = true,
}) => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const listRef = useRef<VariableSizeVirtualListHandle>(null);

  const protocol = focusedHost?.protocol;
  const isSupportedSession =
    !!focusedHost && !!focusedSessionId && SUPPORTED_PROTOCOLS.has(String(protocol ?? 'ssh'));

  useEffect(() => {
    if (!isVisible || !isSupportedSession || !focusedHost || !focusedSessionId) return;
    if (state.loading) return;
    if (state.fetchedAt != null || state.error) return;
    onFetch(focusedSessionId, focusedHost.id);
  }, [
    isVisible,
    isSupportedSession,
    focusedHost,
    focusedSessionId,
    state.loading,
    state.fetchedAt,
    state.error,
    onFetch,
  ]);

  const handleRefresh = useCallback(() => {
    if (!focusedHost || !focusedSessionId) return;
    onFetch(focusedSessionId, focusedHost.id);
  }, [focusedHost, focusedSessionId, onFetch]);

  useEffect(() => {
    setSelectedEntryId(null);
    setSearch('');
  }, [focusedHost?.id]);

  const filtered = useMemo((): RemoteHistoryEntry[] => {
    if (!search.trim()) return state.entries;
    const q = search.toLowerCase();
    return state.entries.filter((e) => e.command.toLowerCase().includes(q));
  }, [state.entries, search]);

  const listRows = useMemo(
    () => buildHistoryListRows(filtered, selectedEntryId),
    [filtered, selectedEntryId],
  );

  const handleSaveAsSnippet = useCallback((entry: RemoteHistoryEntry) => {
    window.dispatchEvent(
      new CustomEvent('netcatty:snippets:add', {
        detail: { command: entry.command },
      }),
    );
  }, []);

  const handleRowClick = useCallback((entryId: string) => {
    setSelectedEntryId((current) => {
      const next = current === entryId ? null : entryId;
      if (next) {
        requestAnimationFrame(() => {
          const detailIndex = buildHistoryListRows(filtered, next).findIndex(
            (row) => row.type === 'detail' && row.entry.id === next,
          );
          if (detailIndex >= 0) {
            listRef.current?.scrollToIndex(detailIndex, 'auto');
          }
        });
      }
      return next;
    });
  }, [filtered]);

  const getRowHeight = useCallback(
    (row: HistoryListRow) =>
      row.type === 'entry' ? HISTORY_ROW_HEIGHT : getDetailRowHeight(row.entry),
    [],
  );

  const labels = useMemo(
    () => ({
      paste: t('history.action.paste'),
      run: t('history.action.run'),
      save: t('history.action.saveAsSnippet'),
    }),
    [t],
  );

  if (!isVisible) return null;

  return (
    <div
      className="h-full flex flex-col bg-background overflow-hidden"
      data-section="history-panel"
    >
      <div className="shrink-0 px-2 py-1.5 border-b border-border/50 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('history.searchPlaceholder')}
            className="h-7 pl-7 text-xs bg-muted/30 border-none"
          />
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={!isSupportedSession || state.loading}
          title={t('history.action.refresh')}
          aria-label={t('history.action.refresh')}
          className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:bg-transparent"
        >
          <RefreshCw size={14} className={cn(state.loading && 'animate-spin')} />
        </button>
      </div>

      {focusedHost && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/30 min-h-[28px]">
          <TerminalIcon size={10} className="shrink-0" />
          <span className="truncate">{focusedHost.label}</span>
          {state.fetchedAt && (
            <span className="ml-auto shrink-0 opacity-70">
              {t('history.meta.count', { count: state.entries.length })}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0">
        {!focusedHost && (
          <EmptyState message={t('history.empty.noSession')} />
        )}

        {focusedHost && !isSupportedSession && (
          <EmptyState message={t('history.empty.unsupportedProtocol')} />
        )}

        {focusedHost && isSupportedSession && state.loading && state.entries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-muted-foreground text-center">
            <RefreshCw size={20} className="opacity-60 mb-2 animate-spin" />
            <span className="text-xs">{t('history.loading')}</span>
          </div>
        )}

        {focusedHost && isSupportedSession && state.error && (
          <div className="px-3 py-4 text-xs text-center">
            <div className="text-destructive mb-2">{state.error}</div>
            <button
              type="button"
              onClick={handleRefresh}
              className="text-primary hover:underline"
            >
              {t('history.action.retry')}
            </button>
          </div>
        )}

        {focusedHost &&
          isSupportedSession &&
          !state.loading &&
          !state.error &&
          state.entries.length === 0 && (
            <EmptyState message={t('history.empty.noHistory')} />
          )}

        {filtered.length === 0 && state.entries.length > 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground italic text-center">
            {t('common.noResultsFound')}
          </div>
        )}

        {listRows.length > 0 && (
          <VariableSizeVirtualList
            ref={listRef}
            items={listRows}
            getItemHeight={getRowHeight}
            getItemKey={(row, index) =>
              row.type === 'entry' ? row.entry.id : `detail-${row.entry.id}-${index}`}
            renderItem={(row) => {
              if (row.type === 'detail') {
                return (
                  <HistoryDetailStrip
                    entry={row.entry}
                    labels={labels}
                    onRun={() => onRunInTerminal(row.entry.command)}
                    onPaste={() => onPasteToTerminal(row.entry.command)}
                    onSave={() => handleSaveAsSnippet(row.entry)}
                  />
                );
              }
              return (
                <HistoryRow
                  entry={row.entry}
                  isSelected={selectedEntryId === row.entry.id}
                  labels={labels}
                  onSelect={() => handleRowClick(row.entry.id)}
                  onRun={() => onRunInTerminal(row.entry.command)}
                  onPaste={() => onPasteToTerminal(row.entry.command)}
                  onSave={() => handleSaveAsSnippet(row.entry)}
                />
              );
            }}
          />
        )}
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex flex-col items-center justify-center py-10 px-4 text-muted-foreground text-center">
    <TerminalIcon size={24} className="opacity-40 mb-2" />
    <span className="text-xs">{message}</span>
  </div>
);

interface HistoryDetailStripProps {
  entry: RemoteHistoryEntry;
  labels: { paste: string; run: string; save: string };
  onRun: () => void;
  onPaste: () => void;
  onSave: () => void;
}

const HistoryDetailStrip: React.FC<HistoryDetailStripProps> = memo(
  ({ entry, labels, onRun, onPaste, onSave }) => (
    <div
      className="border-b border-border/40 bg-muted/20 px-3 py-1.5"
      data-section="history-detail"
    >
      <div
        className="font-mono text-[11px] leading-4 whitespace-pre-wrap break-words line-clamp-3 overflow-hidden"
        style={{ overflowWrap: 'anywhere' }}
      >
        {entry.command}
      </div>
      <div className="flex items-center gap-1 mt-1 min-h-6">
        {entry.timestamp ? (
          <span className="flex-1 min-w-0 text-[10px] text-muted-foreground truncate">
            {new Date(entry.timestamp).toLocaleString()}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <IconButton title={labels.run} onClick={onRun}>
          <Play size={12} />
        </IconButton>
        <IconButton title={labels.paste} onClick={onPaste}>
          <ClipboardIcon size={12} />
        </IconButton>
        <IconButton title={labels.save} onClick={onSave}>
          <FileCode size={12} />
        </IconButton>
      </div>
    </div>
  ),
);
HistoryDetailStrip.displayName = 'HistoryDetailStrip';

interface HistoryRowProps {
  entry: RemoteHistoryEntry;
  isSelected: boolean;
  labels: { paste: string; run: string; save: string };
  onSelect: () => void;
  onRun: () => void;
  onPaste: () => void;
  onSave: () => void;
}

const HistoryRow: React.FC<HistoryRowProps> = memo(
  ({ entry, isSelected, labels, onSelect, onRun, onPaste, onSave }) => {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect();
    };

    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.detail > 1) {
        event.preventDefault();
      }
    };

    return (
      <div
        className={cn(
          'group flex select-none items-center gap-2 px-3 h-full hover:bg-accent/50 transition-colors cursor-pointer',
          isSelected && 'bg-accent/30',
        )}
        role="button"
        tabIndex={0}
        aria-expanded={isSelected}
        title={isSelected ? undefined : entry.command}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
      >
        <div className="w-0 flex-1 min-w-0 font-mono text-[11px] truncate whitespace-nowrap">
          {entry.command}
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <IconButton title={labels.run} onClick={onRun}>
            <Play size={12} />
          </IconButton>
          <IconButton title={labels.paste} onClick={onPaste}>
            <ClipboardIcon size={12} />
          </IconButton>
          <IconButton title={labels.save} onClick={onSave}>
            <FileCode size={12} />
          </IconButton>
        </div>
      </div>
    );
  },
);
HistoryRow.displayName = 'HistoryRow';

const IconButton: React.FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
  >
    {children}
  </button>
);

export const HistorySidePanel = memo(HistorySidePanelInner);
HistorySidePanel.displayName = 'HistorySidePanel';
