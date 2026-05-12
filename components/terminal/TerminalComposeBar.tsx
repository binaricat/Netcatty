/**
 * Terminal Compose Bar
 * An immersive, borderless prompt bar that blends into the terminal's
 * background — like the Claude Code compose area. Enter sends, Escape
 * closes, Shift+Enter inserts a newline. The only visible chrome is a
 * hair-line top border separating it from the terminal output.
 */
import { Radio, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
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
                backgroundColor: resolvedBg,
                borderTop: `1px solid color-mix(in srgb, ${resolvedFg} 8%, ${resolvedBg} 92%)`,
                padding: '8px 12px',
            }}
        >
            <div className="flex items-center gap-2">
                {/* Broadcast indicator */}
                {isBroadcastEnabled && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="flex items-center cursor-default">
                                <Radio size={14} className="text-amber-400 animate-pulse" />
                            </div>
                        </TooltipTrigger>
                        <TooltipContent>{t("terminal.composeBar.broadcasting")}</TooltipContent>
                    </Tooltip>
                )}

                {/* Borderless input — lives flush on the terminal bg so the
                    bar feels like part of the terminal rather than a panel. */}
                <textarea
                    ref={textareaRef}
                    className={cn(
                        "flex-1 min-w-0 resize-none bg-transparent border-none px-0 py-0",
                        "text-xs font-mono leading-relaxed outline-none",
                        "placeholder:opacity-70",
                    )}
                    style={{
                        color: resolvedFg,
                        minHeight: '20px',
                        maxHeight: '120px',
                    }}
                    rows={1}
                    placeholder={t("terminal.composeBar.placeholder")}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={() => { isComposingRef.current = false; }}
                />

                {/* Minimal close button — no filled bg, hover only. */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className="h-6 w-6 flex items-center justify-center rounded-md transition-colors duration-150 flex-shrink-0"
                            style={{
                                color: `color-mix(in srgb, ${resolvedFg} 50%, ${resolvedBg} 50%)`,
                                background: 'transparent',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 10%, ${resolvedBg} 90%)`;
                                e.currentTarget.style.color = resolvedFg;
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                                e.currentTarget.style.color = `color-mix(in srgb, ${resolvedFg} 50%, ${resolvedBg} 50%)`;
                            }}
                            onClick={onClose}
                        >
                            <X size={12} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("terminal.composeBar.close")}</TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
};

export default TerminalComposeBar;
