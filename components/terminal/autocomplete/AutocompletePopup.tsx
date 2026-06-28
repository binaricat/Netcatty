/**
 * Popup autocomplete menu for terminal.
 * Renders a floating list of completion suggestions near the terminal cursor.
 * Shows a detail tooltip for the selected/hovered item with full description.
 * Colors are derived from the active terminal theme for visual consistency.
 */

import React, { useEffect, useLayoutEffect, useRef, useState, memo } from "react";
import { Folder, File, Link } from "lucide-react";
import type { CompletionSuggestion, SuggestionSource } from "./completionEngine";
import {
  clampAutocompletePopupGeometry,
  computeAutocompletePopupPlacement,
  resolveAutocompleteClampViewport,
} from "./terminalAutocompleteLayout";

export interface AutocompleteThemeColors {
  background: string;
  foreground: string;
  selection: string;
  cursor: string;
}

export interface SubDirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export interface SubDirPanel {
  entries: SubDirEntry[];
  selectedIndex: number;
  dirPath: string;
}

interface AutocompletePopupProps {
  suggestions: CompletionSuggestion[];
  selectedIndex: number;
  /** Cursor anchor in viewport coordinates */
  anchorViewport: { left: number; top: number; bottom: number };
  visible: boolean;
  expandUpward?: boolean;
  themeColors?: AutocompleteThemeColors;
  onSelect: (suggestion: CompletionSuggestion) => void;
  maxHeight?: number;
  subDirPanels?: SubDirPanel[];
  subDirFocusLevel?: number;
  /** Reference to the terminal container for calculating fixed position */
  containerRef?: React.RefObject<HTMLDivElement | null>;
  /** Ask the autocomplete controller to recompute cursor-relative popup position */
  onRequestReposition?: () => void;
  /** Offset from top of container to terminal content area (toolbar + search bar) */
  searchBarOffset?: number;
  /** Called when user clicks outside the popup to dismiss it */
  onDismiss?: () => void;
}

const SOURCE_LABELS: Record<SuggestionSource, { label: string; fullLabel: string; fallbackColor: string }> = {
  history: { label: "h", fullLabel: "History", fallbackColor: "#FBBF24" },
  command: { label: "c", fullLabel: "Command", fallbackColor: "#34D399" },
  subcommand: { label: "s", fullLabel: "Subcommand", fallbackColor: "#60A5FA" },
  option: { label: "o", fullLabel: "Option", fallbackColor: "#A78BFA" },
  arg: { label: "a", fullLabel: "Argument", fallbackColor: "#F87171" },
  path: { label: "p", fullLabel: "Path", fallbackColor: "#38BDF8" },
  snippet: { label: "{}", fullLabel: "Snippet", fallbackColor: "#C084FC" },
};

/** Lucide icon components for file types in path suggestions */
const FILE_TYPE_CONFIG: Record<string, { Icon: React.FC<{ size?: number; color?: string }>; color: string }> = {
  directory: { Icon: Folder, color: "#38BDF8" },
  file: { Icon: File, color: "#94A3B8" },
  symlink: { Icon: Link, color: "#A78BFA" },
};

const FileTypeIcon: React.FC<{ fileType: string }> = ({ fileType }) => {
  const cfg = FILE_TYPE_CONFIG[fileType] ?? FILE_TYPE_CONFIG.file;
  return (
    <span
      style={{
        width: "18px",
        height: "18px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <cfg.Icon size={14} color={cfg.color} />
    </span>
  );
};

/** Chevron indicator for expandable directory items */
const DirExpandIndicator: React.FC<{ visible: boolean; color: string }> = ({ visible, color }) => (
  <span style={{ fontSize: "10px", color, opacity: visible ? 0.6 : 0, flexShrink: 0, marginLeft: "2px" }}>›</span>
);

/** Small key-cap badge shown on the selected row to hint the actionable key. */
const KeyCap: React.FC<{ label: string; color: string; bg: string }> = ({ label, color, bg }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      boxSizing: "border-box",
      height: "16px",
      minWidth: "16px",
      padding: "0 4px",
      fontSize: "11px",
      lineHeight: 1,
      borderRadius: "4px",
      border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      color: `color-mix(in srgb, ${color} 80%, ${bg})`,
      backgroundColor: `color-mix(in srgb, ${color} 12%, ${bg})`,
      flexShrink: 0,
      fontFamily:
        'ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif',
    }}
  >
    {label}
  </span>
);

