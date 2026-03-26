/**
 * Popup autocomplete menu for terminal.
 * Renders a floating list of completion suggestions near the terminal cursor.
 * Shows a detail tooltip for the selected/hovered item with full description.
 * Colors are derived from the active terminal theme for visual consistency.
 */

import React, { useEffect, useRef, useState, memo } from "react";
import type { CompletionSuggestion, SuggestionSource } from "./completionEngine";

export interface AutocompleteThemeColors {
  background: string;
  foreground: string;
  selection: string;
  cursor: string;
}

interface AutocompletePopupProps {
  suggestions: CompletionSuggestion[];
  selectedIndex: number;
  position: { x: number; y: number };
  visible: boolean;
  expandUpward?: boolean;
  themeColors?: AutocompleteThemeColors;
  onSelect: (suggestion: CompletionSuggestion) => void;
  maxHeight?: number;
}

const SOURCE_LABELS: Record<SuggestionSource, { label: string; fullLabel: string; fallbackColor: string }> = {
  history: { label: "h", fullLabel: "History", fallbackColor: "#FBBF24" },
  command: { label: "c", fullLabel: "Command", fallbackColor: "#34D399" },
  subcommand: { label: "s", fullLabel: "Subcommand", fallbackColor: "#60A5FA" },
  option: { label: "o", fullLabel: "Option", fallbackColor: "#A78BFA" },
  arg: { label: "a", fullLabel: "Argument", fallbackColor: "#F87171" },
};

const AutocompletePopup: React.FC<AutocompletePopupProps> = ({
  suggestions,
  selectedIndex,
  position,
  visible,
  expandUpward = false,
  themeColors,
  onSelect,
  maxHeight = 240,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState(-1);

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

  if (!visible || suggestions.length === 0) return null;

  const bg = themeColors?.background ?? "#1e1e2e";
  const fg = themeColors?.foreground ?? "#cdd6f4";
  const popupBg = `color-mix(in srgb, ${bg} 92%, ${fg} 8%)`;
  const popupBorder = `color-mix(in srgb, ${bg} 75%, ${fg} 25%)`;
  const selectedBg = `color-mix(in srgb, ${bg} 78%, ${fg} 22%)`;
  const hoverBg = `color-mix(in srgb, ${bg} 85%, ${fg} 15%)`;
  const textColor = fg;
  const dimTextColor = `color-mix(in srgb, ${fg} 50%, ${bg} 50%)`;

  // Determine which item to show the detail tooltip for
  const detailIndex = hoveredIndex >= 0 ? hoveredIndex : selectedIndex;
  const detailItem = detailIndex >= 0 ? suggestions[detailIndex] : null;
  const showDetail = detailItem?.description && detailItem.description.length > 0;

  const sharedBoxStyle = {
    backgroundColor: popupBg,
    border: `1px solid ${popupBorder}`,
    borderRadius: "6px",
    boxShadow: expandUpward
      ? "0 -4px 12px rgba(0, 0, 0, 0.4)"
      : "0 4px 12px rgba(0, 0, 0, 0.4)",
    fontFamily: "inherit",
    fontSize: "13px",
    color: textColor,
  };

  return (
    <div
      style={{
        position: "absolute",
        left: `${position.x}px`,
        ...(expandUpward
          ? { bottom: `calc(100% - ${position.y}px)` }
          : { top: `${position.y}px` }),
        zIndex: 1000,
        display: "flex",
        alignItems: expandUpward ? "flex-end" : "flex-start",
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
          maxHeight: `${maxHeight}px`,
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
              {/* Source indicator */}
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

              {/* Inline description (truncated) */}
              {suggestion.description && (
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
            </div>
          );
        })}
      </div>

      {/* Detail tooltip panel — shows full description for selected/hovered item */}
      {showDetail && detailItem && (
        <div
          style={{
            ...sharedBoxStyle,
            padding: "10px 12px",
            maxWidth: "280px",
            minWidth: "160px",
            alignSelf: expandUpward ? "flex-end" : "flex-start",
          }}
        >
          {/* Header: command name + source type */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginBottom: "6px",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: "13px" }}>
              {detailItem.displayText}
            </span>
            <span
              style={{
                fontSize: "10px",
                color: SOURCE_LABELS[detailItem.source].fallbackColor,
                padding: "1px 5px",
                borderRadius: "3px",
                backgroundColor: `${SOURCE_LABELS[detailItem.source].fallbackColor}15`,
              }}
            >
              {SOURCE_LABELS[detailItem.source].fullLabel}
            </span>
          </div>
          {/* Full description */}
          <div
            style={{
              fontSize: "12px",
              color: dimTextColor,
              lineHeight: "1.5",
              wordBreak: "break-word",
            }}
          >
            {detailItem.description}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(AutocompletePopup);
