/**
 * Terminal Compose Bar
 * A modern text input bar for composing commands before sending them.
 * Supports pre-reviewing passwords/commands and broadcasting to multiple sessions.
 */
import { Radio, Send, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';

export interface TerminalComposeBarProps {
    onSend: (text: string) => void;
    onClose: () => void;
    isBroadcastEnabled?: boolean;
    themeColors?: {
        background: string;
        foreground: string;
    };
}

export const TerminalComposeBar: React.FC<TerminalComposeBarProps> = ({
    onSend,
    onClose,
    isBroadcastEnabled,
    themeColors,
}) => {
    const { t } = useI18n();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);

    // Auto-focus on mount
    useEffect(() => {
        // Small delay to ensure the element is rendered
        const timer = setTimeout(() => textareaRef.current?.focus(), 50);
        return () => clearTimeout(timer);
    }, []);

    // Auto-resize textarea
    const handleInput = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, []);

    const handleSend = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        const text = el.value;
        if (!text) return;
        onSend(text);
        el.value = '';
        el.style.height = 'auto';
        el.focus();
    }, [onSend]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
            e.preventDefault();
            handleSend();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }, [handleSend, onClose]);

    const bg = themeColors?.background ?? '#0a0a0a';
    const fg = themeColors?.foreground ?? '#d4d4d4';
    const resolvedBg = 'var(--terminal-ui-bg, ' + bg + ')';
    const resolvedFg = 'var(--terminal-ui-fg, ' + fg + ')';

    return (
        <div
            className="flex-shrink-0"
            style={{
                background: `linear-gradient(to top, ${resolvedBg}, color-mix(in srgb, ${resolvedFg} 4%, ${resolvedBg} 96%))`,
                borderTop: `1px solid color-mix(in srgb, ${resolvedFg} 10%, ${resolvedBg} 90%)`,
                borderRadius: '0 0 8px 8px',
                padding: '6px 10px',
            }}
        >
            <div className="flex items-center gap-2">
                {/* Broadcast indicator */}
                {isBroadcastEnabled && (
                    <div
                        className="flex items-center"
                        title={t("terminal.composeBar.broadcasting")}
                    >
                        <Radio size={14} className="text-amber-400 animate-pulse" />
                    </div>
                )}

                {/* Input field */}
                <textarea
                    ref={textareaRef}
                    className={cn(
                        "flex-1 min-w-0 resize-none rounded-md px-3 py-1.5 text-xs font-mono leading-relaxed",
                        "outline-none transition-all duration-200",
                        "placeholder:opacity-40",
                    )}
                    style={{
                        backgroundColor: `color-mix(in srgb, ${resolvedFg} 6%, ${resolvedBg} 94%)`,
                        color: resolvedFg,
                        border: `1px solid color-mix(in srgb, ${resolvedFg} 25%, ${resolvedBg} 75%)`,
                        minHeight: '28px',
                        maxHeight: '120px',
                        boxShadow: `inset 0 1px 3px color-mix(in srgb, ${resolvedBg} 80%, transparent)`,
                    }}
                    rows={1}
                    placeholder={t("terminal.composeBar.placeholder")}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onFocus={(e) => {
                        e.currentTarget.style.borderColor = `color-mix(in srgb, ${resolvedFg} 40%, ${resolvedBg} 60%)`;
                        e.currentTarget.style.boxShadow = `inset 0 1px 3px color-mix(in srgb, ${resolvedBg} 80%, transparent), 0 0 0 1px color-mix(in srgb, ${resolvedFg} 8%, transparent)`;
                    }}
                    onBlur={(e) => {
                        e.currentTarget.style.borderColor = `color-mix(in srgb, ${resolvedFg} 25%, ${resolvedBg} 75%)`;
                        e.currentTarget.style.boxShadow = `inset 0 1px 3px color-mix(in srgb, ${resolvedBg} 80%, transparent)`;
                    }}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={() => { isComposingRef.current = false; }}
                />

                {/* Action buttons */}
                <div className="flex items-center gap-0.5">
                    <button
                        className="h-7 w-7 flex items-center justify-center rounded-md transition-colors duration-150"
                        style={{
                            color: resolvedFg,
                            background: `color-mix(in srgb, ${resolvedFg} 20%, ${resolvedBg} 80%)`,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 30%, ${resolvedBg} 70%)`;
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 20%, ${resolvedBg} 80%)`;
                        }}
                        onClick={handleSend}
                        title={t("terminal.composeBar.send")}
                    >
                        <Send size={13} />
                    </button>
                    <button
                        className="h-7 w-7 flex items-center justify-center rounded-md transition-colors duration-150"
                        style={{
                            color: `color-mix(in srgb, ${resolvedFg} 60%, ${resolvedBg} 40%)`,
                            background: `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 22%, ${resolvedBg} 78%)`;
                            e.currentTarget.style.color = resolvedFg;
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`;
                            e.currentTarget.style.color = `color-mix(in srgb, ${resolvedFg} 60%, ${resolvedBg} 40%)`;
                        }}
                        onClick={onClose}
                        title={t("terminal.composeBar.close")}
                    >
                        <X size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TerminalComposeBar;
