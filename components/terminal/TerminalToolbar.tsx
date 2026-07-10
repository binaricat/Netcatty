/**
 * Terminal Toolbar
 * Displays high-frequency terminal actions and close button in the terminal status bar.
 */
import { Check, ChevronRight, Download, FileText, FolderInput, FolderSync, History, Languages, MoreVertical, X, Zap, Palette, Search, TextCursorInput, Upload, Circle } from 'lucide-react';
import React, { useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host, Snippet } from '../../types';
import { ScriptsSidePanel } from '../ScriptsSidePanel';
import { Button } from '../ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import HostKeywordHighlightPopover from './HostKeywordHighlightPopover';

export interface TerminalToolbarProps {
    status: 'connecting' | 'connected' | 'disconnected';
    host?: Host;
    /** Popup/minimal mode: compose bar, search, and snippets only. */
    compactToolbar?: boolean;
    snippets?: Snippet[];
    snippetPackages?: string[];
    onSnippetClick?: (snippet: Snippet) => void;
    onOpenSFTP: () => void;
    onSendYmodem?: () => void;
    onReceiveYmodem?: () => void;
    onOpenScripts: () => void;
    onOpenHistory?: () => void;
    onOpenTheme: () => void;
    onConfigureOsc7?: () => void;
    onUpdateHost?: (host: Host) => void;
    showClose?: boolean;
    onClose?: () => void;
    /** When true, close is "return pane to its own tab" rather than kill the session. */
    closeRestoresTab?: boolean;
    // Search functionality
    isSearchOpen?: boolean;
    onToggleSearch?: () => void;
    // Manual session log
    showLogButton?: boolean;
    onToggleSessionLog?: () => void;
    isSessionLogging?: boolean;
    isSessionLogDisabled?: boolean;
    // Compose bar
    isComposeBarOpen?: boolean;
    onToggleComposeBar?: () => void;
    // Terminal encoding
    terminalEncoding?: 'utf-8' | 'gb18030';
    onSetTerminalEncoding?: (encoding: 'utf-8' | 'gb18030') => void;
    recordingIndicator?: React.ReactNode;
    onStartRecording?: () => void;
}

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
    status,
    host,
    compactToolbar = false,
    snippets = [],
    snippetPackages = [],
    onSnippetClick,
    onOpenSFTP,
    onSendYmodem,
    onReceiveYmodem,
    onOpenScripts,
    onOpenHistory,
    onOpenTheme,
    onConfigureOsc7,
    onUpdateHost,
    showClose,
    onClose,
    closeRestoresTab = false,
    isSearchOpen,
    onToggleSearch,
    showLogButton = false,
    onToggleSessionLog,
    isSessionLogging = false,
    isSessionLogDisabled = false,
    isComposeBarOpen,
    onToggleComposeBar,
    terminalEncoding,
    onSetTerminalEncoding,
    recordingIndicator,
    onStartRecording,
}) => {
    const { t } = useI18n();
    const [highlightPopoverOpen, setHighlightPopoverOpen] = useState(false);
    const [scriptsPopoverOpen, setScriptsPopoverOpen] = useState(false);
    // Overflow popover + encoding submenu are both controlled so that
    // picking an encoding closes the whole chain, and so the parent popover
    // can ignore clicks that land in the submenu portal (otherwise the
    // submenu click would read as "outside" and dismiss the parent).
    const [overflowOpen, setOverflowOpen] = useState(false);
    const [encodingSubmenuOpen, setEncodingSubmenuOpen] = useState(false);
    const buttonBase = "h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent";

    const isLocalTerminal = host?.protocol === 'local' || host?.id?.startsWith('local-');
    const isSerialTerminal = host?.protocol === 'serial' || host?.id?.startsWith('serial-');
    const isMoshSession = host?.protocol === 'mosh' || host?.moshEnabled;
    const isEtSession = host?.protocol === 'et' || host?.etEnabled;
    // Local PTY inherits the OS locale and mosh/ET always use their own framing,
    // so the quick-switch menu only makes sense for sessions whose
    // backend decoder we actually control (SSH, telnet, serial). Hostname
    // isn't part of the gate — telnet/SSH targets pointed at localhost
    // (test daemons, forwarded endpoints) still have a real backend
    // decoder we can drive.
    const encodingSwitchSupported = !isLocalTerminal && !isMoshSession && !isEtSession;
    const hidesSftp = isLocalTerminal || isSerialTerminal;
    const historySupported = !!onOpenHistory && !isLocalTerminal && !isSerialTerminal && host?.protocol !== 'telnet';
    const unavailableYmodemSendLabel = `${t("terminal.toolbar.sendYmodem")} - ${t("terminal.toolbar.availableAfterConnect")}`;
    const unavailableYmodemReceiveLabel = `${t("terminal.toolbar.receiveYmodem")} - ${t("terminal.toolbar.availableAfterConnect")}`;

    const menuItemClass = "w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors";
    const activeButtonStyle: React.CSSProperties = {
        backgroundColor: 'var(--terminal-toolbar-btn-active)',
    };

    if (compactToolbar) {
        return (
            <TooltipProvider delayDuration={500} skipDelayDuration={100} disableHoverableContent>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="secondary"
                            size="icon"
                            className={buttonBase}
                            aria-label={t("terminal.toolbar.composeBar")}
                            aria-pressed={isComposeBarOpen}
                            onClick={onToggleComposeBar}
                            style={isComposeBarOpen ? activeButtonStyle : undefined}
                        >
                            <TextCursorInput size={12} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("terminal.toolbar.composeBar")}</TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="secondary"
                            size="icon"
                            className={buttonBase}
                            aria-label={t("terminal.toolbar.searchTerminal")}
                            aria-pressed={isSearchOpen}
                            onClick={onToggleSearch}
                            style={isSearchOpen ? activeButtonStyle : undefined}
                        >
                            <Search size={12} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("terminal.toolbar.searchTerminal")}</TooltipContent>
                </Tooltip>

                <Popover open={scriptsPopoverOpen} onOpenChange={setScriptsPopoverOpen}>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <PopoverTrigger asChild>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    className={buttonBase}
                                    aria-label={t("terminal.toolbar.scripts")}
                                    aria-pressed={scriptsPopoverOpen}
                                    style={scriptsPopoverOpen ? activeButtonStyle : undefined}
                                >
                                    <Zap size={12} />
                                </Button>
                            </PopoverTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t("terminal.toolbar.scripts")}</TooltipContent>
                    </Tooltip>
                    <PopoverContent className="w-80 p-0 h-80 flex flex-col overflow-hidden" align="end">
                        <ScriptsSidePanel
                            snippets={snippets}
                            packages={snippetPackages}
                            isVisible={scriptsPopoverOpen}
                            onSnippetClick={(snippet) => {
                                onSnippetClick?.(snippet);
                                setScriptsPopoverOpen(false);
                            }}
                        />
                    </PopoverContent>
                </Popover>
            </TooltipProvider>
        );
    }

    return (
        <TooltipProvider delayDuration={500} skipDelayDuration={100} disableHoverableContent>
            <HostKeywordHighlightPopover
                host={host}
                onUpdateHost={onUpdateHost}
                isOpen={highlightPopoverOpen}
                setIsOpen={setHighlightPopoverOpen}
                buttonClassName={buttonBase}
            />

            {!hidesSftp && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="secondary"
                            size="icon"
                            className={cn(buttonBase, status !== 'connected' && "opacity-50")}
                            aria-label={status === 'connected' ? t("terminal.toolbar.openSftp") : t("terminal.toolbar.availableAfterConnect")}
                            onClick={onOpenSFTP}
                            disabled={status !== 'connected'}
                        >
                            <FolderInput size={12} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {status === 'connected' ? t("terminal.toolbar.openSftp") : t("terminal.toolbar.availableAfterConnect")}
                    </TooltipContent>
                </Tooltip>
            )}

            {isSerialTerminal && (
                <>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="secondary"
                                size="icon"
                                className={cn(buttonBase, status !== 'connected' && "opacity-50")}
                                aria-label={status === 'connected' ? t("terminal.toolbar.sendYmodem") : unavailableYmodemSendLabel}
                                onClick={onSendYmodem}
                                disabled={status !== 'connected' || !onSendYmodem}
                            >
                                <Upload size={12} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {status === 'connected' ? t("terminal.toolbar.sendYmodem") : t("terminal.toolbar.availableAfterConnect")}
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="secondary"
                                size="icon"
                                className={cn(buttonBase, status !== 'connected' && "opacity-50")}
                                aria-label={status === 'connected' ? t("terminal.toolbar.receiveYmodem") : unavailableYmodemReceiveLabel}
                                onClick={onReceiveYmodem}
                                disabled={status !== 'connected' || !onReceiveYmodem}
                            >
                                <Download size={12} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {status === 'connected' ? t("terminal.toolbar.receiveYmodem") : t("terminal.toolbar.availableAfterConnect")}
                        </TooltipContent>
                    </Tooltip>
                </>
            )}

            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className={buttonBase}
                        aria-label={t("terminal.toolbar.composeBar")}
                        aria-pressed={isComposeBarOpen}
                        onClick={onToggleComposeBar}
                        style={isComposeBarOpen ? activeButtonStyle : undefined}
                    >
                        <TextCursorInput size={12} />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{t("terminal.toolbar.composeBar")}</TooltipContent>
            </Tooltip>

            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className={buttonBase}
                        aria-label={t("terminal.toolbar.searchTerminal")}
                        aria-pressed={isSearchOpen}
                        onClick={onToggleSearch}
                        style={isSearchOpen ? activeButtonStyle : undefined}
                    >
                        <Search size={12} />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{t("terminal.toolbar.searchTerminal")}</TooltipContent>
            </Tooltip>

            {showLogButton && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            className={cn(buttonBase, isSessionLogDisabled && "opacity-50")}
                            aria-label={isSessionLogging ? t("terminal.toolbar.stopSessionLog") : t("terminal.toolbar.startSessionLog")}
                            aria-pressed={isSessionLogging}
                            onClick={onToggleSessionLog}
                            disabled={isSessionLogDisabled || !onToggleSessionLog}
                            style={isSessionLogging ? activeButtonStyle : undefined}
                        >
                            <FileText size={12} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {isSessionLogging ? t("terminal.toolbar.stopSessionLog") : t("terminal.toolbar.startSessionLog")}
                    </TooltipContent>
                </Tooltip>
            )}

            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className={buttonBase}
                        aria-label={t("terminal.toolbar.scripts")}
                        onClick={onOpenScripts}
                    >
                        <Zap size={12} />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{t("terminal.toolbar.scripts")}</TooltipContent>
            </Tooltip>

            {/* Overflow menu — keeps lower-frequency opener-style actions
                (Encoding / Terminal Settings) behind a single
                trigger so the toolbar doesn't feel crowded.
                Highlight / Compose / Search / Scripts stay visible because they
                are toggled mid-session, not just once. */}
            <Popover
                open={overflowOpen}
                onOpenChange={(open) => {
                    setOverflowOpen(open);
                    if (!open) setEncodingSubmenuOpen(false);
                }}
            >
                <Tooltip>
                    <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                            <Button
                                variant="secondary"
                                size="icon"
                                className={buttonBase}
                                aria-label={t("terminal.toolbar.more")}
                            >
                                <MoreVertical size={14} />
                            </Button>
                        </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{t("terminal.toolbar.more")}</TooltipContent>
                </Tooltip>
                <PopoverContent
                    className="w-48 p-1"
                    align="end"
                    onInteractOutside={(e) => {
                        // Radix treats the submenu's portalled content as
                        // "outside" this popover; without this guard a click
                        // in the submenu would dismiss the parent.
                        const target = e.target as Element | null;
                        if (target?.closest('[data-encoding-submenu="true"]')) {
                            e.preventDefault();
                        }
                    }}
                >
                    {historySupported && (
                        <PopoverClose asChild>
                            <button
                                type="button"
                                className={menuItemClass}
                                disabled={status !== 'connected'}
                                onClick={onOpenHistory}
                            >
                                <History size={12} className="shrink-0" />
                                <span className="flex-1 text-left truncate">
                                    {status === 'connected' ? t("terminal.toolbar.history") : t("terminal.toolbar.availableAfterConnect")}
                                </span>
                            </button>
                        </PopoverClose>
                    )}
                    {onConfigureOsc7 && !hidesSftp && (
                        <PopoverClose asChild>
                            <button
                                type="button"
                                className={menuItemClass}
                                disabled={status !== 'connected'}
                                onClick={onConfigureOsc7}
                            >
                                <FolderSync size={12} className="shrink-0" />
                                <span className="flex-1 text-left truncate">
                                    {status === 'connected' ? t("terminal.toolbar.configureOsc7") : t("terminal.toolbar.availableAfterConnect")}
                                </span>
                            </button>
                        </PopoverClose>
                    )}
                    <PopoverClose asChild>
                        <button type="button" className={menuItemClass} onClick={onOpenTheme}>
                            <Palette size={12} className="shrink-0" />
                            <span className="flex-1 text-left truncate">{t("terminal.toolbar.terminalSettings")}</span>
                        </button>
                    </PopoverClose>
                    {onStartRecording && status === 'connected' && !recordingIndicator ? (
                        <PopoverClose asChild>
                            <button type="button" className={menuItemClass} onClick={onStartRecording}>
                                <Circle size={12} className="shrink-0 text-red-500" />
                                <span className="flex-1 text-left truncate">{t('scripts.recording.start')}</span>
                            </button>
                        </PopoverClose>
                    ) : null}
                    {encodingSwitchSupported && onSetTerminalEncoding && (
                        <Popover open={encodingSubmenuOpen} onOpenChange={setEncodingSubmenuOpen}>
                            <PopoverTrigger asChild>
                                <button
                                    type="button"
                                    className={menuItemClass}
                                    aria-haspopup="menu"
                                    aria-expanded={encodingSubmenuOpen}
                                >
                                    <Languages size={12} className="shrink-0" />
                                    <span className="flex-1 text-left truncate">{t("terminal.toolbar.encoding")}</span>
                                    <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
                                </button>
                            </PopoverTrigger>
                            <PopoverContent
                                data-encoding-submenu="true"
                                className="w-40 p-1"
                                side="right"
                                align="start"
                                sideOffset={6}
                            >
                                {(["utf-8", "gb18030"] as const).map((enc) => {
                                    const isActive = terminalEncoding === enc;
                                    return (
                                        <button
                                            key={enc}
                                            type="button"
                                            className={cn(menuItemClass, isActive && "font-medium")}
                                            onClick={() => {
                                                onSetTerminalEncoding(enc);
                                                setEncodingSubmenuOpen(false);
                                                setOverflowOpen(false);
                                            }}
                                        >
                                            <Languages size={12} className="shrink-0" />
                                            <span className="flex-1 text-left truncate">
                                                {t(`terminal.toolbar.encoding.${enc === "utf-8" ? "utf8" : enc}`)}
                                            </span>
                                            <Check
                                                size={12}
                                                className={cn(
                                                    "shrink-0",
                                                    isActive ? "opacity-100" : "opacity-0",
                                                )}
                                            />
                                        </button>
                                    );
                                })}
                            </PopoverContent>
                        </Popover>
                    )}
                </PopoverContent>
            </Popover>

            {recordingIndicator}

            {showClose && onClose && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-[color:var(--terminal-toolbar-fg)] hover:bg-transparent"
                            onClick={(e) => {
                                e.stopPropagation();
                                onClose();
                            }}
                        >
                            <X size={11} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {closeRestoresTab
                            ? t("terminal.toolbar.detach")
                            : t("terminal.toolbar.closeSession")}
                    </TooltipContent>
                </Tooltip>
            )}
        </TooltipProvider>
    );
};

export default TerminalToolbar;
