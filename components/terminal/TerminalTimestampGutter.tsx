import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  getVisibleTerminalLineTimestampRows,
  onTerminalLineTimestampsChange,
} from "./runtime/terminalLineTimestamps";

export const TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH = 56;
export const TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING = 16;
export const TERMINAL_TIMESTAMP_SAMPLE_LABEL = "88:88:88";

type TerminalTimestampGutterProps = {
  termRef: RefObject<XTerm | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  top: string;
  left?: number;
  bottom?: number;
  sessionId: string;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  width: number;
  onWidthChange?: (width: number) => void;
};

type DisposableLike = {
  dispose: () => void;
};

type TerminalTimestampTypography = {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
};

const getTerminalScreen = (container: HTMLElement): HTMLElement => (
  container.querySelector<HTMLElement>(".xterm-screen") ?? container
);

const clearElement = (element: HTMLElement) => {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
};

export const resolveTerminalTimestampGutterColor = (
  colors: Partial<Record<"brightCyan" | "brightYellow" | "brightMagenta" | "foreground", string>>,
): string => (
  colors.brightCyan
  || colors.brightYellow
  || colors.brightMagenta
  || colors.foreground
  || "currentColor"
);

const normalizeTerminalTimestampFontSize = (fontSize?: number): number => (
  Number.isFinite(fontSize) && fontSize && fontSize > 0 ? fontSize : 12
);

export const getTerminalTimestampTypography = ({
  fontFamily,
  fontSize,
  fontWeight,
}: TerminalTimestampTypography) => ({
  fontFamily: fontFamily || "monospace",
  fontSize: normalizeTerminalTimestampFontSize(fontSize),
  fontWeight: fontWeight ?? 400,
});

const estimateTerminalTimestampTextWidth = (
  fontSize: number,
  label = TERMINAL_TIMESTAMP_SAMPLE_LABEL,
): number => (
  normalizeTerminalTimestampFontSize(fontSize) * label.length * 0.62
);

export const resolveTerminalTimestampGutterWidth = ({
  measuredTextWidth,
  fontSize,
  label = TERMINAL_TIMESTAMP_SAMPLE_LABEL,
}: {
  measuredTextWidth?: number;
  fontSize?: number;
  label?: string;
}): number => {
  const textWidth =
    Number.isFinite(measuredTextWidth) && measuredTextWidth !== undefined && measuredTextWidth > 0
      ? measuredTextWidth
      : estimateTerminalTimestampTextWidth(normalizeTerminalTimestampFontSize(fontSize), label);
  return Math.ceil(Math.max(
    TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH,
    textWidth + TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING,
  ));
};

