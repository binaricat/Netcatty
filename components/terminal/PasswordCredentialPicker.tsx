/**
 * Floating credential list for sudo/su password-prompt assist (picker mode).
 * Positioned next to the terminal cursor using the same anchor/placement
 * helpers as AutocompletePopup. Secrets are never shown.
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { KeyRound } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { PasswordPromptPickerItem } from "./runtime/terminalSudoAutofill";
import {
  clampAutocompletePopupGeometry,
  computeAutocompletePopupPlacement,
  resolveAutocompleteAnchorInViewport,
  resolveAutocompleteClampViewport,
} from "./autocomplete/terminalAutocompleteLayout";

export type PasswordCredentialPickerProps = {
  items: PasswordPromptPickerItem[];
  selectedIndex: number;
  visible: boolean;
  onSelect: (id: string) => void;
  title: string;
  emptyText: string;
  themeColors?: {
    background?: string;
    foreground?: string;
    selection?: string;
    cursor?: string;
  };
  termRef?: React.RefObject<XTerm | null>;
  containerRef?: React.RefObject<HTMLDivElement | null>;
};

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const LIST_PADDING = 8;
const MAX_LIST_HEIGHT = 192;
const POPUP_MIN_WIDTH = 240;
const POPUP_MAX_WIDTH = 360;

const PasswordCredentialPicker: React.FC<PasswordCredentialPickerProps> = ({
  items,
  selectedIndex,
  visible,
  onSelect,
  title,
  emptyText,
  themeColors,
  termRef,
  containerRef,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const [anchorTick, setAnchorTick] = useState(0);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);

  const requestReposition = useCallback(() => {
    setAnchorTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!visible) return;
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [visible, selectedIndex]);

  // Recalculate when the terminal/container resizes or the window moves.
  useEffect(() => {
    if (!visible) return;

    let frameId = 0;
    const schedule = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        requestReposition();
      });
    };

    const container = containerRef?.current;
    const observer = container ? new ResizeObserver(schedule) : null;
    if (container) observer?.observe(container);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    // Two rAFs so xterm has finished layout after the password line paints.
    let first = 0;
    let second = 0;
    first = requestAnimationFrame(() => {
      requestReposition();
      second = requestAnimationFrame(requestReposition);
    });

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      if (first) cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [visible, containerRef, requestReposition, items.length]);

  const itemCount = Math.max(1, items.length);
  const estimatedListHeight = Math.min(MAX_LIST_HEIGHT, itemCount * ROW_HEIGHT + LIST_PADDING);
  const estimatedPopupHeight = estimatedListHeight + HEADER_HEIGHT;

  const placement = useMemo(() => {
    // anchorTick forces recompute when the cursor/container moves.
    void anchorTick;
    const term = termRef?.current ?? null;
    const container = containerRef?.current ?? null;
    const clampViewport = resolveAutocompleteClampViewport(container);
    const empty = {
      left: clampViewport.left + 8,
      top: clampViewport.top + 8,
      maxHeight: MAX_LIST_HEIGHT,
      renderUpward: true,
    };
    if (!term || !visible) return empty;

    const anchor = resolveAutocompleteAnchorInViewport(term, container, itemCount);
    const result = computeAutocompletePopupPlacement({
      anchorTop: anchor.anchorTop,
      anchorBottom: anchor.anchorBottom,
      anchorLeft: anchor.anchorLeft,
      viewportWidth: clampViewport.width,
      viewportHeight: clampViewport.height,
      clampViewport,
      desiredHeight: estimatedPopupHeight,
      totalWidth: POPUP_MAX_WIDTH,
      clampWidth: POPUP_MAX_WIDTH,
      maxHeight: estimatedPopupHeight,
      anchorGap: 8,
      viewportPadding: 8,
      // Password prompts sit on the input line; prefer opening upward so the
      // list does not cover what the user is about to type.
      expandUpwardHint: true,
    });
    return {
      left: result.left,
      top: result.top,
      maxHeight: Math.max(ROW_HEIGHT + LIST_PADDING, result.maxHeight - HEADER_HEIGHT),
      renderUpward: result.renderUpward,
    };
  }, [
    anchorTick,
    termRef,
    containerRef,
    visible,
    itemCount,
    estimatedPopupHeight,
  ]);

  useLayoutEffect(() => {
    if (!visible) {
      setMeasuredSize((current) => (current === null ? current : null));
      return;
    }
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    setMeasuredSize((current) => {
      if (
        current
        && Math.abs(current.width - rect.width) < 0.5
        && Math.abs(current.height - rect.height) < 0.5
      ) {
        return current;
      }
      return { width: rect.width, height: rect.height };
    });
  }, [visible, placement.left, placement.top, items.length, selectedIndex]);

  if (!visible) return null;

  const clampViewport = resolveAutocompleteClampViewport(containerRef?.current ?? null);
  const finalGeometry = measuredSize
    ? clampAutocompletePopupGeometry({
        left: placement.left,
        top: placement.top,
        width: measuredSize.width,
        height: measuredSize.height,
        clampViewport,
        viewportPadding: 8,
      })
    : { left: placement.left, top: placement.top };

  const background = themeColors?.background ?? "hsl(var(--popover))";
  const foreground = themeColors?.foreground ?? "hsl(var(--popover-foreground))";
  const selection = themeColors?.selection ?? "hsl(var(--accent))";
  const border = themeColors?.cursor
    ? `${themeColors.cursor}55`
    : "hsl(var(--border))";

  const node = (
    <div
      ref={wrapperRef}
      role="listbox"
      aria-label={title}
      data-testid="password-credential-picker"
      style={{
        position: "fixed",
        left: `${finalGeometry.left}px`,
        top: `${finalGeometry.top}px`,
        zIndex: 10000,
        minWidth: POPUP_MIN_WIDTH,
        maxWidth: POPUP_MAX_WIDTH,
        overflow: "hidden",
        borderRadius: 6,
        border: `1px solid ${border}`,
        background,
        color: foreground,
        boxShadow: placement.renderUpward
          ? "0 -2px 6px rgba(0, 0, 0, 0.15)"
          : "0 2px 6px rgba(0, 0, 0, 0.15)",
        fontSize: 13,
        pointerEvents: "auto",
      }}
      onMouseDown={(e) => {
        // Keep terminal focus; prevent selection loss before click select.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide opacity-70"
        style={{ borderColor: border, height: HEADER_HEIGHT, boxSizing: "border-box" }}
      >
        <KeyRound size={12} />
        <span>{title}</span>
      </div>
      <div
        ref={listRef}
        style={{
          maxHeight: `${placement.maxHeight}px`,
          overflowY: "auto",
          padding: "4px 0",
        }}
      >
        {items.length === 0 ? (
          <div className="px-3 py-2 text-xs opacity-70">{emptyText}</div>
        ) : (
          items.map((item, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={item.id}
                ref={selected ? selectedRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
                style={{
                  background: selected ? selection : undefined,
                  height: ROW_HEIGHT,
                  boxSizing: "border-box",
                }}
                onClick={() => onSelect(item.id)}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                {item.username ? (
                  <span className="shrink-0 font-mono text-xs opacity-70">{item.username}</span>
                ) : null}
                <span className="shrink-0 font-mono text-xs opacity-50">••••••••</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  // Portal to body so overflow:hidden on terminal chrome cannot clip the list
  // (same pattern as AutocompletePopup).
  return ReactDOM.createPortal(node, document.body);
};

export default memo(PasswordCredentialPicker);
