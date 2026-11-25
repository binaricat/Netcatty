import { ComposeDirectoryPicker } from './ComposeDirectoryPicker';
/**
 * Terminal Compose Bar
 * An immersive prompt bar below the terminal with a quick-snippet strip,
 * user-resizable height, and terminal-matched chrome.
 */
import { GripHorizontal, Pin, Plus, Radio, Search, X } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { terminalReconnectRegistry } from '../../application/state/terminalReconnectRegistry';
import { useComposeBarHistory } from '../../application/state/useComposeBarHistory';
import { canNavigateComposeBarHistory } from '../../domain/composeBarHistory';
import type { PinnedSnippetDropPosition } from '../../domain/composeBarPinnedSnippets';
import { STORAGE_KEY_TERMINAL_BROADCAST_PASSWORD_BYPASS } from '../../infrastructure/config/storageKeys';
import { useStoredBoolean } from '../../application/state/useStoredBoolean';
import { useComposeBarHeight } from '../../application/state/useComposeBarHeight';
import { useComposeBarPinnedSnippets } from '../../application/state/useComposeBarPinnedSnippets';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
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

export const COMPOSE_SNIPPET_DRAG_MIME = 'application/x-netcatty-compose-snippet';

const COMPOSE_EDITABLE_CONTEXT_SELECTOR = 'textarea, input, [contenteditable]';

function hasComposeSnippetDragType(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes(COMPOSE_SNIPPET_DRAG_MIME);
}

function resolveChipDropPosition(
  event: Pick<React.DragEvent<HTMLElement>, 'clientX' | 'currentTarget'>,
): PinnedSnippetDropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  if (!rect || rect.width <= 0) return 'before';
  return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
}

function resolveStripDropTarget(
  strip: HTMLElement,
  clientX: number,
  pinnedSnippets: readonly Snippet[],
): { id: string; position: PinnedSnippetDropPosition } | null {
  const lastSnippet = pinnedSnippets[pinnedSnippets.length - 1];
  if (!lastSnippet) return null;

  const chips = Array.from(strip.querySelectorAll<HTMLElement>('[data-compose-snippet-id]'));
  for (const chip of chips) {
    const id = chip.dataset.composeSnippetId;
    if (!id) continue;
    const rect = chip.getBoundingClientRect();
    if (!rect || rect.width <= 0) continue;
    if (clientX < rect.left + rect.width / 2) {
      return { id, position: 'before' };
    }
  }

  return { id: lastSnippet.id, position: 'after' };
}

export type ComposeBarTheme = {
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
  canReorder: boolean;
  isBeingDragged: boolean;
  isDraggingAny: boolean;
  dropIndicator: PinnedSnippetDropPosition | null;
  onDragStart: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
  onDragEnd: () => void;
}

