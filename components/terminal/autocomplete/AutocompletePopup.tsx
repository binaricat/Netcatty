/**
 * Popup autocomplete menu for terminal.
 * Renders a floating list of completion suggestions near the terminal cursor.
 * Supports keyboard navigation (↑/↓/Tab/Enter/Esc).
 */

import React, { useEffect, useRef, memo } from "react";
import type { CompletionSuggestion, SuggestionSource } from "./completionEngine";

interface AutocompletePopupProps {
  suggestions: CompletionSuggestion[];
  selectedIndex: number;
  position: { x: number; y: number };
  visible: boolean;
  onSelect: (suggestion: CompletionSuggestion) => void;
  onClose?: () => void;
  maxHeight?: number;
}

const SOURCE_LABELS: Record<SuggestionSource, { label: string; color: string }> = {
  history: { label: "h", color: "#FBBF24" },
  command: { label: "c", color: "#34D399" },
  subcommand: { label: "s", color: "#60A5FA" },
  option: { label: "o", color: "#A78BFA" },
  arg: { label: "a", color: "#F87171" },
};

const AutocompletePopup: React.FC<AutocompletePopupProps> = ({
  suggestions,
  selectedIndex,
  position,
  visible,
  onSelect,
  onClose: _onClose,
  maxHeight = 200,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current && listRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  if (!visible || suggestions.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="xterm-autocomplete-popup"
      style={{
        position: "absolute",
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 1000,
        maxHeight: `${maxHeight}px`,
        minWidth: "200px",
        maxWidth: "500px",
        overflowY: "auto",
        overflowX: "hidden",
        backgroundColor: "var(--autocomplete-bg, #1e1e2e)",
        border: "1px solid var(--autocomplete-border, #45475a)",
        borderRadius: "6px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "13px",
        padding: "4px 0",
        userSelect: "none",
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
              backgroundColor: isSelected
                ? "var(--autocomplete-selected, #313244)"
                : "transparent",
              gap: "8px",
              lineHeight: "1.4",
            }}
            onMouseEnter={(e) => {
              // Visual hover effect (selection follows keyboard, not mouse)
              (e.currentTarget as HTMLDivElement).style.backgroundColor =
                isSelected
                  ? "var(--autocomplete-selected, #313244)"
                  : "var(--autocomplete-hover, #262637)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor =
                isSelected
                  ? "var(--autocomplete-selected, #313244)"
                  : "transparent";
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
                color: isSelected
                  ? "var(--autocomplete-text-selected, #cdd6f4)"
                  : "var(--autocomplete-text, #bac2de)",
              }}
            >
              {suggestion.displayText}
            </span>

            {/* Description */}
            {suggestion.description && (
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--autocomplete-desc, #6c7086)",
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
                  color: "var(--autocomplete-freq, #6c7086)",
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
                color: sourceInfo.color,
                backgroundColor: `${sourceInfo.color}20`,
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
