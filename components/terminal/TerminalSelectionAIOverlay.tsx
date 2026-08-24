/**
 * Owns selection-driven "Add to AI" chrome so selection change does not re-render
 * the whole Terminal / TerminalView tree (common when focus moves to the AI input).
 */
import React, { memo, useEffect, useState, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { Sparkles } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  createCopyOnSelectUserGestureTracker,
  shouldWriteCopyOnSelect,
  subscribeCopyOnSelectUserCommand,
  subscribeCopyOnSelectUserGesture,
} from './copyOnSelect';
import { getTerminalSelectionForClipboard } from './normalizeTerminalSelection';
import { resolveSelectionOverlayPosition } from './useTerminalEffects';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { shouldShowSelectionAIOverlay } from './TerminalView';

type SelectionOverlayPosition = { left: number; top: number } | null;

const areSelectionOverlayPositionsEqual = (
  a: SelectionOverlayPosition,
  b: SelectionOverlayPosition,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top;
};

type Props = {
  termRef: RefObject<XTerm | null>;
  containerRef: RefObject<HTMLElement | null>;
  showSelectionAIAction?: boolean;
  onAddSelectionToAI?: () => void;
  copyOnSelect?: boolean;
  normalizeTextOnCopy?: boolean;
  /**
   * True while createXTermRuntime programmatically restores selection
   * (preserveSelectionOnInput). Copy-on-select must skip those events.
   */
  isRestoringSelectionRef?: RefObject<boolean>;
  isVisible?: boolean;
};