const ComposeBarSnippetChip = memo(function ComposeBarSnippetChip({
  snippet,
  theme,
  onActivate,
  onUnpin,
  unpinLabel,
  clickHint,
  canReorder,
  isBeingDragged,
  isDraggingAny,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ComposeBarSnippetChipProps) {
  const commandPreview = snippet.command.split('\n')[0];

  return (
    <div
      data-compose-snippet-id={snippet.id}
      draggable={canReorder}
      onDragStart={(event) => onDragStart(event, snippet.id)}
      onDragOver={(event) => onDragOver(event, snippet.id)}
      onDrop={(event) => onDrop(event, snippet.id)}
      onDragEnd={onDragEnd}
      className={cn(
        'group/chip relative flex items-stretch h-6 max-w-[168px] rounded overflow-hidden flex-shrink-0 transition-[background-color,opacity] duration-150',
        canReorder && 'cursor-grab active:cursor-grabbing',
        isBeingDragged && 'opacity-45',
      )}
      style={{ backgroundColor: theme.chipBg, color: theme.resolvedFg }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = theme.chipHoverBg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = theme.chipBg;
      }}
    >
      {dropIndicator && (
        <span
          aria-hidden="true"
          data-compose-snippet-drop-indicator={dropIndicator}
          className={cn(
            'pointer-events-none absolute inset-y-0.5 w-[2px] rounded-full z-10',
            dropIndicator === 'before' ? 'left-0' : 'right-0',
          )}
          style={{ backgroundColor: theme.resolvedFg }}
        />
      )}
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
        {!isDraggingAny && (
          <TooltipContent side="top" className="max-w-xs">
            <p className="font-medium">{snippet.label}</p>
            <p className="text-[10px] opacity-80 mt-0.5 font-mono line-clamp-2">
              {commandPreview}
            </p>
            <p className="text-[10px] opacity-60 mt-1">{clickHint}</p>
          </TooltipContent>
        )}
      </Tooltip>
      <button
        type="button"
        data-compose-snippet-unpin
        draggable={false}
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
        onContextMenu={(event) => event.stopPropagation()}
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
  contextChipsEnabled?: boolean;
  // Return false for rejected or sensitive input so it is not recalled.
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  sessionId: string;
  onClose: () => void;
  onSnippetClick?: (snippet: Snippet) => void;
  snippets?: Snippet[];
  isBroadcastEnabled?: boolean;
  /** Compose-bar send target. Undefined follows toolbar broadcast. */
  composeSendToAll?: boolean;
  onToggleComposeSendTarget?: () => void;
  themeColors?: {
    background: string;
    foreground: string;
  };
}

export const TerminalComposeBar: React.FC<TerminalComposeBarProps> = ({
  onSend,
  contextChipsEnabled = true,
  sessionId,
  onClose,
  onSnippetClick,
  snippets = [],
  isBroadcastEnabled,
  composeSendToAll,
  onToggleComposeSendTarget,
  themeColors,
}) => {
  const { t } = useI18n();
  const { readClipboardText, writeClipboardText } = useClipboardBackend();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const restoreDraft = useCallback((draft: string) => {
    if (textareaRef.current) textareaRef.current.value = draft;
  }, []);
  const { prepareRecord, navigate, reset } = useComposeBarHistory(sessionId, restoreDraft);
  const isComposingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [barHeight, setBarHeight, persistBarHeight] = useComposeBarHeight();
  const heightRef = useRef(barHeight);

  const snippetIdKey = useMemo(
    () => buildSnippetIdKey(snippets.map((snippet) => snippet.id)),
    [snippets],
  );
  const defaultSeedIds = useMemo(
    () => resolveComposeBarDefaultSeedIds(snippets),
    [snippets],
  );
  const { pinnedIds, unpin, toggle, reorder, isPinned } = useComposeBarPinnedSnippets(
    snippetIdKey,
    defaultSeedIds,
  );
  const draggedSnippetIdRef = useRef<string | null>(null);
  const [draggedSnippetId, setDraggedSnippetId] = useState<string | null>(null);
  const [snippetDropTarget, setSnippetDropTarget] = useState<{
    id: string;
    position: PinnedSnippetDropPosition;
  } | null>(null);

  heightRef.current = barHeight;

  const theme = useMemo(() => buildTheme(themeColors), [themeColors]);

  // Opt-in "broadcast without password protection" (#3488). Shared storage key
  // with the terminal runtime, which reads it to keep broadcasting during
  // password / interactive prompts while this switch is on.
  const [allowPasswordBroadcast, setAllowPasswordBroadcast] = useStoredBoolean(
    STORAGE_KEY_TERMINAL_BROADCAST_PASSWORD_BYPASS,
    false,
  );
  const [broadcastMenuAnchor, setBroadcastMenuAnchor] = useState<{ x: number; y: number; inTextarea: boolean } | null>(null);

  useEffect(() => {
    if (!broadcastMenuAnchor) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-compose-broadcast-menu]')) return;
      setBroadcastMenuAnchor(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBroadcastMenuAnchor(null);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [broadcastMenuAnchor]);

  const sendToAll = composeSendToAll ?? Boolean(isBroadcastEnabled);
  const handleBroadcastContextMenu = useCallback((event: React.MouseEvent) => {
    // A solo composer is inside the terminal's context-menu trigger, but this
    // gesture must never run a terminal action (such as paste into the PTY).
    event.stopPropagation();
    if (!isBroadcastEnabled && !sendToAll) {
      const targetElement = event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
      if (!targetElement?.closest(COMPOSE_EDITABLE_CONTEXT_SELECTOR)) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    setBroadcastMenuAnchor({
      x: event.clientX,
      y: event.clientY,
      inTextarea: event.target instanceof Element && Boolean(event.target.closest('textarea')),
    });
  }, [isBroadcastEnabled, sendToAll]);

  const handleComposeMenuEdit = useCallback(async (action: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    setBroadcastMenuAnchor(null);
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    if (action === 'selectAll') {
      textarea.select();
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    try {
      if (action === 'paste') {
        let text: string | undefined;
        try { text = await readClipboardText(); } catch { /* Use browser clipboard. */ }
        if (typeof text !== 'string') text = await navigator.clipboard.readText();
        if (!text) return;
        textarea.setSelectionRange(start, end);
        if (!document.execCommand('insertText', false, text)) {
          textarea.setRangeText(text, start, end, 'end');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        reset();
        return;
      }
      if (start === end) return;
      const selectedText = textarea.value.slice(start, end);
      let wroteToBridge = false;
      try { wroteToBridge = await writeClipboardText(selectedText); } catch { /* Use browser clipboard. */ }
      if (!wroteToBridge) {
        await navigator.clipboard.writeText(selectedText);
      }
      if (action === 'cut') {
        textarea.setSelectionRange(start, end);
        if (!document.execCommand('delete')) {
          textarea.setRangeText('', start, end, 'end');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        reset();
      }
    } catch (error) {
      console.error('Compose bar clipboard action failed', error);
    }
  }, [readClipboardText, reset, writeClipboardText]);

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
  const canReorderSnippets = pinnedSnippets.length > 1;

  const clearSnippetDragState = useCallback(() => {
    draggedSnippetIdRef.current = null;
    setDraggedSnippetId(null);
    setSnippetDropTarget(null);
  }, []);

  const isComposeSnippetDragEvent = useCallback((event: React.DragEvent) => (
    draggedSnippetIdRef.current !== null || hasComposeSnippetDragType(event.dataTransfer)
  ), []);

  const readDraggedSnippetId = useCallback((event: React.DragEvent): string | null => {
    if (draggedSnippetIdRef.current) return draggedSnippetIdRef.current;
    try {
      const fromTransfer = event.dataTransfer?.getData(COMPOSE_SNIPPET_DRAG_MIME);
      return fromTransfer || null;
    } catch {
      return null;
    }
  }, []);

  const handleSnippetDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!canReorderSnippets) {
      event.preventDefault();
      return;
    }
    const targetElement = event.target instanceof Element ? event.target : null;
    if (targetElement?.closest('[data-compose-snippet-unpin]')) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    draggedSnippetIdRef.current = id;
    setDraggedSnippetId(id);
    setSnippetDropTarget(null);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(COMPOSE_SNIPPET_DRAG_MIME, id);
      } catch {
        // Ignore synthetic DragEvent implementations without writable dataTransfer.
      }
    }
  }, [canReorderSnippets]);

  const handleSnippetDragOver = useCallback((event: React.DragEvent<HTMLDivElement>, targetId: string) => {
    if (!isComposeSnippetDragEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    const draggedId = readDraggedSnippetId(event);
    if (draggedId && draggedId === targetId) {
      setSnippetDropTarget(null);
      return;
    }
    const position = resolveChipDropPosition(event);
    setSnippetDropTarget((prev) => (
      prev?.id === targetId && prev.position === position ? prev : { id: targetId, position }
    ));
  }, [isComposeSnippetDragEvent, readDraggedSnippetId]);

  const handleSnippetDrop = useCallback((event: React.DragEvent<HTMLDivElement>, targetId: string) => {
    if (!isComposeSnippetDragEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedId = readDraggedSnippetId(event);
    const position = resolveChipDropPosition(event);
    clearSnippetDragState();
    if (!draggedId || draggedId === targetId) return;
    reorder(draggedId, targetId, position);
  }, [clearSnippetDragState, isComposeSnippetDragEvent, readDraggedSnippetId, reorder]);

  const handleSnippetStripDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isComposeSnippetDragEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (event.target !== event.currentTarget) return;
    const draggedId = readDraggedSnippetId(event);
    const target = resolveStripDropTarget(event.currentTarget, event.clientX, pinnedSnippets);
    if (!target || target.id === draggedId) {
      setSnippetDropTarget(null);
      return;
    }
    setSnippetDropTarget((prev) => (
      prev?.id === target.id && prev.position === target.position ? prev : target
    ));
  }, [isComposeSnippetDragEvent, pinnedSnippets, readDraggedSnippetId]);

  const handleSnippetStripDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isComposeSnippetDragEvent(event)) return;
    event.stopPropagation();
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setSnippetDropTarget(null);
  }, [isComposeSnippetDragEvent]);

  const handleSnippetStripDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isComposeSnippetDragEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedId = readDraggedSnippetId(event);
    const target = resolveStripDropTarget(event.currentTarget, event.clientX, pinnedSnippets);
    clearSnippetDragState();
    if (!draggedId || !target || draggedId === target.id) return;
    reorder(draggedId, target.id, target.position);
  }, [clearSnippetDragState, isComposeSnippetDragEvent, pinnedSnippets, readDraggedSnippetId, reorder]);

  const isolateComposeSnippetDrag = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isComposeSnippetDragEvent(event)) return;
    event.stopPropagation();
  }, [isComposeSnippetDragEvent]);

  const clickHint = t('terminal.composeBar.snippetClickHint');

  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
  }, []);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value;
    if (!text) return;
    const recordSent = prepareRecord();
    let result: ReturnType<typeof onSend>;
    try {
      result = onSend(text);
    } catch (error) {
      recordSent();
      throw error;
    }
    void Promise.resolve(result).then((sent) => {
      recordSent(sent !== false ? text : undefined);
    }).catch((error: unknown) => {
      recordSent();
      console.error('Compose bar send failed', error);
    });
    reset();
    el.value = '';
    el.focus();
  }, [onSend, prepareRecord, reset]);

  const insertCommand = useCallback((command: string) => {
    const el = textareaRef.current;
    if (!el) return;
    reset();
    const prefix = el.value && !el.value.endsWith('\n') ? '\n' : '';
    el.value = el.value ? `${el.value}${prefix}${command}` : command;
    el.focus();
  }, [reset]);

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
    if (isComposingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const el = e.currentTarget;
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      if (canNavigateComposeBarHistory(el.value, el.selectionStart, direction, el.selectionEnd)) {
        const value = navigate(el.value, direction);
        if (value !== undefined) {
          e.preventDefault();
          el.value = value;
          const position = direction === 'up' ? 0 : value.length;
          el.setSelectionRange(position, position);
        }
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      // Plain Enter on an empty draft reconnects a disconnected session.
      // Modified Enter and a non-empty draft keep the existing send path (#3767).
      const plainEnter = !e.altKey && !e.ctrlKey && !e.metaKey;
      if (
        plainEnter
        && !e.currentTarget.value
        && terminalReconnectRegistry.requestEnterReconnect(sessionId)
      ) {
        return;
      }
      handleSend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleSend, navigate, onClose, sessionId]);

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
      data-section="terminal-compose-bar"
      style={{
        height: barHeight,
        backgroundColor: theme.resolvedBg,
        borderTop: `1px solid ${theme.borderColor}`,
      }}
      onContextMenu={handleBroadcastContextMenu}
      onDragEnter={isolateComposeSnippetDrag}
      onDragOver={isolateComposeSnippetDrag}
      onDragLeave={isolateComposeSnippetDrag}
      onDrop={isolateComposeSnippetDrag}
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
        <div
          data-compose-snippet-strip
          className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-thin"
          onDragOver={handleSnippetStripDragOver}
          onDragLeave={handleSnippetStripDragLeave}
          onDrop={handleSnippetStripDrop}
        >
          {pinnedSnippets.map((snippet) => (
            <ComposeBarSnippetChip
              key={snippet.id}
              snippet={snippet}
              theme={theme}
              clickHint={clickHint}
              unpinLabel={t('terminal.composeBar.unpinSnippet', { label: snippet.label })}
              onUnpin={unpin}
              onActivate={handleSnippetActivate}
              canReorder={canReorderSnippets}
              isBeingDragged={draggedSnippetId === snippet.id}
              isDraggingAny={draggedSnippetId !== null}
              dropIndicator={snippetDropTarget?.id === snippet.id ? snippetDropTarget.position : null}
              onDragStart={handleSnippetDragStart}
              onDragOver={handleSnippetDragOver}
              onDrop={handleSnippetDrop}
              onDragEnd={clearSnippetDragState}
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

      {contextChipsEnabled && <ComposeDirectoryPicker key={sessionId} sessionId={sessionId} theme={theme}
        onReturnFocus={() => textareaRef.current?.focus({ preventScroll: true })} />}

      <div className="flex-1 min-h-0 px-3 pt-1.5 pb-2 flex flex-col">
        <div className="flex flex-1 min-h-0 items-start gap-1.5">
          {(onToggleComposeSendTarget || sendToAll) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-compose-send-target={sendToAll ? 'all' : 'active'}
                  aria-pressed={sendToAll}
                  aria-label={sendToAll
                    ? t('terminal.composeBar.sendToAll')
                    : t('terminal.composeBar.sendToActive')}
                  className="flex items-center pt-0.5 flex-shrink-0 rounded-sm"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onToggleComposeSendTarget?.()}
                  onContextMenu={handleBroadcastContextMenu}
                >
                  <Radio
                    size={14}
                    className={sendToAll ? 'text-amber-400 animate-pulse' : undefined}
                    style={sendToAll ? undefined : { color: theme.mutedFg }}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {sendToAll
                  ? t('terminal.composeBar.broadcasting')
                  : t('terminal.composeBar.sendToActive')}
              </TooltipContent>
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
            onInput={reset}
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

      {broadcastMenuAnchor && (
        <div
          data-compose-broadcast-menu
          className="fixed z-[120] min-w-[240px] rounded-md border py-1 shadow-lg"
          style={{
            // Clamp horizontally so the 240px-min menu stays on-screen even
            // when the compose bar is right-clicked near the right edge.
            left: Math.max(4, Math.min(broadcastMenuAnchor.x, window.innerWidth - 244)),
            top: Math.max(4, Math.min(broadcastMenuAnchor.y, window.innerHeight - (broadcastMenuAnchor.inTextarea ? 160 : 48))),
            backgroundColor: theme.resolvedBg,
            borderColor: theme.borderColor,
            color: theme.resolvedFg,
          }}
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {broadcastMenuAnchor.inTextarea && (
            <>
              {(['cut', 'copy', 'paste', 'selectAll'] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  className="flex w-full items-center px-2.5 py-1.5 text-left text-[11px] transition-colors duration-150 hover:bg-black/20"
                  onClick={() => { void handleComposeMenuEdit(action); }}
                >
                  {t(`terminal.menu.${action}`)}
                </button>
              ))}
              <div className="my-1 border-t" style={{ borderColor: theme.borderColor }} />
            </>
          )}
          <button
            data-compose-broadcast-toggle
            type="button"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors duration-150 hover:bg-black/20"
            onClick={() => {
              setAllowPasswordBroadcast((prev) => !prev);
              setBroadcastMenuAnchor(null);
            }}
          >
            <span className="w-3 shrink-0 text-center" aria-hidden="true">
              {allowPasswordBroadcast ? '✓' : ''}
            </span>
            {t('terminal.composeBar.broadcastAllowPassword')}
          </button>
        </div>
      )}
    </div>
  );
};

export default TerminalComposeBar;
