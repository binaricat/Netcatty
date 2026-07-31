/**
 * Terminal Compose Bar
 * An immersive prompt bar below the terminal with a quick-snippet strip,
 * user-resizable height, and terminal-matched chrome.
 */
import { GripHorizontal, Pin, Plus, Radio, Search, X } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useComposeBarHeight } from '../../application/state/useComposeBarHeight';
import { useComposeBarHistory } from '../../application/state/useComposeBarHistory';
import { useComposeBarPinnedSnippets } from '../../application/state/useComposeBarPinnedSnippets';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  appendComposeBarHistory,
  canNavigateComposeBarHistory,
  navigateComposeBarHistory,
} from '../../domain/composeBarHistory';
import { resolveSnippetCommand } from '../SnippetExecutionProvider';
import { Snippet } from '../../types';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  buildSnippetIdKey,
  filterComposeBarSnippets,
  mergeComposeBarSnippetMap,
  resolveComposeBarDefaultSeedIds,
} from './composeBarHelpers';

const SNIPPET_STRIP_HEIGHT = 30;
const RESIZE_HANDLE_HEIGHT = 6;

type ComposeBarTheme = {
  resolvedBg: string;
  resolvedFg: string;
  borderColor: string;
  mutedFg: string;
  hoverBg: string;
  chipBg: string;
  chipHoverBg: string;
};

function buildTheme(themeColors?: { background: string; foreground: string }): ComposeBarTheme {
  const bg = themeColors?.background ?? '#0a0a0a';
  const fg = themeColors?.foreground ?? '#d4d4d4';
  const resolvedBg = 'var(--terminal-ui-bg, ' + bg + ')';
  const resolvedFg = 'var(--terminal-ui-fg, ' + fg + ')';
  return {
    resolvedBg,
    resolvedFg,
    borderColor: `color-mix(in srgb, ${resolvedFg} 8%, ${resolvedBg} 92%)`,
    mutedFg: `color-mix(in srgb, ${resolvedFg} 55%, ${resolvedBg} 45%)`,
    hoverBg: `color-mix(in srgb, ${resolvedFg} 10%, ${resolvedBg} 90%)`,
    chipBg: `color-mix(in srgb, ${resolvedFg} 6%, ${resolvedBg} 94%)`,
    chipHoverBg: `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`,
  };
}

interface ComposeBarSnippetChipProps {
  snippet: Snippet;
  theme: ComposeBarTheme;
  onActivate: (snippet: Snippet, sendImmediately: boolean) => void;
  onUnpin: (id: string) => void;
  unpinLabel: string;
  clickHint: string;
}

