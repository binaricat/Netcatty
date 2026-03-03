/**
 * Theme Select Modal
 * A modal dialog for selecting terminal themes in settings
 */

import React, { memo, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette, X } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { TERMINAL_THEMES, TerminalThemeConfig } from '../../infrastructure/config/terminalThemes';
import { useCustomThemes } from '../../application/state/customThemeStore';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

// Memoized theme item component to prevent unnecessary re-renders
const ThemeItem = memo(({
    theme,
    isSelected,
    onSelect
}: {
    theme: TerminalThemeConfig;
    isSelected: boolean;
    onSelect: (id: string) => void;
}) => (
    <button
        onClick={() => onSelect(theme.id)}
        className={cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all',
            isSelected
                ? 'bg-primary/15 ring-1 ring-primary'
                : 'hover:bg-muted'
        )}
    >
        {/* Color swatch preview */}
        <div
            className="w-12 h-8 rounded-md flex-shrink-0 flex flex-col justify-center items-start pl-1.5 gap-0.5 border border-border/50"
            style={{ backgroundColor: theme.colors.background }}
        >
            <div className="h-1 w-4 rounded-full" style={{ backgroundColor: theme.colors.green }} />
            <div className="h-1 w-6 rounded-full" style={{ backgroundColor: theme.colors.blue }} />
            <div className="h-1 w-3 rounded-full" style={{ backgroundColor: theme.colors.yellow }} />
        </div>
        <div className="flex-1 min-w-0">
            <div className={cn('text-sm font-medium truncate', isSelected ? 'text-primary' : 'text-foreground')}>
                {theme.name}
            </div>
            <div className="text-[10px] text-muted-foreground capitalize">{theme.type}</div>
        </div>
        {isSelected && (
            <Check size={16} className="text-primary flex-shrink-0" />
        )}
    </button>
));
ThemeItem.displayName = 'ThemeItem';

interface ThemeSelectModalProps {
    open: boolean;
    onClose: () => void;
    selectedThemeId: string;
    onSelect: (themeId: string) => void;
}

export const ThemeSelectModal: React.FC<ThemeSelectModalProps> = ({
    open,
    onClose,
    selectedThemeId,
    onSelect,
}) => {
    const { t } = useI18n();

    // Group themes by type
    const { darkThemes, lightThemes } = useMemo(() => {
        const dark = TERMINAL_THEMES.filter(t => t.type === 'dark');
        const light = TERMINAL_THEMES.filter(t => t.type === 'light');
        return { darkThemes: dark, lightThemes: light };
    }, []);

    const customThemes = useCustomThemes();

    // Handle theme selection - select and close
    const handleThemeSelect = useCallback((themeId: string) => {
        onSelect(themeId);
        onClose();
    }, [onSelect, onClose]);

    // Handle ESC key
    React.useEffect(() => {
        if (!open) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, onClose]);

    // Handle backdrop click
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    }, [onClose]);

    if (!open) return null;

    const modalTitleId = 'theme-select-modal-title';

    const modalContent = (
        <div
            className="fixed inset-0 flex items-center justify-center bg-black/60"
            style={{ zIndex: 99999 }}
            onClick={handleBackdropClick}
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
        >
            <div
                className="w-[480px] max-h-[600px] bg-background border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 shrink-0 border-b border-border">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10">
                            <Palette size={16} className="text-primary" />
                        </div>
                        <h2 id={modalTitleId} className="text-sm font-semibold text-foreground">{t('settings.terminal.themeModal.title')}</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        aria-label={t('common.close')}
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Theme List */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4">
                    {/* Dark Themes Section */}
                    <div className="mb-4">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold px-1">
                            {t('settings.terminal.themeModal.darkThemes')}
                        </div>
                        <div className="space-y-1">
                            {darkThemes.map(theme => (
                                <ThemeItem
                                    key={theme.id}
                                    theme={theme}
                                    isSelected={selectedThemeId === theme.id}
                                    onSelect={handleThemeSelect}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Light Themes Section */}
                    <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold px-1">
                            {t('settings.terminal.themeModal.lightThemes')}
                        </div>
                        <div className="space-y-1">
                            {lightThemes.map(theme => (
                                <ThemeItem
                                    key={theme.id}
                                    theme={theme}
                                    isSelected={selectedThemeId === theme.id}
                                    onSelect={handleThemeSelect}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Custom Themes Section */}
                    {customThemes.length > 0 && (
                        <div className="mt-4">
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold px-1">
                                {t('terminal.customTheme.section')}
                            </div>
                            <div className="space-y-1">
                                {customThemes.map(theme => (
                                    <ThemeItem
                                        key={theme.id}
                                        theme={theme}
                                        isSelected={selectedThemeId === theme.id}
                                        onSelect={handleThemeSelect}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end px-5 py-3 shrink-0 border-t border-border bg-muted/20">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                    >
                        {t('common.cancel')}
                    </Button>
                </div>
            </div>
        </div>
    );

    // Use Portal to render at document root
    return createPortal(modalContent, document.body);
};

export default ThemeSelectModal;
