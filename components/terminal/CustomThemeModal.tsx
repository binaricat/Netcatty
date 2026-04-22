/**
 * Dedicated Custom Theme Editor Modal
 * Standalone modal with two-column layout: editor (left) + preview (right)
 * Opens on top of ThemeCustomizeModal for creating/editing custom themes.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { TerminalTheme } from '../../domain/models';
import { useI18n } from '../../application/i18n/I18nProvider';
import { CustomThemeEditor } from './CustomThemeEditor';
import { Button } from '../ui/button';


interface CustomThemeModalProps {
    open: boolean;
    theme: TerminalTheme;
    isNew: boolean;
    onSave: (theme: TerminalTheme) => void;
    onDelete?: (themeId: string) => void;
    onCancel: () => void;
}

// Minimal terminal preview for the right panel
const MiniPreview: React.FC<{ theme: TerminalTheme }> = ({ theme }) => (
    <div
        className="rounded-lg border border-border/50 overflow-hidden font-mono text-[11px] leading-relaxed flex-1"
        style={{ backgroundColor: theme.colors.background, color: theme.colors.foreground }}
    >
        {/* Title bar */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-black/20">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
            <span className="flex-1 text-center text-[10px] opacity-50">Terminal Preview</span>
        </div>
        <div className="p-3 space-y-0.5">
            <div>
                <span style={{ color: theme.colors.green }}>user@server</span>
                <span style={{ color: theme.colors.foreground }}>:</span>
                <span style={{ color: theme.colors.blue }}>~</span>
                <span style={{ color: theme.colors.foreground }}>$ neofetch</span>
            </div>
            <div style={{ color: theme.colors.cyan }}>{'  ,g$$P"     """Y$$."".        '}</div>
            <div>
                <span style={{ color: theme.colors.cyan }}>{` ,$$P'   `}</span>
                <span style={{ color: theme.colors.blue }}>OS</span>
                <span>: Ubuntu 22.04 LTS</span>
            </div>
            <div>
                <span style={{ color: theme.colors.cyan }}>{` '',$$P `}</span>
                <span style={{ color: theme.colors.blue }}>Kernel</span>
                <span>: 5.15.0-generic</span>
            </div>
            <div>
                <span style={{ color: theme.colors.cyan }}>{` d$$'  `}</span>
                <span style={{ color: theme.colors.blue }}>Shell</span>
                <span>: bash 5.1.16</span>
            </div>
            <div>
                <span style={{ color: theme.colors.cyan }}>{` $$P   `}</span>
                <span style={{ color: theme.colors.blue }}>Memory</span>
                <span>: 4.2G / 16G (26%)</span>
            </div>
            <div>&nbsp;</div>
            {/* ANSI color palette */}
            <div className="flex gap-0.5">
                {[theme.colors.black, theme.colors.red, theme.colors.green, theme.colors.yellow,
                theme.colors.blue, theme.colors.magenta, theme.colors.cyan, theme.colors.white].map((c, i) => (
                    <div key={i} className="w-3.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
                ))}
            </div>
            <div className="flex gap-0.5">
                {[theme.colors.brightBlack, theme.colors.brightRed, theme.colors.brightGreen, theme.colors.brightYellow,
                theme.colors.brightBlue, theme.colors.brightMagenta, theme.colors.brightCyan, theme.colors.brightWhite].map((c, i) => (
                    <div key={i} className="w-3.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
                ))}
            </div>
            <div>&nbsp;</div>
            <div>
                <span style={{ color: theme.colors.green }}>user@server</span>
                <span>:</span>
                <span style={{ color: theme.colors.blue }}>~</span>
                <span>$ </span>
                <span style={{ backgroundColor: theme.colors.cursor, color: theme.colors.background }}>&nbsp;</span>
            </div>
        </div>
    </div>
);

export const CustomThemeModal: React.FC<CustomThemeModalProps> = ({
    open,
    theme: initialTheme,
    isNew,
    onSave,
    onDelete,
    onCancel,
}) => {
    const { t } = useI18n();
    const [editingTheme, setEditingTheme] = useState<TerminalTheme>(initialTheme);

    // Reset when opened with a new theme
    React.useEffect(() => {
        if (open) {
            setEditingTheme({ ...initialTheme, colors: { ...initialTheme.colors } });
        }
    }, [open, initialTheme]);

    const handleChange = useCallback((theme: TerminalTheme) => {
        setEditingTheme(theme);
    }, []);

    const handleSave = useCallback(() => {
        onSave(editingTheme);
    }, [editingTheme, onSave]);

    const handleDelete = useCallback(() => {
        onDelete?.(editingTheme.id);
    }, [editingTheme.id, onDelete]);

    // Dummy back handler — in the standalone modal, back = cancel
    const handleBack = useCallback(() => {
        onCancel();
    }, [onCancel]);

    const themeInfo = useMemo(() => {
        return `${editingTheme.name} • ${editingTheme.type.toUpperCase()}`;
    }, [editingTheme.name, editingTheme.type]);

    // Handle Escape key — close child editor
    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onCancel();
            }
        };
        document.addEventListener('keydown', handleKeyDown, true); // capture phase
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [open, onCancel]);

    if (!open) return null;

    const modalContent = (
        <div
            className="fixed inset-0 z-[300] flex items-center justify-center"
        >
            {/* Backdrop — clicking it dismisses the modal */}
            <div className="absolute inset-0 bg-black/60 supports-[backdrop-filter]:backdrop-blur-sm" onClick={onCancel} />

            {/* Modal */}
            <div className="relative z-10 bg-popover/95 supports-[backdrop-filter]:backdrop-blur-sm rounded-xl shadow-2xl border border-border/50 flex flex-col"
                style={{ width: 'min(820px, 90vw)', height: 'min(600px, 85vh)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 shrink-0 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">
                        {isNew ? t('terminal.customTheme.newTitle') : t('terminal.customTheme.editTitle')}
                    </h2>
                    <button
                        onClick={onCancel}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Body: Editor (left) + Preview (right) */}
                <div className="flex flex-1 min-h-0">
                    {/* Left: Editor */}
                    <div className="w-[300px] shrink-0 border-r border-border flex flex-col min-h-0">
                        <CustomThemeEditor
                            theme={editingTheme}
                            onChange={handleChange}
                            onBack={handleBack}
                            isNew={isNew}
                        />
                    </div>

                    {/* Right: Preview */}
                    <div className="flex-1 flex flex-col p-4 min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                            {t('terminal.themeModal.livePreview')}
                        </div>
                        <MiniPreview theme={editingTheme} />
                        <div className="mt-2 text-xs text-muted-foreground text-center">
                            {themeInfo}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center gap-3 px-5 py-3 shrink-0 border-t border-border bg-muted/20">
                    {/* Delete button (only for existing themes) */}
                    {!isNew && onDelete && (
                        <Button
                            variant="ghost"
                            onClick={handleDelete}
                            className="h-9 text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                        >
                            <Trash2 size={14} />
                            {t('terminal.customTheme.delete')}
                        </Button>
                    )}
                    <div className="flex-1" />
                    <Button
                        variant="ghost"
                        onClick={onCancel}
                        className="h-9 px-5"
                    >
                        {t('common.cancel')}
                    </Button>
                    <Button
                        onClick={handleSave}
                        className="h-9 px-6"
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
};

export default CustomThemeModal;