const ComposeBarSnippetChip = memo(function ComposeBarSnippetChip({
  snippet,
  theme,
  onActivate,
  onUnpin,
  unpinLabel,
  clickHint,
}: ComposeBarSnippetChipProps) {
  const commandPreview = snippet.command.split('\n')[0];

  return (
    <div
      className="group/chip flex items-stretch h-6 max-w-[168px] rounded overflow-hidden flex-shrink-0 transition-colors duration-150"
      style={{ backgroundColor: theme.chipBg, color: theme.resolvedFg }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = theme.chipHoverBg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = theme.chipBg;
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex-1 min-w-0 px-2 text-[10px] font-mono truncate text-left"
            onClick={(e) => { void onActivate(snippet, e.shiftKey); }}
          >
            {snippet.label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="font-medium">{snippet.label}</p>
          <p className="text-[10px] opacity-80 mt-0.5 font-mono line-clamp-2">
            {commandPreview}
          </p>
          <p className="text-[10px] opacity-60 mt-1">{clickHint}</p>
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        className={cn(
          'flex items-center justify-center w-5 shrink-0',
          'opacity-40 hover:opacity-100 group-hover/chip:opacity-70',
          'transition-opacity duration-150',
        )}
        style={{ color: theme.mutedFg }}
        aria-label={unpinLabel}
        onClick={(e) => {
          e.stopPropagation();
          onUnpin(snippet.id);
        }}
      >
        <X size={9} />
      </button>
    </div>
  );
});

interface ComposeBarSnippetManagePopoverProps {
  snippets: Snippet[];
  pinnedCount: number;
  theme: ComposeBarTheme;
  isPinned: (id: string) => boolean;
  onTogglePin: (id: string) => void;
  manageLabel: string;
  searchPlaceholder: string;
  noSnippetsLabel: string;
  noMatchingLabel: string;
  pinnedCountLabel: string;
}

const ComposeBarSnippetManagePopover = memo(function ComposeBarSnippetManagePopover({
  snippets,
  pinnedCount,
  theme,
  isPinned,
  onTogglePin,
  manageLabel,
  searchPlaceholder,
  noSnippetsLabel,
  noMatchingLabel,
  pinnedCountLabel,
}: ComposeBarSnippetManagePopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filteredSnippets = useMemo(
    () => filterComposeBarSnippets(snippets, search),
    [snippets, search],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-6 w-6 flex-shrink-0 flex items-center justify-center rounded transition-colors duration-150"
          style={{ color: theme.mutedFg }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = theme.hoverBg;
            e.currentTarget.style.color = theme.resolvedFg;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = theme.mutedFg;
          }}
          aria-label={manageLabel}
          title={manageLabel}
        >
          <Plus size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-0"
        align="end"
        side="top"
        sideOffset={6}
        style={{
          backgroundColor: theme.resolvedBg,
          borderColor: theme.borderColor,
          color: theme.resolvedFg,
        }}
      >
        <div
          className="px-2.5 py-2 border-b"
          style={{ borderColor: theme.borderColor }}
        >
          <p className="text-[11px] font-semibold mb-1.5">{manageLabel}</p>
          <div
            className="flex items-center gap-1.5 rounded px-2 h-7"
            style={{ backgroundColor: theme.chipBg }}
          >
            <Search size={11} style={{ color: theme.mutedFg }} className="shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 min-w-0 bg-transparent text-[11px] font-mono outline-none placeholder:opacity-60"
              style={{ color: theme.resolvedFg }}
            />
          </div>
        </div>
        <div className="max-h-52 overflow-y-auto p-1">
          {snippets.length === 0 ? (
            <p className="text-[11px] px-2 py-3 text-center" style={{ color: theme.mutedFg }}>
              {noSnippetsLabel}
            </p>
          ) : filteredSnippets.length === 0 ? (
            <p className="text-[11px] px-2 py-3 text-center" style={{ color: theme.mutedFg }}>
              {noMatchingLabel}
            </p>
          ) : (
            filteredSnippets.map((snippet) => {
              const pinned = isPinned(snippet.id);
              return (
                <button
                  key={snippet.id}
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors duration-150"
                  style={{
                    color: theme.resolvedFg,
                    backgroundColor: pinned ? theme.chipHoverBg : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!pinned) e.currentTarget.style.backgroundColor = theme.hoverBg;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = pinned ? theme.chipHoverBg : 'transparent';
                  }}
                  onClick={() => onTogglePin(snippet.id)}
                >
                  <Pin
                    size={11}
                    className="shrink-0"
                    style={{
                      color: pinned ? theme.resolvedFg : theme.mutedFg,
                      fill: pinned ? 'currentColor' : 'none',
                    }}
                  />
                  <span className="flex-1 min-w-0 truncate text-[11px] font-mono">
                    {snippet.label}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {pinnedCount > 0 && (
          <div
            className="px-2.5 py-1.5 border-t text-[10px]"
            style={{ borderColor: theme.borderColor, color: theme.mutedFg }}
          >
            {pinnedCountLabel}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});

export interface TerminalComposeBarProps {
  onSend: (text: string) => void;
  onClose: () => void;
  onSnippetClick?: (snippet: Snippet) => void;
  snippets?: Snippet[];
  isBroadcastEnabled?: boolean;
  themeColors?: {
    background: string;
    foreground: string;
  };
}

export const TerminalComposeBar: React.FC<TerminalComposeBarProps> = ({
  onSend,
  onClose,
  onSnippetClick,
  snippets = [],
  isBroadcastEnabled,
  themeColors,
}) => {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [barHeight, setBarHeight, persistBarHeight] = useComposeBarHeight();
  const { entries: historyEntries, push: pushHistory } = useComposeBarHistory();
  const historyEntriesRef = useRef(historyEntries);
  const historyIndexRef = useRef(historyEntries.length);
  const historyDraftRef = useRef('');
  const heightRef = useRef(barHeight);

  historyEntriesRef.current = historyEntries;

  const snippetIdKey = useMemo(
    () => buildSnippetIdKey(snippets.map((snippet) => snippet.id)),
    [snippets],
  );
  const defaultSeedIds = useMemo(
    () => resolveComposeBarDefaultSeedIds(snippets),
    [snippets],
  );
  const { pinnedIds, unpin, toggle, isPinned } = useComposeBarPinnedSnippets(
    snippetIdKey,
    defaultSeedIds,
  );

  heightRef.current = barHeight;

  const theme = useMemo(() => buildTheme(themeColors), [themeColors]);

  const snippetsById = useMemo(
    () => mergeComposeBarSnippetMap(snippets),
    [snippets],
  );

  const pinnedSnippets = useMemo(
    () => pinnedIds
      .map((id) => snippetsById.get(id))
      .filter((snippet): snippet is Snippet => Boolean(snippet)),
    [pinnedIds, snippetsById],
  );

  const clickHint = t('terminal.composeBar.snippetClickHint');

  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
  }, []);

  const resetHistoryCursor = useCallback(() => {
    historyIndexRef.current = Number.POSITIVE_INFINITY;
    historyDraftRef.current = '';
  }, []);

  const applyHistoryValue = useCallback((value: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.value = value;
    const end = value.length;
    el.setSelectionRange(end, end);
    el.focus();
  }, []);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value;
    if (!text) return;
    // Keep the ref current before React re-renders so Up can recall immediately.
    historyEntriesRef.current = appendComposeBarHistory(historyEntriesRef.current, text);
    pushHistory(text);
    resetHistoryCursor();
    onSend(text);
    el.value = '';
    el.focus();
  }, [onSend, pushHistory, resetHistoryCursor]);

  const insertCommand = useCallback((command: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const prefix = el.value && !el.value.endsWith('\n') ? '\n' : '';
    el.value = el.value ? `${el.value}${prefix}${command}` : command;
    el.focus();
  }, []);

  const handleSnippetActivate = useCallback(async (snippet: Snippet, sendImmediately: boolean) => {
    if (sendImmediately) {
      if (onSnippetClick) {
        onSnippetClick(snippet);
      } else {
        const command = await resolveSnippetCommand(snippet);
        if (command !== null) onSend(command);
      }
      return;
    }

    const command = await resolveSnippetCommand(snippet);
    if (command === null) return;
    insertCommand(command);
  }, [insertCommand, onSend, onSnippetClick]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (isComposingRef.current) return;

    const el = e.currentTarget;
    const direction = e.key === 'ArrowUp' ? 'up' : 'down';
    if (!canNavigateComposeBarHistory(el.value, el.selectionStart, direction)) return;

    const next = navigateComposeBarHistory(
      {
        entries: historyEntriesRef.current,
        index: historyIndexRef.current,
        draft: historyDraftRef.current,
        currentValue: el.value,
      },
      direction,
    );
    if (!next) return;

    e.preventDefault();
    historyIndexRef.current = next.index;
    historyDraftRef.current = next.draft;
    applyHistoryValue(next.value);
  }, [applyHistoryValue, handleSend, onClose]);

  const handleHistoryDraftEdit = useCallback(() => {
    const entries = historyEntriesRef.current;
    if (historyIndexRef.current < entries.length) {
      historyIndexRef.current = entries.length;
      historyDraftRef.current = textareaRef.current?.value ?? '';
    }
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeCleanupRef.current?.();

    const startY = e.clientY;
    const startHeight = heightRef.current;

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientY - startY;
      setBarHeight(startHeight - delta);
    };

    const cleanup = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      resizeCleanupRef.current = null;
    };

    const onUp = () => {
      persistBarHeight(heightRef.current);
      cleanup();
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [persistBarHeight, setBarHeight]);

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{
        height: barHeight,
        backgroundColor: theme.resolvedBg,
        borderTop: `1px solid ${theme.borderColor}`,
      }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('terminal.composeBar.resize')}
        className="flex-shrink-0 flex items-center justify-center cursor-ns-resize group"
        style={{ height: RESIZE_HANDLE_HEIGHT }}
        onMouseDown={handleResizeStart}
      >
        <GripHorizontal
          size={12}
          className="opacity-0 group-hover:opacity-60 transition-opacity"
          style={{ color: theme.mutedFg }}
        />
      </div>

      <div
        className="flex-shrink-0 flex items-center gap-1 px-2 min-w-0"
        style={{ height: SNIPPET_STRIP_HEIGHT }}
      >
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-thin">
          {pinnedSnippets.map((snippet) => (
            <ComposeBarSnippetChip
              key={snippet.id}
              snippet={snippet}
              theme={theme}
              clickHint={clickHint}
              unpinLabel={t('terminal.composeBar.unpinSnippet', { label: snippet.label })}
              onUnpin={unpin}
              onActivate={handleSnippetActivate}
            />
          ))}
        </div>

        <ComposeBarSnippetManagePopover
          snippets={snippets}
          pinnedCount={pinnedSnippets.length}
          theme={theme}
          isPinned={isPinned}
          onTogglePin={toggle}
          manageLabel={t('terminal.composeBar.manageSnippets')}
          searchPlaceholder={t('terminal.composeBar.searchSnippets')}
          noSnippetsLabel={t('terminal.toolbar.noSnippets')}
          noMatchingLabel={t('terminal.composeBar.noMatchingSnippets')}
          pinnedCountLabel={t('terminal.composeBar.pinnedCount', { count: pinnedSnippets.length })}
        />
      </div>

      <div className="flex-1 min-h-0 px-3 pt-1.5 pb-2 flex flex-col">
        <div className="flex flex-1 min-h-0 items-start gap-1.5">
          {isBroadcastEnabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center cursor-default pt-0.5 flex-shrink-0">
                  <Radio size={14} className="text-amber-400 animate-pulse" />
                </div>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.composeBar.broadcasting')}</TooltipContent>
            </Tooltip>
          )}

          <textarea
            ref={textareaRef}
            className={cn(
              'flex-1 min-w-0 min-h-0 h-full resize-none bg-transparent border-none px-0 py-0',
              'text-xs font-mono leading-relaxed outline-none',
              'placeholder:opacity-70 overflow-y-auto',
            )}
            style={{ color: theme.resolvedFg }}
            placeholder={t('terminal.composeBar.placeholder')}
            onKeyDown={handleKeyDown}
            onInput={handleHistoryDraftEdit}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="h-6 w-6 flex items-center justify-center rounded-md transition-colors duration-150 flex-shrink-0"
                style={{
                  color: theme.mutedFg,
                  background: 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = theme.hoverBg;
                  e.currentTarget.style.color = theme.resolvedFg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = theme.mutedFg;
                }}
                onClick={onClose}
              >
                <X size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.composeBar.close')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default TerminalComposeBar;