export function TerminalTimestampGutter({
  termRef,
  containerRef,
  enabled,
  top,
  left = 0,
  bottom = 0,
  sessionId,
  color,
  fontFamily,
  fontSize,
  fontWeight,
  width,
  onWidthChange,
}: TerminalTimestampGutterProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const typography = getTerminalTimestampTypography({ fontFamily, fontSize, fontWeight });

  useLayoutEffect(() => {
    if (!enabled || !onWidthChange) return;
    const gutter = gutterRef.current;
    if (!gutter) return;

    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const probe = document.createElement("span");
      probe.textContent = TERMINAL_TIMESTAMP_SAMPLE_LABEL;
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.style.whiteSpace = "nowrap";
      probe.style.fontFamily = typography.fontFamily;
      probe.style.fontSize = `${typography.fontSize}px`;
      probe.style.fontWeight = String(typography.fontWeight);
      probe.style.fontVariantNumeric = "tabular-nums";
      gutter.appendChild(probe);
      const measuredTextWidth = probe.getBoundingClientRect().width;
      probe.remove();
      onWidthChange(resolveTerminalTimestampGutterWidth({
        measuredTextWidth,
        fontSize: typography.fontSize,
      }));
    };

    measure();
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    void fonts?.ready?.then(measure);

    return () => {
      disposed = true;
    };
  }, [enabled, onWidthChange, sessionId, typography.fontFamily, typography.fontSize, typography.fontWeight]);

  useEffect(() => {
    const gutter = gutterRef.current;
    if (!gutter) return;

    let disposed = false;
    let rafId: number | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposables: DisposableLike[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let lastRenderSignature = "";

    const clearGutter = () => {
      lastRenderSignature = "";
      clearElement(gutter);
    };

    const render = () => {
      rafId = null;
      const term = termRef.current;
      const container = containerRef.current;
      if (!enabled || !term || !container) {
        clearGutter();
        return;
      }

      const screen = getTerminalScreen(container);
      const rows = Math.max(1, term.rows || 1);
      const cellHeight = screen.clientHeight / rows;
      if (!Number.isFinite(cellHeight) || cellHeight <= 0) {
        clearGutter();
        return;
      }

      const screenRect = screen.getBoundingClientRect();
      const gutterRect = gutter.getBoundingClientRect();
      const screenTop = screenRect.top - gutterRect.top;
      const visibleRows = getVisibleTerminalLineTimestampRows(term);
      const signature = JSON.stringify({
        screenTop,
        cellHeight,
        color,
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSize,
        fontWeight: typography.fontWeight,
        rows: visibleRows,
      });
      if (signature === lastRenderSignature) return;
      lastRenderSignature = signature;

      const fragment = document.createDocumentFragment();

      for (const { row, label } of visibleRows) {
        const item = document.createElement("div");
        item.textContent = label;
        item.className = "absolute left-0 right-0 px-2 text-right tabular-nums whitespace-nowrap";
        item.style.top = `${screenTop + row * cellHeight}px`;
        item.style.height = `${cellHeight}px`;
        item.style.lineHeight = `${cellHeight}px`;
        item.style.color = color;
        item.style.fontFamily = typography.fontFamily;
        item.style.fontSize = `${typography.fontSize}px`;
        item.style.fontWeight = String(typography.fontWeight);
        item.style.fontVariantNumeric = "tabular-nums";
        fragment.appendChild(item);
      }

      clearElement(gutter);
      gutter.appendChild(fragment);
    };

    const scheduleRender = () => {
      if (disposed || rafId !== null) return;
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(render);
      } else {
        render();
      }
    };

    const attach = () => {
      if (disposed) return;
      const term = termRef.current;
      const container = containerRef.current;
      if (!enabled || !term || !container) {
        clearGutter();
        if (enabled) {
          retryTimer = setTimeout(attach, 50);
        }
        return;
      }

      disposables = [
        term.onScroll?.(scheduleRender),
        term.onRender?.(scheduleRender),
        term.onResize?.(scheduleRender),
      ].filter(Boolean) as DisposableLike[];
      disposables.push({ dispose: onTerminalLineTimestampsChange(term, scheduleRender) });

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleRender);
        resizeObserver.observe(container);
        resizeObserver.observe(getTerminalScreen(container));
      }

      scheduleRender();
    };

    attach();

    return () => {
      disposed = true;
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      for (const disposable of disposables) {
        disposable.dispose();
      }
      resizeObserver?.disconnect();
      clearElement(gutter);
    };
  }, [
    color,
    containerRef,
    enabled,
    bottom,
    left,
    sessionId,
    termRef,
    top,
    typography.fontFamily,
    typography.fontSize,
    typography.fontWeight,
  ]);

  if (!enabled) return null;

  return (
    <div
      ref={gutterRef}
      aria-hidden="true"
      className="pointer-events-none absolute z-[1] overflow-hidden select-none text-[color:var(--terminal-ui-fg)]"
      style={{
        top,
        bottom,
        left,
        width,
        backgroundColor: "var(--terminal-ui-bg)",
        boxShadow: "inset -0.5px 0 0 color-mix(in srgb, var(--terminal-ui-fg) 8%, transparent)",
      }}
      data-section="terminal-timestamp-gutter"
    />
  );
}
