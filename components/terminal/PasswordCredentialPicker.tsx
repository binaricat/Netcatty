/**
 * Floating credential list for sudo/su password-prompt assist (picker mode).
 * Renders near the bottom of the terminal container. Secrets are never shown.
 */
import React, { memo, useEffect, useRef } from "react";
import { KeyRound } from "lucide-react";
import type { PasswordPromptPickerItem } from "./runtime/terminalSudoAutofill";

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
  };
};

const PasswordCredentialPicker: React.FC<PasswordCredentialPickerProps> = ({
  items,
  selectedIndex,
  visible,
  onSelect,
  title,
  emptyText,
  themeColors,
}) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!visible) return;
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [visible, selectedIndex]);

  if (!visible) return null;

  const background = themeColors?.background ?? "hsl(var(--popover))";
  const foreground = themeColors?.foreground ?? "hsl(var(--popover-foreground))";
  const selection = themeColors?.selection ?? "hsl(var(--accent))";

  return (
    <div
      className="pointer-events-auto absolute bottom-3 left-1/2 z-40 w-[min(360px,calc(100%-1.5rem))] -translate-x-1/2 overflow-hidden rounded-md border border-border/70 shadow-lg"
      style={{ background, color: foreground }}
      role="listbox"
      aria-label={title}
      data-testid="password-credential-picker"
    >
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide opacity-70">
        <KeyRound size={12} />
        <span>{title}</span>
      </div>
      <div ref={listRef} className="max-h-48 overflow-y-auto py-1">
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
                style={selected ? { background: selection } : undefined}
                onMouseDown={(e) => {
                  // Prevent terminal blur / focus loss before select fires.
                  e.preventDefault();
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
};

export default memo(PasswordCredentialPicker);
