/**
 * Terminal Toolbar
 * Displays SFTP, Scripts, Theme, Highlight, Search buttons and close button in terminal status bar
 */
import { FolderInput, X, Zap, Palette, Search } from 'lucide-react';
import React, { useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Snippet, Host } from '../../types';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScrollArea } from '../ui/scroll-area';
import ThemeCustomizeModal from './ThemeCustomizeModal';
import HostKeywordHighlightPopover from './HostKeywordHighlightPopover';

export interface TerminalToolbarProps {
    status: 'connecting' | 'connected' | 'disconnected';
    snippets: Snippet[];
    host?: Host;
    defaultThemeId: string;
    defaultFontFamilyId: string;
    defaultFontSize: number;
    onUpdateTerminalThemeId?: (themeId: string) => void;
    onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
    onUpdateTerminalFontSize?: (fontSize: number) => void;
    isScriptsOpen: boolean;
    setIsScriptsOpen: (open: boolean) => void;
    onOpenSFTP: () => void;
    onSnippetClick: (command: string) => void;
    onUpdateHost?: (host: Host) => void;
    showClose?: boolean;
    onClose?: () => void;
    // Search functionality
    isSearchOpen?: boolean;
    onToggleSearch?: () => void;
}

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
    status,
    snippets,
    host,
    defaultThemeId,
    defaultFontFamilyId,
    defaultFontSize,
    onUpdateTerminalThemeId,
    onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize,
    isScriptsOpen,
    setIsScriptsOpen,
    onOpenSFTP,
    onSnippetClick,
    onUpdateHost,
    showClose,
    onClose,
    isSearchOpen,
    onToggleSearch,
}) => {
    const { t } = useI18n();
    const [themeModalOpen, setThemeModalOpen] = useState(false);
    const [highlightPopoverOpen, setHighlightPopoverOpen] = useState(false);
    const buttonBase = "h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent";

    const isLocalTerminal = host?.protocol === 'local' || host?.id?.startsWith('local-');
    const isSerialTerminal = host?.protocol === 'serial' || host?.id?.startsWith('serial-');
    const hidesSftp = isLocalTerminal || isSerialTerminal;

    const currentThemeId = host?.theme || defaultThemeId;
    const currentFontFamilyId = host?.fontFamily || defaultFontFamilyId;
    const currentFontSize = host?.fontSize || defaultFontSize;

    const handleThemeChange = (themeId: string) => {
        if (isLocalTerminal) {
            onUpdateTerminalThemeId?.(themeId);
            return;
        }
        if (host && onUpdateHost) {
            onUpdateHost({ ...host, theme: themeId });
        }
    };

    const handleFontFamilyChange = (fontFamilyId: string) => {
        if (isLocalTerminal) {
            onUpdateTerminalFontFamilyId?.(fontFamilyId);
            return;
        }
        if (host && onUpdateHost) {
            onUpdateHost({ ...host, fontFamily: fontFamilyId });
        }
    };

    const handleFontSizeChange = (fontSize: number) => {
        if (isLocalTerminal) {
            onUpdateTerminalFontSize?.(fontSize);
            return;
        }
        if (host && onUpdateHost) {
            onUpdateHost({ ...host, fontSize });
        }
    };

    return (
        <>
            {!hidesSftp && (
                <Button
                    variant="secondary"
                    size="icon"
                    className={buttonBase}
                    disabled={status !== 'connected'}
                    title={status === 'connected' ? t("terminal.toolbar.openSftp") : t("terminal.toolbar.availableAfterConnect")}
                    aria-label={t("terminal.toolbar.openSftp")}
                    onClick={onOpenSFTP}
                >
                    <FolderInput size={12} />
                </Button>
            )}

            <Popover open={isScriptsOpen} onOpenChange={setIsScriptsOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="secondary"
                        size="icon"
                        className={buttonBase}
                        title={t("terminal.toolbar.scripts")}
                        aria-label={t("terminal.toolbar.scripts")}
                    >
                        <Zap size={12} />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0" align="start">
                    <div className="px-3 py-2 text-[10px] uppercase text-muted-foreground font-semibold bg-muted/30 border-b">
                        {t("terminal.toolbar.library")}
                    </div>
                    <ScrollArea className="h-64">
                        <div className="py-1">
                            {snippets.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground italic">
                                    {t("terminal.toolbar.noSnippets")}
                                </div>
                            ) : (
                                snippets.map((s) => (
                                    <button
                                        key={s.id}
                                        onClick={() => onSnippetClick(s.command)}
                                        className="w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors flex flex-col gap-0.5"
                                    >
                                        <span className="font-medium">{s.label}</span>
                                        <span className="text-muted-foreground truncate font-mono text-[10px]">
                                            {s.command}
                                        </span>
                                    </button>
                                ))
                            )}
                        </div>
                    </ScrollArea>
                </PopoverContent>
            </Popover>

            <Button
                variant="secondary"
                size="icon"
                className={buttonBase}
                title={t("terminal.toolbar.terminalSettings")}
                aria-label={t("terminal.toolbar.terminalSettings")}
                onClick={() => setThemeModalOpen(true)}
            >
                <Palette size={12} />
            </Button>

            <HostKeywordHighlightPopover
                host={host}
                onUpdateHost={onUpdateHost}
                isOpen={highlightPopoverOpen}
                setIsOpen={setHighlightPopoverOpen}
                buttonClassName={buttonBase}
            />

            <Button
                variant="secondary"
                size="icon"
                className={buttonBase}
                title={t("terminal.toolbar.searchTerminal")}
                aria-label={t("terminal.toolbar.searchTerminal")}
                aria-pressed={isSearchOpen}
                onClick={onToggleSearch}
            >
                <Search size={12} />
            </Button>

            {showClose && onClose && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-[color:var(--terminal-toolbar-fg)] hover:bg-transparent"
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }}
                    title={t("terminal.toolbar.closeSession")}
                >
                    <X size={11} />
                </Button>
            )}

            <ThemeCustomizeModal
                open={themeModalOpen}
                onClose={() => setThemeModalOpen(false)}
                currentThemeId={currentThemeId}
                currentFontFamilyId={currentFontFamilyId}
                currentFontSize={currentFontSize}
                onThemeChange={handleThemeChange}
                onFontFamilyChange={handleFontFamilyChange}
                onFontSizeChange={handleFontSizeChange}
                onSave={() => {
                    // Trigger any necessary updates
                }}
            />
        </>
    );
};

export default TerminalToolbar;
