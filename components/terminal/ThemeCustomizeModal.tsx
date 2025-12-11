/**
 * Terminal Theme Customize Modal
 * Left-right split design: list on left, large preview on right
 * Uses React Portal to render at document root for proper z-index
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, Minus, Palette, Plus, Type, X } from 'lucide-react';
import { TERMINAL_THEMES, TerminalThemeConfig } from '../../infrastructure/config/terminalThemes';
import { TERMINAL_FONTS, DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, TerminalFont } from '../../infrastructure/config/fonts';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

type TabType = 'theme' | 'font';

interface ThemeCustomizeModalProps {
    open: boolean;
    onClose: () => void;
    currentThemeId?: string;
    currentFontFamilyId?: string;
    currentFontSize?: number;
    onThemeChange?: (themeId: string) => void;
    onFontFamilyChange?: (fontFamilyId: string) => void;
    onFontSizeChange?: (fontSize: number) => void;
    onSave?: () => void;
}

export const ThemeCustomizeModal: React.FC<ThemeCustomizeModalProps> = ({
    open,
    onClose,
    currentThemeId = 'termius-dark',
    currentFontFamilyId = 'menlo',
    currentFontSize = DEFAULT_FONT_SIZE,
    onThemeChange,
    onFontFamilyChange,
    onFontSizeChange,
    onSave,
}) => {
    const [activeTab, setActiveTab] = useState<TabType>('theme');
    const [selectedTheme, setSelectedTheme] = useState(currentThemeId);
    const [selectedFont, setSelectedFont] = useState(currentFontFamilyId);
    const [fontSize, setFontSize] = useState(currentFontSize);

    // Sync state when props change
    useEffect(() => {
        if (open) {
            setSelectedTheme(currentThemeId);
            setSelectedFont(currentFontFamilyId);
            setFontSize(currentFontSize);
        }
    }, [open, currentThemeId, currentFontFamilyId, currentFontSize]);

    const currentFont = useMemo(
        () => TERMINAL_FONTS.find(f => f.id === selectedFont) || TERMINAL_FONTS[0],
        [selectedFont]
    );
    const currentTheme = useMemo(
        () => TERMINAL_THEMES.find(t => t.id === selectedTheme) || TERMINAL_THEMES[0],
        [selectedTheme]
    );

    const handleFontSizeChange = useCallback((delta: number) => {
        setFontSize(prev => {
            const newSize = prev + delta;
            return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, newSize));
        });
    }, []);

    const handleSave = useCallback(() => {
        onThemeChange?.(selectedTheme);
        onFontFamilyChange?.(selectedFont);
        onFontSizeChange?.(fontSize);
        onSave?.();
        onClose();
    }, [selectedTheme, selectedFont, fontSize, onThemeChange, onFontFamilyChange, onFontSizeChange, onSave, onClose]);

    // Handle ESC key
    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, onClose]);

    if (!open) return null;

    // Render theme item
    const renderThemeItem = (theme: TerminalThemeConfig) => (
        <button
            key={theme.id}
            onClick={() => setSelectedTheme(theme.id)}
            className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all',
                selectedTheme === theme.id
                    ? 'bg-primary/15 ring-1 ring-primary'
                    : 'hover:bg-muted'
            )}
        >
            {/* Color swatch */}
            <div
                className="w-8 h-8 rounded-md flex-shrink-0 flex flex-col justify-center items-start pl-1 gap-0.5 border border-border/50"
                style={{ backgroundColor: theme.colors.background }}
            >
                <div className="h-1 w-3 rounded-full" style={{ backgroundColor: theme.colors.green }} />
                <div className="h-1 w-5 rounded-full" style={{ backgroundColor: theme.colors.blue }} />
                <div className="h-1 w-2 rounded-full" style={{ backgroundColor: theme.colors.yellow }} />
            </div>
            <div className="flex-1 min-w-0">
                <div className={cn('text-xs font-medium truncate', selectedTheme === theme.id ? 'text-primary' : 'text-foreground')}>
                    {theme.name}
                </div>
                <div className="text-[10px] text-muted-foreground capitalize">{theme.type}</div>
            </div>
            {selectedTheme === theme.id && (
                <Check size={14} className="text-primary flex-shrink-0" />
            )}
        </button>
    );

    // Render font item
    const renderFontItem = (font: TerminalFont) => (
        <button
            key={font.id}
            onClick={() => setSelectedFont(font.id)}
            className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all',
                selectedFont === font.id
                    ? 'bg-primary/15 ring-1 ring-primary'
                    : 'hover:bg-muted'
            )}
        >
            <div className="flex-1 min-w-0">
                <div
                    className={cn('text-sm truncate', selectedFont === font.id ? 'text-primary' : 'text-foreground')}
                    style={{ fontFamily: font.family }}
                >
                    {font.name}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">{font.description}</div>
            </div>
            {selectedFont === font.id && (
                <Check size={14} className="text-primary flex-shrink-0" />
            )}
        </button>
    );

    const modalContent = (
        <div
            className="fixed inset-0 flex items-center justify-center bg-black/60"
            style={{ zIndex: 99999 }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className="w-[800px] h-[560px] bg-background border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 shrink-0 border-b border-border">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10">
                            <Palette size={16} className="text-primary" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-foreground">Terminal Appearance</h2>
                            <p className="text-xs text-muted-foreground">Customize theme, font and size</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Main Content - Left/Right Split */}
                <div className="flex-1 flex min-h-0">
                    {/* Left Panel - List */}
                    <div className="w-[280px] border-r border-border flex flex-col shrink-0">
                        {/* Tab Bar */}
                        <div className="flex p-2 gap-1 shrink-0 border-b border-border">
                            <button
                                onClick={() => setActiveTab('theme')}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all',
                                    activeTab === 'theme'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                )}
                            >
                                <Palette size={13} />
                                Theme
                            </button>
                            <button
                                onClick={() => setActiveTab('font')}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all',
                                    activeTab === 'font'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                )}
                            >
                                <Type size={13} />
                                Font
                            </button>
                        </div>

                        {/* List Content */}
                        <div className="flex-1 min-h-0 overflow-y-auto p-2">
                            {activeTab === 'theme' && (
                                <div className="space-y-1">
                                    {TERMINAL_THEMES.map(renderThemeItem)}
                                </div>
                            )}
                            {activeTab === 'font' && (
                                <div className="space-y-1">
                                    {TERMINAL_FONTS.map(renderFontItem)}
                                </div>
                            )}
                        </div>

                        {/* Font Size Control (only in font tab) */}
                        {activeTab === 'font' && (
                            <div className="p-3 border-t border-border shrink-0">
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold">Font Size</div>
                                <div className="flex items-center justify-between gap-2 bg-muted/30 rounded-lg p-2">
                                    <button
                                        onClick={() => handleFontSizeChange(-1)}
                                        disabled={fontSize <= MIN_FONT_SIZE}
                                        className="w-8 h-8 rounded-md flex items-center justify-center bg-background hover:bg-accent text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-border"
                                    >
                                        <Minus size={14} />
                                    </button>
                                    <div className="flex items-baseline gap-1">
                                        <span className="text-xl font-bold text-foreground tabular-nums">{fontSize}</span>
                                        <span className="text-[10px] text-muted-foreground">px</span>
                                    </div>
                                    <button
                                        onClick={() => handleFontSizeChange(1)}
                                        disabled={fontSize >= MAX_FONT_SIZE}
                                        className="w-8 h-8 rounded-md flex items-center justify-center bg-background hover:bg-accent text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-border"
                                    >
                                        <Plus size={14} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Right Panel - Large Preview */}
                    <div className="flex-1 flex flex-col min-w-0 p-4">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3 font-semibold">Live Preview</div>
                        <div
                            className="flex-1 rounded-xl overflow-hidden border border-border flex flex-col"
                            style={{ backgroundColor: currentTheme.colors.background }}
                        >
                            {/* Fake title bar */}
                            <div
                                className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
                                style={{
                                    backgroundColor: currentTheme.colors.background,
                                    borderColor: `${currentTheme.colors.foreground}15`
                                }}
                            >
                                <div className="flex gap-1.5">
                                    <div className="w-3 h-3 rounded-full bg-red-500/80" />
                                    <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                                    <div className="w-3 h-3 rounded-full bg-green-500/80" />
                                </div>
                                <div
                                    className="flex-1 text-center text-xs"
                                    style={{ color: currentTheme.colors.foreground, opacity: 0.5, fontFamily: currentFont.family }}
                                >
                                    user@server — bash
                                </div>
                            </div>

                            {/* Terminal content */}
                            <div
                                className="flex-1 p-4 font-mono overflow-auto"
                                style={{
                                    color: currentTheme.colors.foreground,
                                    fontFamily: currentFont.family,
                                    fontSize: `${fontSize}px`,
                                    lineHeight: 1.5,
                                }}
                            >
                                <div className="space-y-1">
                                    <div>
                                        <span style={{ color: currentTheme.colors.green }}>user@server</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>:</span>
                                        <span style={{ color: currentTheme.colors.blue }}>~</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>$ </span>
                                        <span>neofetch</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {'       _,met$$$$$gg.          '}
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {'    ,g$$$$$$$$$$$$$$$P.       '}
                                        <span style={{ color: currentTheme.colors.foreground }}>user</span>
                                        <span style={{ color: currentTheme.colors.yellow }}>@</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>server</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {'  ,g$$P"     """Y$$.".        '}
                                        <span style={{ color: currentTheme.colors.foreground }}>-----------</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {' ,$$P\'              `$$$.     '}
                                        <span style={{ color: currentTheme.colors.blue }}>OS</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>: Ubuntu 22.04 LTS</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {'\',$$P       ,ggs.     `$$b:   '}
                                        <span style={{ color: currentTheme.colors.blue }}>Kernel</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>: 5.15.0-generic</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {'`d$$\'     ,$P"\'   .    $$$    '}
                                        <span style={{ color: currentTheme.colors.blue }}>Uptime</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>: 42 days, 3 hours</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {' $$P      d$\'     ,    $$P    '}
                                        <span style={{ color: currentTheme.colors.blue }}>Shell</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>: bash 5.1.16</span>
                                    </div>
                                    <div style={{ color: currentTheme.colors.cyan }}>
                                        {' $$:      $$.   -    ,d$$\'    '}
                                        <span style={{ color: currentTheme.colors.blue }}>Memory</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>: 4.2G / 16G (26%)</span>
                                    </div>
                                    <div>&nbsp;</div>
                                    <div>
                                        <span style={{ color: currentTheme.colors.green }}>user@server</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>:</span>
                                        <span style={{ color: currentTheme.colors.blue }}>~</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>$ </span>
                                        <span>ls -la</span>
                                    </div>
                                    <div>
                                        <span style={{ color: currentTheme.colors.blue }}>drwxr-xr-x</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>  5 user group </span>
                                        <span style={{ color: currentTheme.colors.yellow }}>4.0K</span>
                                        <span style={{ color: currentTheme.colors.foreground }}> Dec 12 10:30 </span>
                                        <span style={{ color: currentTheme.colors.blue }}>.config</span>
                                    </div>
                                    <div>
                                        <span style={{ color: currentTheme.colors.magenta }}>-rwxr-xr-x</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>  1 user group </span>
                                        <span style={{ color: currentTheme.colors.yellow }}>2.1K</span>
                                        <span style={{ color: currentTheme.colors.foreground }}> Dec 11 15:22 </span>
                                        <span style={{ color: currentTheme.colors.green }}>deploy.sh</span>
                                    </div>
                                    <div>
                                        <span style={{ color: currentTheme.colors.cyan }}>lrwxrwxrwx</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>  1 user group </span>
                                        <span style={{ color: currentTheme.colors.yellow }}>  24</span>
                                        <span style={{ color: currentTheme.colors.foreground }}> Dec 10 09:15 </span>
                                        <span style={{ color: currentTheme.colors.cyan }}>logs</span>
                                        <span style={{ color: currentTheme.colors.foreground }}> -{'>'} </span>
                                        <span style={{ color: currentTheme.colors.foreground }}>/var/log/app</span>
                                    </div>
                                    <div>&nbsp;</div>
                                    <div>
                                        <span style={{ color: currentTheme.colors.green }}>user@server</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>:</span>
                                        <span style={{ color: currentTheme.colors.blue }}>~</span>
                                        <span style={{ color: currentTheme.colors.foreground }}>$ </span>
                                        <span
                                            style={{
                                                backgroundColor: currentTheme.colors.cursor || currentTheme.colors.foreground,
                                                color: currentTheme.colors.background
                                            }}
                                        >▋</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Info line */}
                        <div className="mt-3 text-xs text-muted-foreground flex items-center justify-between">
                            <span>
                                {currentTheme.name} • {currentFont.name} • {fontSize}px
                            </span>
                            <span className="text-[10px] uppercase">
                                {currentTheme.type} theme
                            </span>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex gap-3 px-5 py-3 shrink-0 border-t border-border bg-muted/20">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        className="flex-1 h-10"
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSave}
                        className="flex-1 h-10"
                    >
                        Save & Apply
                    </Button>
                </div>
            </div>
        </div>
    );

    // Use Portal to render at document root
    return createPortal(modalContent, document.body);
};

export default ThemeCustomizeModal;
