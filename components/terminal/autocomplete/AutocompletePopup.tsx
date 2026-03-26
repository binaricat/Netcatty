/**
 * Popup autocomplete menu for terminal.
 * Renders a floating list of completion suggestions near the terminal cursor.
 * Colors are derived from the active terminal theme for visual consistency.
 */

import React, { useEffect, useRef, memo } from "react";
import type { CompletionSuggestion, SuggestionSource } from "./completionEngine";

export interface AutocompleteThemeColors {
  /** Terminal background color */
  background: string;
  /** Terminal foreground color */
  foreground: string;
  /** Terminal selection/highlight color */
  selection: string;
  /** Cursor color (used for accents) */
  cursor: string;
}

interface AutocompletePopupProps {
  suggestions: CompletionSuggestion[];
  selectedIndex: number;
  position: { x: number; y: number };
  visible: boolean;
  /** When true, the popup grows upward — bottom edge anchored at position.y */
  expandUpward?: boolean;
  /** Terminal theme colors for consistent styling */
  themeColors?: AutocompleteThemeColors;
  onSelect: (suggestion: CompletionSuggestion) => void;
  maxHeight?: number;
}

const SOURCE_LABELS: Record<SuggestionSource, { label: string; fallbackColor: string }> = {
  history: { label: "h", fallbackColor: "#FBBF24" },
  command: { label: "c", fallbackColor: "#34D399" },
  subcommand: { label: "s", fallbackColor: "#60A5FA" },
  option: { label: "o", fallbackColor: "#A78BFA" },
  arg: { label: "a", fallbackColor: "#F87171" },
};

const AutocompletePopup: React.FC<AutocompletePopupProps> = ({
  suggestions,
  selectedIndex,
  position,
  visible,
  expandUpward = false,
  themeColors,
  onSelect,
  maxHeight = 200,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current && listRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "instant" as ScrollBehavior,
      });
    }
  }, [selectedIndex]);

  if (!visible || suggestions.length === 0) return null;

  // Derive colors from terminal theme
  const bg = themeColors?.background ?? "#1e1e2e";
  const fg = themeColors?.foreground ?? "#cdd6f4";
  // Computed theme-aware colors
  const popupBg = `color-mix(in srgb, ${bg} 92%, ${fg} 8%)`;
  const popupBorder = `color-mix(in srgb, ${bg} 75%, ${fg} 25%)`;
  const selectedBg = `color-mix(in srgb, ${bg} 78%, ${fg} 22%)`;
  const hoverBg = `color-mix(in srgb, ${bg} 85%, ${fg} 15%)`;
  const textColor = fg;
  const dimTextColor = `color-mix(in srgb, ${fg} 50%, ${bg} 50%)`;

  return (
    <div
      ref={listRef}
      className="xterm-autocomplete-popup"
      style={{
        position: "absolute",
        left: `${position.x}px`,
        ...(expandUpward
          ? { bottom: `calc(100% - ${position.y}px)` }
          : { top: `${position.y}px` }),
        zIndex: 1000,
        maxHeight: `${maxHeight}px`,
        minWidth: "200px",
        maxWidth: "500px",
        overflowY: "auto",
        overflowX: "hidden",
        backgroundColor: popupBg,
        border: `1px solid ${popupBorder}`,
        borderRadius: "6px",
        boxShadow: expandUpward
          ? "0 -4px 12px rgba(0, 0, 0, 0.4)"
          : "0 4px 12px rgba(0, 0, 0, 0.4)",
        fontFamily: "inherit",
        fontSize: "13px",
        padding: "4px 0",
        userSelect: "none",
        color: textColor,
      }}
      onMouseDown={(e) => {
        // Prevent terminal from losing focus
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {suggestions.map((suggestion, index) => {
        const isSelected = index === selectedIndex;
        const sourceInfo = SOURCE_LABELS[suggestion.source];

        return (
          <div
            key={`${suggestion.text}-${index}`}
            ref={isSelected ? selectedRef : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "4px 8px",
              cursor: "pointer",
              backgroundColor: isSelected ? selectedBg : "transparent",
              gap: "8px",
              lineHeight: "1.4",
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                (e.currentTarget as HTMLDivElement).style.backgroundColor = hoverBg;
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor =
                isSelected ? selectedBg : "transparent";
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(suggestion);
            }}
          >
            {/* Command text */}
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: textColor,
              }}
            >
              {suggestion.displayText}
            </span>

            {/* Description */}
            {suggestion.description && (
              <span
                style={{
                  fontSize: "11px",
                  color: dimTextColor,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "150px",
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

            {/* Source indicator */}
            <span
              style={{
                width: "16px",
                height: "16px",
                borderRadius: "3px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "10px",
                fontWeight: 600,
                color: sourceInfo.fallbackColor,
                backgroundColor: `${sourceInfo.fallbackColor}20`,
                flexShrink: 0,
              }}
            >
              {sourceInfo.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default memo(AutocompletePopup);