const AutocompletePopup: React.FC<AutocompletePopupProps> = ({
  suggestions,
  selectedIndex,
  anchorViewport,
  visible,
  expandUpward = false,
  themeColors,
  onSelect,
  maxHeight = 240,
  subDirPanels = [],
  subDirFocusLevel = -1,
  containerRef,
  onRequestReposition,
  searchBarOffset: _searchBarOffset = 30,
  onDismiss,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState(-1);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (selectedRef.current && listRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "instant" as ScrollBehavior,
      });
    }
  }, [selectedIndex]);

  // Reset hover when suggestions change
  useEffect(() => {
    setHoveredIndex(-1);
  }, [suggestions]);

  useEffect(() => {
    if (!visible || !onRequestReposition) return;

    let frameId = 0;
    const requestReposition = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        onRequestReposition();
      });
    };

    const container = containerRef?.current;
    const observer = container ? new ResizeObserver(requestReposition) : null;
    observer?.observe(container);
    window.addEventListener("resize", requestReposition);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      observer?.disconnect();
      window.removeEventListener("resize", requestReposition);
    };
  }, [containerRef, onRequestReposition, visible]);

  useEffect(() => {
    if (!visible || !onRequestReposition || suggestions.length === 0) return;

    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      onRequestReposition();
      secondFrame = requestAnimationFrame(onRequestReposition);
    });

    return () => {
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [onRequestReposition, subDirPanels.length, suggestions, visible]);

  useLayoutEffect(() => {
    if (!visible || suggestions.length === 0) {
      setMeasuredSize((current) => (current === null ? current : null));
      return;
    }

    let frameId = 0;
    const measure = () => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setMeasuredSize((current) => {
        if (
          current &&
          Math.abs(current.width - rect.width) < 0.5 &&
          Math.abs(current.height - rect.height) < 0.5
        ) {
          return current;
        }
        return { width: rect.width, height: rect.height };
      });
    };

    measure();
    const wrapper = wrapperRef.current;
    const observer = wrapper ? new ResizeObserver(measure) : null;
    observer?.observe(wrapper);
    frameId = requestAnimationFrame(measure);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, [hoveredIndex, selectedIndex, subDirPanels, suggestions, visible]);

  // Dismiss popup when clicking outside
  useEffect(() => {
    if (!visible || !onDismiss) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [visible, onDismiss]);

  if (!visible || suggestions.length === 0) return null;

  const bg = themeColors?.background ?? "#1e1e2e";
  const fg = themeColors?.foreground ?? "#cdd6f4";
  // Accent comes from the active terminal theme's cursor/selection colors,
  // which already track the user's accent setting (custom accent rewrites them
  // in applyCustomAccentToTerminalTheme). Falling back to selection, then a
  // neutral fg-mix, keeps older/partial theme payloads working. This is what
  // makes the popup's highlight follow the accent instead of a hardcoded blue.
  const accent = themeColors?.cursor || themeColors?.selection || fg;
  const popupBg = `color-mix(in srgb, ${bg} 92%, ${fg} 8%)`;
  const popupBorder = `color-mix(in srgb, ${bg} 75%, ${fg} 25%)`;
  const selectedBg = `color-mix(in srgb, ${accent} 26%, ${bg} 74%)`;
  const selectedBorderAccent = `color-mix(in srgb, ${accent} 60%, ${bg} 40%)`;
  const hoverBg = `color-mix(in srgb, ${accent} 12%, ${bg} 88%)`;
  const textColor = fg;
  const dimTextColor = `color-mix(in srgb, ${fg} 50%, ${bg} 50%)`;

  // Determine which item to show the detail tooltip for
  const detailIndex = hoveredIndex >= 0 ? hoveredIndex : selectedIndex;
  const detailItem = detailIndex >= 0 ? suggestions[detailIndex] : null;
  const showDetail = detailItem?.description && detailItem.description.length > 0;

  // Whether ANY item in the current set can open the detail tooltip (non-path
  // row with a description). Placement reserves space from this set-level flag
  // rather than the hovered item, so moving the mouse between rows can't change
  // totalWidth/height and shift the popup out from under the pointer.
  const setMayShowDetailPanel = suggestions.some(
    (s) => s.source !== "path" && Boolean(s.description && s.description.length > 0),
  );

  const fixedLeft = anchorViewport.left;
  const fixedLineTop = anchorViewport.top;
  const fixedLineBottom = anchorViewport.bottom;

  const viewportPadding = 8;
  const anchorGap = 8;
  const clampViewport = resolveAutocompleteClampViewport(containerRef?.current ?? null);
  const estimatedPopupHeight = Math.min(maxHeight, suggestions.length * 28 + 8);
  // Reserve the detail height for the whole set (not the hovered row) so the
  // chosen direction/height stays stable while hovering.
  const estimatedDetailHeight = setMayShowDetailPanel ? 96 : 0;
  const desiredContentHeight = Math.max(estimatedPopupHeight, estimatedDetailHeight);

  // Total horizontal extent so the WHOLE assembly is clamped inside the
  // viewport — not just the main list. Mirrors the rendered maxWidths:
  // main list (400) + each cascading sub-dir panel (240) + the detail
  // tooltip (280), separated by the flex gap (4). Without this, expanding a
  // directory near the right edge pushed the sub-panels off-screen (#1202).
  const FLEX_GAP = 4;
  const MAIN_LIST_MAX_WIDTH = 400;
  const SUBDIR_PANEL_MAX_WIDTH = 240;
  const DETAIL_PANEL_MAX_WIDTH = 280;
  const totalWidth =
    MAIN_LIST_MAX_WIDTH +
    subDirPanels.length * (FLEX_GAP + SUBDIR_PANEL_MAX_WIDTH) +
    (setMayShowDetailPanel ? FLEX_GAP + DETAIL_PANEL_MAX_WIDTH : 0);
  const clampWidth =
    MAIN_LIST_MAX_WIDTH +
    subDirPanels.length * (FLEX_GAP + SUBDIR_PANEL_MAX_WIDTH);

  const placement = computeAutocompletePopupPlacement({
    anchorTop: fixedLineTop,
    anchorBottom: fixedLineBottom,
    anchorLeft: fixedLeft,
    viewportWidth: clampViewport.width,
    viewportHeight: clampViewport.height,
    clampViewport,
    desiredHeight: desiredContentHeight,
    totalWidth,
    clampWidth,
    maxHeight,
    anchorGap,
    viewportPadding,
    expandUpwardHint: expandUpward,
  });
  const renderUpward = placement.renderUpward;
  const effectiveMaxHeight = placement.maxHeight;
  const anchoredTop = placement.top;
  const clampedLeft = placement.left;
  const finalGeometry = measuredSize
    ? clampAutocompletePopupGeometry({
        left: clampedLeft,
        top: anchoredTop,
        width: measuredSize.width,
        height: measuredSize.height,
        clampViewport,
        viewportPadding,
      })
    : { left: clampedLeft, top: anchoredTop };

  const sharedBoxStyle = {
    // border-box so each panel's maxWidth is its true outer width (padding +
    // border included). The horizontal clamp's totalWidth sums these maxWidths,
    // so this keeps the off-screen math exact even for the padded detail panel.
    boxSizing: "border-box" as const,
    backgroundColor: popupBg,
    border: `1px solid ${popupBorder}`,
    borderRadius: "6px",
    boxShadow: renderUpward
      ? "0 -2px 6px rgba(0, 0, 0, 0.15)"
      : "0 2px 6px rgba(0, 0, 0, 0.15)",
    fontFamily: "inherit",
    fontSize: "13px",
    color: textColor,
  };

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "fixed",
        left: `${finalGeometry.left}px`,
        top: `${finalGeometry.top}px`,
        zIndex: 10000,
        display: "flex",
        alignItems: renderUpward ? "flex-end" : "flex-start",
        gap: "4px",
        pointerEvents: "auto", // Re-enable on popup itself (parent is pointer-events-none)
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Main suggestion list */}
      <div
        ref={listRef}
        className="xterm-autocomplete-popup"
        style={{
          ...sharedBoxStyle,
          maxHeight: `${effectiveMaxHeight}px`,
          minWidth: "180px",
          maxWidth: "400px",
          overflowY: "auto",
          overflowX: "hidden",
          padding: "4px 0",
          userSelect: "none",
        }}
      >
        {suggestions.map((suggestion, index) => {
          const isSelected = index === selectedIndex;
          const isHovered = index === hoveredIndex;
          const sourceInfo = SOURCE_LABELS[suggestion.source];

          return (
            <div
              key={`${suggestion.text}-${index}`}
              ref={isSelected ? selectedRef : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "5px 10px",
                cursor: "pointer",
                backgroundColor: isSelected ? selectedBg : isHovered ? hoverBg : "transparent",
                // Accent rail on the active row so the highlight reads as the
                // theme accent. Inset shadow avoids shifting row layout.
                boxShadow: isSelected ? `inset 2px 0 0 0 ${selectedBorderAccent}` : undefined,
                gap: "8px",
                lineHeight: "1.4",
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(-1)}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(suggestion);
              }}
            >
              {/* Source / file type indicator */}
              {suggestion.source === "path" && suggestion.fileType ? (
                <FileTypeIcon fileType={suggestion.fileType} />
              ) : (
                <span
                  style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "3px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    fontWeight: 600,
                    color: sourceInfo.fallbackColor,
                    backgroundColor: `${sourceInfo.fallbackColor}15`,
                    flexShrink: 0,
                  }}
                >
                  {sourceInfo.label}
                </span>
              )}

              {/* Command text */}
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: textColor,
                  fontWeight: isSelected ? 500 : 400,
                }}
              >
                {suggestion.displayText}
              </span>

              {/* Inline description (truncated). Snippets show only their label
                  in the row — the full command lives in the detail preview. */}
              {suggestion.source !== "snippet" && suggestion.description && (
                <span
                  style={{
                    fontSize: "11px",
                    color: dimTextColor,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "160px",
                    flexShrink: 0,
                  }}
                >
                  {suggestion.description}
                </span>
              )}

              {/* Frequency badge for history */}
              {suggestion.frequency && suggestion.frequency > 1 && (
                <span
                  style={{
                    fontSize: "10px",
                    color: dimTextColor,
                    flexShrink: 0,
                  }}
                >
                  ×{suggestion.frequency}
                </span>
              )}

              {/* Expand indicator for directories */}
              {suggestion.source === "path" && suggestion.fileType === "directory" && (
                <DirExpandIndicator visible={isSelected || isHovered} color={dimTextColor} />
              )}

              {/* Key hint on the selected row: → expands directories, ↵ runs. */}
              {isSelected && (
                <span style={{ display: "flex", gap: "3px", marginLeft: "4px", flexShrink: 0 }}>
                  {suggestion.source === "path" && suggestion.fileType === "directory" && (
                    <KeyCap label="→" color={dimTextColor} bg={popupBg} />
                  )}
                  <KeyCap label="⏎" color={dimTextColor} bg={popupBg} />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Cascading sub-directory panels */}
      {subDirPanels.map((panel, level) => (
        <div
          key={panel.dirPath}
          style={{
            ...sharedBoxStyle,
            maxHeight: `${effectiveMaxHeight}px`,
            minWidth: "150px",
            maxWidth: "240px",
            overflowY: "auto",
            overflowX: "hidden",
            padding: "4px 0",
            userSelect: "none",
            alignSelf: "flex-start",
          }}
        >
          {panel.entries.map((entry, idx) => {
            const isFocused = level === subDirFocusLevel;
            const isSubSelected = isFocused && idx === panel.selectedIndex;
            return (
              <div
                key={entry.name}
                ref={isSubSelected ? (el) => { el?.scrollIntoView({ block: "nearest" }); } : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "4px 10px",
                  cursor: "pointer",
                  backgroundColor: isSubSelected ? selectedBg
                    : (idx === panel.selectedIndex && level < subDirFocusLevel) ? hoverBg
                    : "transparent",
                  boxShadow: isSubSelected ? `inset 2px 0 0 0 ${selectedBorderAccent}` : undefined,
                  gap: "8px",
                  lineHeight: "1.4",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <FileTypeIcon fileType={entry.type} />
                <span style={{
                  flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", color: textColor,
                }}>
                  {entry.name}{entry.type === "directory" ? "/" : ""}
                </span>
                {entry.type === "directory" && (
                  <DirExpandIndicator visible={isSubSelected || (idx === panel.selectedIndex && level < subDirFocusLevel)} color={dimTextColor} />
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Detail tooltip panel — shows full description for non-path items */}
      {showDetail && detailItem && detailItem.source !== "path" && (
        <div
          style={{
            ...sharedBoxStyle,
            padding: "10px 12px",
            maxWidth: "280px",
            minWidth: "160px",
            // Bound the tooltip too: a long multi-line snippet description must
            // scroll, not push the panel past the viewport edge (#1202).
            maxHeight: `${effectiveMaxHeight}px`,
            overflowY: "auto",
            alignSelf: renderUpward ? "flex-end" : "flex-start",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
            <span style={{ fontWeight: 600, fontSize: "13px" }}>{detailItem.displayText}</span>
            <span style={{
              fontSize: "10px",
              color: SOURCE_LABELS[detailItem.source].fallbackColor,
              padding: "1px 5px",
              borderRadius: "3px",
              backgroundColor: `${SOURCE_LABELS[detailItem.source].fallbackColor}15`,
            }}>
              {SOURCE_LABELS[detailItem.source].fullLabel}
            </span>
          </div>
          <div style={{ fontSize: "12px", color: dimTextColor, lineHeight: "1.5", wordBreak: "break-word" }}>
            {detailItem.source === "snippet" ? (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "var(--terminal-font, monospace)",
                  fontSize: "11px",
                  lineHeight: 1.4,
                }}
              >
                {detailItem.description}
              </pre>
            ) : (
              detailItem.description
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(AutocompletePopup);