function TerminalSelectionAIOverlayInner({
  termRef,
  containerRef,
  showSelectionAIAction,
  onAddSelectionToAI,
  copyOnSelect,
  normalizeTextOnCopy = true,
  isRestoringSelectionRef,
  isVisible = true,
}: Props) {
  const { t } = useI18n();
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionOverlayPosition, setSelectionOverlayPosition] = useState<SelectionOverlayPosition>(null);

  useEffect(() => {
    if (!isVisible) return;

    let disposed = false;
    let overlayRafId: number | null = null;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    let waitRafId: number | null = null;
    let lastHasSelection: boolean | null = null;
    let lastOverlayPosition: SelectionOverlayPosition = null;
    let selectionDisposable: { dispose: () => void } | null = null;
    let scrollDisposable: { dispose: () => void } | null | undefined = null;
    let resizeDisposable: { dispose: () => void } | null | undefined = null;
    let resizeObserver: ResizeObserver | null = null;
    let userGestureUnsubscribe: (() => void) | null = null;
    let userGestureTracker: ReturnType<typeof createCopyOnSelectUserGestureTracker> | null = null;

    const requestFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
    const cancelFrame = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

    const cleanupListeners = () => {
      if (overlayRafId !== null) {
        cancelFrame(overlayRafId);
        overlayRafId = null;
      }
      if (copyTimer) {
        clearTimeout(copyTimer);
        copyTimer = null;
      }
      selectionDisposable?.dispose();
      selectionDisposable = null;
      scrollDisposable?.dispose();
      scrollDisposable = null;
      resizeDisposable?.dispose();
      resizeDisposable = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      userGestureUnsubscribe?.();
      userGestureUnsubscribe = null;
      userGestureTracker?.dispose();
      userGestureTracker = null;
    };

    const attach = (term: XTerm) => {
      cleanupListeners();
      userGestureTracker = createCopyOnSelectUserGestureTracker();
      const unsubscribePointer = subscribeCopyOnSelectUserGesture(term, userGestureTracker);
      const unsubscribeCommand = subscribeCopyOnSelectUserCommand(term, () => {
        userGestureTracker?.pulse();
      });
      userGestureUnsubscribe = () => {
        unsubscribePointer();
        unsubscribeCommand();
      };

      const publishSelectionOverlayPosition = () => {
        overlayRafId = null;
        if (disposed) return;
        const nextPosition = resolveSelectionOverlayPosition(term, containerRef.current);
        if (areSelectionOverlayPositionsEqual(lastOverlayPosition, nextPosition)) return;
        lastOverlayPosition = nextPosition;
        setSelectionOverlayPosition(nextPosition);
      };

      const scheduleSelectionOverlayPosition = () => {
        if (lastHasSelection === false) return;
        if (overlayRafId !== null) return;
        overlayRafId = requestFrame(publishSelectionOverlayPosition);
      };

      const onSelectionChange = (options?: { allowCopy?: boolean }) => {
        if (disposed) return;
        const allowCopy = options?.allowCopy !== false;
        const rawSelection = term.getSelection();
        const hasText = !!rawSelection && rawSelection.length > 0;
        if (lastHasSelection !== hasText) {
          lastHasSelection = hasText;
          setHasSelection(hasText);
        }
        if (copyTimer) {
          clearTimeout(copyTimer);
          copyTimer = null;
        }
        if (!hasText) {
          if (lastOverlayPosition !== null) {
            lastOverlayPosition = null;
            setSelectionOverlayPosition(null);
          }
          return;
        }
        scheduleSelectionOverlayPosition();

        // Skip programmatic selections: preserveSelectionOnInput restore,
        // SearchAddon match highlight (issue #3007), and the initial attach
        // snapshot so those writes cannot clobber a user copy.
        if (shouldWriteCopyOnSelect({
          allowCopy,
          hasText,
          copyOnSelect: !!copyOnSelect,
          isRestoringSelection: !!isRestoringSelectionRef?.current,
          isUserSelection: !!userGestureTracker?.isActive(),
        })) {
          const selection = getTerminalSelectionForClipboard(term, normalizeTextOnCopy);
          if (!selection) return;
          copyTimer = setTimeout(() => {
            void navigator.clipboard.writeText(selection).catch(() => {
              /* ignore clipboard failures */
            });
          }, 80);
        }
      };

      selectionDisposable = term.onSelectionChange(() => onSelectionChange());
      scrollDisposable = term.onScroll?.(scheduleSelectionOverlayPosition);
      resizeDisposable = term.onResize?.(scheduleSelectionOverlayPosition);
      resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleSelectionOverlayPosition);
      if (containerRef.current) {
        resizeObserver?.observe(containerRef.current);
      }
      // Sync UI only; do not write clipboard on reattach.
      onSelectionChange({ allowCopy: false });
    };

    // Child effects run before parent useTerminalEffects assigns termRef.
    // Poll until the xterm runtime exists so copy-on-select / overlay attach
    // for sessions that mount already visible. Bound the wait so a failed
    // runtime never leaves a permanent rAF loop.
    const waitStartedAt = Date.now();
    const MAX_RUNTIME_WAIT_MS = 15_000;
    const tryAttach = () => {
      if (disposed) return;
      const term = termRef.current;
      if (!term) {
        if (Date.now() - waitStartedAt >= MAX_RUNTIME_WAIT_MS) {
          waitRafId = null;
          return;
        }
        waitRafId = requestFrame(tryAttach);
        return;
      }
      waitRafId = null;
      attach(term);
    };
    tryAttach();

    return () => {
      disposed = true;
      if (waitRafId !== null) cancelFrame(waitRafId);
      cleanupListeners();
    };
  }, [
    termRef,
    containerRef,
    copyOnSelect,
    normalizeTextOnCopy,
    isRestoringSelectionRef,
    isVisible,
  ]);

  if (!shouldShowSelectionAIOverlay({
    hasSelection,
    selectionOverlayPosition,
    onAddSelectionToAI,
    showSelectionAIAction,
  }) || !onAddSelectionToAI || !selectionOverlayPosition) {
    return null;
  }

  return (
    <div
      className="absolute z-30 pointer-events-none"
      style={{
        left: selectionOverlayPosition.left,
        top: selectionOverlayPosition.top,
        transform: 'translate(-100%, -100%)',
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="pointer-events-auto inline-flex h-7 min-w-max items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-medium shadow-lg backdrop-blur-md transition-colors hover:bg-[color:var(--terminal-toolbar-btn-hover)]"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg) 86%, transparent)',
              borderColor: 'var(--terminal-ui-border)',
              color: 'var(--terminal-ui-fg)',
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={onAddSelectionToAI}
            aria-label={t('terminal.selection.addToAI')}
          >
            <Sparkles size={12} />
            <span>{t('terminal.selection.addToAI')}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('terminal.selection.addToAIDesc')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export const TerminalSelectionAIOverlay = memo(TerminalSelectionAIOverlayInner);
TerminalSelectionAIOverlay.displayName = 'TerminalSelectionAIOverlay';
