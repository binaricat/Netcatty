import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  getTerminalLineTimestampViewportStateKey,
  getVisibleTerminalLineTimestampRows,
  onTerminalLineTimestampsChange,
} from "./runtime/terminalLineTimestamps";
import type { TerminalTimestampGutterRow } from "./runtime/terminalLineTimestamps";
import { getTerminalOutputPressure } from "./runtime/terminalOutputPressure";

export const TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH = 56;
export const TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING = 16;
export const TERMINAL_TIMESTAMP_SAMPLE_LABEL = "88:88:88";
/** Cap gutter paint rate while large-output pressure is active (rAF still coalesces). */
export const TERMINAL_TIMESTAMP_GUTTER_FLOOD_MIN_INTERVAL_MS = 100;
const GUTTER_ROW_CLASS =
  "absolute left-0 right-0 px-2 text-right tabular-nums whitespace-nowrap";

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

const applyGutterRowStyles = (
  item: HTMLElement,
  {
    row,
    label,
    screenTop,
    cellHeight,
    color,
    fontFamily,
    fontSize,
    fontWeight,
  }: {
    row: number;
    label: string;
    screenTop: number;
    cellHeight: number;
    color: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: string | number;
  },
) => {
  if (item.textContent !== label) {
    item.textContent = label;
  }
  item.style.top = `${screenTop + row * cellHeight}px`;
  item.style.height = `${cellHeight}px`;
  item.style.lineHeight = `${cellHeight}px`;
  item.style.color = color;
  item.style.fontFamily = fontFamily;
  item.style.fontSize = `${fontSize}px`;
  item.style.fontWeight = String(fontWeight);
  item.style.fontVariantNumeric = "tabular-nums";
  item.style.display = "";
};

/**
 * Reuse a fixed pool of row divs instead of clear+create on every paint.
 * Returns the number of visible nodes kept after the update.
 */
export const syncTerminalTimestampGutterRows = (
  gutter: HTMLElement,
  rows: readonly TerminalTimestampGutterRow[],
  layout: {
    screenTop: number;
    cellHeight: number;
    color: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: string | number;
  },
): number => {
  const existing = gutter.children;
  let index = 0;
  for (; index < rows.length; index += 1) {
    const { row, label } = rows[index];
    let item = existing[index] as HTMLElement | undefined;
    if (!item) {
      item = document.createElement("div");
      item.className = GUTTER_ROW_CLASS;
      gutter.appendChild(item);
    }
    applyGutterRowStyles(item, {
      row,
      label,
      screenTop: layout.screenTop,
      cellHeight: layout.cellHeight,
      color: layout.color,
      fontFamily: layout.fontFamily,
      fontSize: layout.fontSize,
      fontWeight: layout.fontWeight,
    });
  }
  // Hide surplus pooled nodes (keep them for the next paint).
  for (; index < existing.length; index += 1) {
    (existing[index] as HTMLElement).style.display = "none";
  }
  return rows.length;
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

export const resolveTerminalTimestampGutterRenderSignature = ({
  screenTop,
  cellHeight,
  color,
  fontFamily,
  fontSize,
  fontWeight,
  rows,
}: {
  screenTop: number;
  cellHeight: number;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  rows: readonly TerminalTimestampGutterRow[];
}): string => {
  let signature = `${screenTop}|${cellHeight}|${color}|${fontFamily}|${fontSize}|${fontWeight}`;
  for (const { row, label } of rows) {
    signature += `|${row}:${label}`;
  }
  return signature;
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
    let floodThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    let disposables: DisposableLike[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let lastRenderSignature = "";
    let lastViewportStateKey = "";
    let layoutDirty = true;
    let lastFloodRenderAt = 0;

    const clearGutter = () => {
      lastRenderSignature = "";
      lastViewportStateKey = "";
      layoutDirty = true;
      clearElement(gutter);
    };

    const render = () => {
      rafId = null;
      // Always advance the flood clock when a render attempt runs — even if the
      // signature is unchanged. Otherwise same-second labels during sustained
      // output leave lastFloodRenderAt stale and the throttle stops limiting work.
      lastFloodRenderAt = performance.now();
      const term = termRef.current;
      const container = containerRef.current;
      if (!enabled || !term || !container) {
        clearGutter();
        return;
      }

      const viewportStateKey = getTerminalLineTimestampViewportStateKey(term);
      if (!layoutDirty && lastRenderSignature !== "" && viewportStateKey === lastViewportStateKey) {
        return;
      }
      layoutDirty = false;
      lastViewportStateKey = viewportStateKey;

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
      const signature = resolveTerminalTimestampGutterRenderSignature({
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

      syncTerminalTimestampGutterRows(gutter, visibleRows, {
        screenTop,
        cellHeight,
        color,
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSize,
        fontWeight: typography.fontWeight,
      });
    };

    const queueRafRender = () => {
      if (disposed || rafId !== null) return;
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(render);
      } else {
        render();
      }
    };

    /**
     * immediate: user scroll/resize — paint ASAP.
     * normal: output/render pressure — throttle while flood pressure is active.
     */
    const scheduleRender = (priority: "immediate" | "normal" = "normal") => {
      if (disposed) return;
      if (priority === "normal") {
        const term = termRef.current;
        if (term) {
          const pressure = getTerminalOutputPressure(term);
          if (pressure.largeOutput || pressure.longLine) {
            const now = performance.now();
            const elapsed = now - lastFloodRenderAt;
            if (elapsed < TERMINAL_TIMESTAMP_GUTTER_FLOOD_MIN_INTERVAL_MS) {
              if (floodThrottleTimer === null) {
                floodThrottleTimer = setTimeout(() => {
                  floodThrottleTimer = null;
                  queueRafRender();
                }, TERMINAL_TIMESTAMP_GUTTER_FLOOD_MIN_INTERVAL_MS - elapsed);
              }
              return;
            }
          }
        }
      } else if (floodThrottleTimer !== null) {
        clearTimeout(floodThrottleTimer);
        floodThrottleTimer = null;
      }
      queueRafRender();
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
        // xterm fires onScroll for output-driven scrolling too (not only user
        // wheel/trackpad). Throttle only while large-output pressure is active
        // (time-bounded). Do not use longLine here — it sticks until the next
        // data chunk and would lag genuine user scrolling after output stops.
        term.onScroll?.(() => {
          const pressure = getTerminalOutputPressure(term);
          scheduleRender(pressure.largeOutput ? "normal" : "immediate");
        }),
        term.onRender?.(() => scheduleRender("normal")),
        term.onResize?.(() => {
          layoutDirty = true;
          scheduleRender("immediate");
        }),
      ].filter(Boolean) as DisposableLike[];
      disposables.push({
        dispose: onTerminalLineTimestampsChange(term, () => scheduleRender("normal")),
      });

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          layoutDirty = true;
          scheduleRender("immediate");
        });
        resizeObserver.observe(container);
        resizeObserver.observe(getTerminalScreen(container));
      }

      layoutDirty = true;
      scheduleRender("immediate");
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
      if (floodThrottleTimer !== null) {
        clearTimeout(floodThrottleTimer);
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
