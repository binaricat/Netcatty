/**
 * Terminal Theme Customize Modal
 * Left-right split design: list on left, large preview on right
 * Uses React Portal to render at document root for proper z-index
 *
 * Features:
 * - Real-time preview: changes are applied immediately to the terminal
 * - Save: persists the current settings
 * - Cancel: reverts to the original settings when modal was opened
 * - Custom themes: create, edit, delete, import .itermcolors
 */

import React, { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { Check, Download, Minus, Palette, Pencil, Plus, Sparkles, Type, X } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useAvailableFonts } from '../../application/state/fontStore';
import { TERMINAL_THEMES, TerminalThemeConfig } from '../../infrastructure/config/terminalThemes';
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, TerminalFont } from '../../infrastructure/config/fonts';
import { useCustomThemes, useCustomThemeActions } from '../../application/state/customThemeStore';
import { parseItermcolors } from '../../infrastructure/parsers/itermcolorsParser';
import { CustomThemeModal } from './CustomThemeModal';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { TerminalTheme } from '../../domain/models';

type TabType = 'theme' | 'font' | 'custom';

// Memoized theme item component to prevent unnecessary re-renders
const ThemeItem = memo(({
    theme,
    isSelected,
    onSelect,
    onEdit,
}: {
    theme: TerminalThemeConfig;
    isSelected: boolean;
    onSelect: (id: string) => void;
    onEdit?: (id: string) => void;
}) => (
    <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(theme.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(theme.id); } }}
        className={cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all group cursor-pointer',
            isSelected
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
            <div className={cn('text-xs font-medium truncate', isSelected ? 'text-primary' : 'text-foreground')}>
                {theme.name}
            </div>
            <div className="text-[10px] text-muted-foreground capitalize">
                {theme.type}
                {theme.isCustom && ' • custom'}
            </div>
        </div>
        {onEdit && (
            <div
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onEdit(theme.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onEdit(theme.id); } }}
                className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/80 opacity-0 group-hover:opacity-100 transition-all"
            >
                <Pencil size={11} />
            </div>
        )}
        {isSelected && !onEdit && (
            <Check size={14} className="text-primary flex-shrink-0" />
        )}
    </div>
));
ThemeItem.displayName = 'ThemeItem';

// Memoized font item component
const FontItem = memo(({
    font,
    isSelected,
    onSelect
}: {
    font: TerminalFont;
    isSelected: boolean;
    onSelect: (id: string) => void;
}) => (
    <button
        onClick={() => onSelect(font.id)}
        className={cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all',
            isSelected
                ? 'bg-primary/15 ring-1 ring-primary'
                : 'hover:bg-muted'
        )}
    >
        <div className="flex-1 min-w-0">
            <div
                className={cn('text-sm truncate', isSelected ? 'text-primary' : 'text-foreground')}
                style={{ fontFamily: font.family }}
            >
                {font.name}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">{font.description}</div>
        </div>
        {isSelected && (
            <Check size={14} className="text-primary flex-shrink-0" />
        )}
    </button>
));
FontItem.displayName = 'FontItem';

interface ThemeCustomizeModalProps {
    open: boolean;
    onClose: () => void;
    currentThemeId?: string;
    currentFontFamilyId?: string;
    currentFontSize?: number;
    /** Called immediately when user selects a theme (for real-time preview) */
    onThemeChange?: (themeId: string) => void;
    /** Called immediately when user selects a font (for real-time preview) */
    onFontFamilyChange?: (fontFamilyId: string) => void;
    /** Called immediately when user changes font size (for real-time preview) */
    onFontSizeChange?: (fontSize: number) => void;
    /** Called when user clicks Save to persist settings */
    onSave?: () => void;
}

// Memoized preview component to avoid re-rendering on every state change
const TerminalPreview = memo(({
    theme,
    font,
    fontSize
}: {
    theme: TerminalThemeConfig;
    font: TerminalFont;
    fontSize: number;
}) => (
    <div
        className="flex-1 rounded-xl overflow-hidden border border-border flex flex-col"
        style={{ backgroundColor: theme.colors.background }}
    >
        {/* Fake title bar */}
        <div
            className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
            style={{
                backgroundColor: theme.colors.background,
                borderColor: `${theme.colors.foreground}15`
            }}
        >
            <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
            </div>
            <div
                className="flex-1 text-center text-xs"
                style={{ color: theme.colors.foreground, opacity: 0.5, fontFamily: font.family }}
            >
                user@server — bash
            </div>
        </div>

        {/* Terminal content */}
        <div
            className="flex-1 p-4 font-mono overflow-auto"
            style={{
                color: theme.colors.foreground,
                fontFamily: font.family,
                fontSize: `${fontSize}px`,
                lineHeight: 1.5,
            }}
        >
            <div className="space-y-1">
                <div>
                    <span style={{ color: theme.colors.green }}>user@server</span>
                    <span style={{ color: theme.colors.foreground }}>:</span>
                    <span style={{ color: theme.colors.blue }}>~</span>
                    <span style={{ color: theme.colors.foreground }}>$ </span>
                    <span>neofetch</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {'       _,met$$$$$gg.          '}
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {'    ,g$$$$$$$$$$$$$$$P.       '}
                    <span style={{ color: theme.colors.foreground }}>user</span>
                    <span style={{ color: theme.colors.yellow }}>@</span>
                    <span style={{ color: theme.colors.foreground }}>server</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {'  ,g$$P"     """Y$$."".        '}
                    <span style={{ color: theme.colors.foreground }}>-----------</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {` ,$$P'              $$$.     `}
                    <span style={{ color: theme.colors.blue }}>OS</span>
                    <span style={{ color: theme.colors.foreground }}>: Ubuntu 22.04 LTS</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {`'', $$P, ggs.     $$b:   `}
                    <span style={{ color: theme.colors.blue }}>Kernel</span>
                    <span style={{ color: theme.colors.foreground }}>: 5.15.0-generic</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {`d$$'     ,$P"'   .    $$$    `}
                    <span style={{ color: theme.colors.blue }}>Uptime</span>
                    <span style={{ color: theme.colors.foreground }}>: 42 days, 3 hours</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {` $$P      d$'     ,    $$P    `}
                    <span style={{ color: theme.colors.blue }}>Shell</span>
                    <span style={{ color: theme.colors.foreground }}>: bash 5.1.16</span>
                </div>
                <div style={{ color: theme.colors.cyan }}>
                    {` $$:      $$.   -    ,d$$'    `}
                    <span style={{ color: theme.colors.blue }}>Memory</span>
                    <span style={{ color: theme.colors.foreground }}>: 4.2G / 16G (26%)</span>
                </div>
                <div>&nbsp;</div>
                {/* ANSI color palette preview row */}
                <div className="flex gap-0.5 mt-1">
                    {[theme.colors.black, theme.colors.red, theme.colors.green, theme.colors.yellow,
                    theme.colors.blue, theme.colors.magenta, theme.colors.cyan, theme.colors.white].map((c, i) => (
                        <div key={i} className="w-4 h-3 rounded-sm" style={{ backgroundColor: c }} />
                    ))}
                </div>
                <div className="flex gap-0.5">
                    {[theme.colors.brightBlack, theme.colors.brightRed, theme.colors.brightGreen, theme.colors.brightYellow,
                    theme.colors.brightBlue, theme.colors.brightMagenta, theme.colors.brightCyan, theme.colors.brightWhite].map((c, i) => (
                        <div key={i} className="w-4 h-3 rounded-sm" style={{ backgroundColor: c }} />
                    ))}
                </div>
                <div>&nbsp;</div>
                <div>
                    <span style={{ color: theme.colors.green }}>user@server</span>
                    <span style={{ color: theme.colors.foreground }}>:</span>
                    <span style={{ color: theme.colors.blue }}>~</span>
                    <span style={{ color: theme.colors.foreground }}>$ </span>
                    <span
                        style={{
                            backgroundColor: theme.colors.cursor || theme.colors.foreground,
                            color: theme.colors.background
                        }}
                    >▋</span>
                </div>
            </div>
        </div>
    </div>
));
TerminalPreview.displayName = 'TerminalPreview';

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
    const { t } = useI18n();
    const availableFonts = useAvailableFonts();
    const customThemes = useCustomThemes();
    const { addTheme, updateTheme, deleteTheme } = useCustomThemeActions();

    const [activeTab, setActiveTab] = useState<TabType>('theme');
    const [selectedTheme, setSelectedTheme] = useState(currentThemeId);
    const [selectedFont, setSelectedFont] = useState(currentFontFamilyId);
    const [fontSize, setFontSize] = useState(currentFontSize);

    // Custom theme editor state
    const [editingTheme, setEditingTheme] = useState<TerminalTheme | null>(null);
    const [isNewTheme, setIsNewTheme] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Store original values when modal opens (for cancel/revert)
    const originalValuesRef = useRef({
        theme: currentThemeId,
        font: currentFontFamilyId,
        fontSize: currentFontSize,
    });

    // Combine built-in + custom themes
    const allThemes = useMemo(
        () => [...TERMINAL_THEMES, ...customThemes],
        [customThemes]
    );

    // Sync state when modal opens
    useEffect(() => {
        if (open) {
            // Store original values for potential cancel
            originalValuesRef.current = {
                theme: currentThemeId,
                font: currentFontFamilyId,
                fontSize: currentFontSize,
            };
            // Initialize selected values
            setSelectedTheme(currentThemeId);
            setSelectedFont(currentFontFamilyId);
            setFontSize(currentFontSize);
            setEditingTheme(null);
            setIsNewTheme(false);
        }
    }, [open, currentThemeId, currentFontFamilyId, currentFontSize]);

    const currentFont = useMemo(
        (): TerminalFont => availableFonts.find(f => f.id === selectedFont) || availableFonts[0],
        [selectedFont, availableFonts]
    );
    const currentTheme = useMemo(
        () => editingTheme || allThemes.find(t => t.id === selectedTheme) || TERMINAL_THEMES[0],
        [selectedTheme, allThemes, editingTheme]
    );

    // Handle theme selection - apply immediately for real-time preview
    const handleThemeSelect = useCallback((themeId: string) => {
        setSelectedTheme(themeId);
        setEditingTheme(null);
        onThemeChange?.(themeId); // Apply immediately
    }, [onThemeChange]);

    // Handle font selection - apply immediately for real-time preview
    const handleFontSelect = useCallback((fontId: string) => {
        setSelectedFont(fontId);
        onFontFamilyChange?.(fontId); // Apply immediately
    }, [onFontFamilyChange]);

    // Handle font size change - apply immediately for real-time preview
    const handleFontSizeChange = useCallback((delta: number) => {
        setFontSize(prev => {
            const newSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev + delta));
            onFontSizeChange?.(newSize); // Apply immediately
            return newSize;
        });
    }, [onFontSizeChange]);

    // ---- Custom Theme Actions ----

    const handleNewTheme = useCallback(() => {
        // Clone current theme as starting point
        const base = allThemes.find(t => t.id === selectedTheme) || TERMINAL_THEMES[0];
        const newTheme: TerminalTheme = {
            ...base,
            id: `custom-${Date.now()}`,
            name: `${base.name} (Custom)`,
            isCustom: true,
            colors: { ...base.colors },
        };
        setEditingTheme(newTheme);
        setIsNewTheme(true);
    }, [selectedTheme, allThemes]);

    const handleImportFile = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const name = file.name.replace(/\.(itermcolors|xml)$/i, '');
        const reader = new FileReader();
        reader.onload = () => {
            const xml = reader.result as string;
            const parsed = parseItermcolors(xml, name);
            if (parsed) {
                addTheme(parsed);
                setSelectedTheme(parsed.id);
                onThemeChange?.(parsed.id);
                setActiveTab('theme');
            } else {
                console.error('[ThemeCustomize] Failed to parse .itermcolors file:', file.name);
                window.alert(t('terminal.customTheme.importError') || 'Failed to parse the selected file. Please ensure it is a valid .itermcolors XML file.');
            }
        };
        reader.onerror = () => {
            console.error('[ThemeCustomize] Failed to read file:', file.name, reader.error);
        };
        reader.readAsText(file);
        // Reset file input so the same file can be re-imported
        e.target.value = '';
    }, [addTheme, onThemeChange, t]);

    const handleEditTheme = useCallback((themeId: string) => {
        const theme = customThemes.find(t => t.id === themeId);
        if (theme) {
            setEditingTheme({ ...theme, colors: { ...theme.colors } });
            setIsNewTheme(false);
            setActiveTab('custom');
        }
    }, [customThemes]);


    const handleEditorBack = useCallback(() => {
        setEditingTheme(null);
        setIsNewTheme(false);
    }, []);

    const handleEditorDelete = useCallback((themeId: string) => {
        deleteTheme(themeId);
        if (selectedTheme === themeId) {
            setSelectedTheme(TERMINAL_THEMES[0].id);
            onThemeChange?.(TERMINAL_THEMES[0].id);
        }
        setEditingTheme(null);
        setIsNewTheme(false);
    }, [deleteTheme, selectedTheme, onThemeChange]);

    // Save: just close (changes are already applied)
    const handleSave = useCallback(() => {
        // If editing a custom theme, save it first
        if (editingTheme) {
            if (isNewTheme) {
                addTheme(editingTheme);
                setSelectedTheme(editingTheme.id);
                onThemeChange?.(editingTheme.id);
            } else {
                updateTheme(editingTheme.id, editingTheme);
            }
        }
        onSave?.();
        onClose();
    }, [editingTheme, isNewTheme, addTheme, updateTheme, onSave, onClose, onThemeChange]);

    // Cancel: revert to original values
    const handleCancel = useCallback(() => {
        const original = originalValuesRef.current;
        // Revert all changes
        onThemeChange?.(original.theme);
        onFontFamilyChange?.(original.font);
        onFontSizeChange?.(original.fontSize);
        onClose();
    }, [onThemeChange, onFontFamilyChange, onFontSizeChange, onClose]);

    // Handle ESC key - same as cancel, but skip when child editor is open
    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !editingTheme) handleCancel();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, handleCancel, editingTheme]);

    // Handle backdrop click - same as cancel
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) handleCancel();
    }, [handleCancel]);

    if (!open) return null;

    // Separate built-in and custom themes for display in the theme list
    const builtinThemes = TERMINAL_THEMES;

    const modalContent = (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
            onClick={handleBackdropClick}
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
                        <h2 className="text-sm font-semibold text-foreground">{t('terminal.themeModal.title')}</h2>
                    </div>
                    <button
                        onClick={handleCancel}
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
                                onClick={() => { setActiveTab('theme'); setEditingTheme(null); }}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition-all',
                                    activeTab === 'theme'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                )}
                            >
                                <Palette size={13} />
                                {t('terminal.themeModal.tab.theme')}
                            </button>
                            <button
                                onClick={() => setActiveTab('font')}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition-all',
                                    activeTab === 'font'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                )}
                            >
                                <Type size={13} />
                                {t('terminal.themeModal.tab.font')}
                            </button>
                            <button
                                onClick={() => setActiveTab('custom')}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs font-medium transition-all',
                                    activeTab === 'custom'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                )}
                            >
                                <Sparkles size={13} />
                                {t('terminal.themeModal.tab.custom')}
                            </button>
                        </div>

                        {/* List Content */}
                        <>
                            <div className="flex-1 min-h-0 overflow-y-auto p-2">
                                {activeTab === 'theme' && (
                                    <div className="space-y-1">
                                        {/* Built-in themes */}
                                        {builtinThemes.map(theme => (
                                            <ThemeItem
                                                key={theme.id}
                                                theme={theme}
                                                isSelected={selectedTheme === theme.id && !editingTheme}
                                                onSelect={handleThemeSelect}
                                            />
                                        ))}
                                        {/* Custom themes section */}
                                        {customThemes.length > 0 && (
                                            <>
                                                <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-3 mb-1.5 px-1 font-semibold">
                                                    {t('terminal.customTheme.section')}
                                                </div>
                                                {customThemes.map(theme => (
                                                    <ThemeItem
                                                        key={theme.id}
                                                        theme={theme}
                                                        isSelected={selectedTheme === theme.id && !editingTheme}
                                                        onSelect={handleThemeSelect}
                                                        onEdit={handleEditTheme}
                                                    />
                                                ))}
                                            </>
                                        )}
                                    </div>
                                )}
                                {activeTab === 'font' && (
                                    <div className="space-y-1">
                                        {availableFonts.map(font => (
                                            <FontItem
                                                key={font.id}
                                                font={font}
                                                isSelected={selectedFont === font.id}
                                                onSelect={handleFontSelect}
                                            />
                                        ))}
                                    </div>
                                )}
                                {activeTab === 'custom' && !editingTheme && (
                                    <div className="space-y-2">
                                        {/* Actions */}
                                        <button
                                            onClick={handleNewTheme}
                                            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left hover:bg-muted transition-colors"
                                        >
                                            <div className="w-8 h-8 rounded-md flex items-center justify-center bg-primary/10 text-primary">
                                                <Plus size={16} />
                                            </div>
                                            <div>
                                                <div className="text-xs font-medium text-foreground">{t('terminal.customTheme.new')}</div>
                                                <div className="text-[10px] text-muted-foreground">{t('terminal.customTheme.newDesc')}</div>
                                            </div>
                                        </button>
                                        <button
                                            onClick={handleImportFile}
                                            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left hover:bg-muted transition-colors"
                                        >
                                            <div className="w-8 h-8 rounded-md flex items-center justify-center bg-blue-500/10 text-blue-500">
                                                <Download size={16} />
                                            </div>
                                            <div>
                                                <div className="text-xs font-medium text-foreground">{t('terminal.customTheme.import')}</div>
                                                <div className="text-[10px] text-muted-foreground">{t('terminal.customTheme.importDesc')}</div>
                                            </div>
                                        </button>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".itermcolors"
                                            onChange={handleFileSelected}
                                            className="hidden"
                                        />

                                        {/* Custom themes list */}
                                        {customThemes.length > 0 && (
                                            <>
                                                <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-3 mb-1 px-1 font-semibold">
                                                    {t('terminal.customTheme.yourThemes')}
                                                </div>
                                                {customThemes.map(theme => (
                                                    <ThemeItem
                                                        key={theme.id}
                                                        theme={theme}
                                                        isSelected={selectedTheme === theme.id}
                                                        onSelect={handleThemeSelect}
                                                        onEdit={handleEditTheme}
                                                    />
                                                ))}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Font Size Control (only in font tab) */}
                            {activeTab === 'font' && (
                                <div className="p-3 border-t border-border shrink-0">
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold">
                                        {t('terminal.themeModal.fontSize')}
                                    </div>
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
                        </>
                    </div>

                    {/* Right Panel - Large Preview */}
                    <div className="flex-1 flex flex-col min-w-0 p-4">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                            {t('terminal.themeModal.livePreview')}
                        </div>
                        <TerminalPreview theme={currentTheme} font={currentFont} fontSize={fontSize} />

                        {/* Info line */}
                        <div className="mt-3 text-xs text-muted-foreground flex items-center justify-between">
                            <span>
                                {currentTheme.name} • {currentFont.name} • {fontSize}px
                            </span>
                            <span className="text-[10px] uppercase">
                                {t('terminal.themeModal.themeType', { type: currentTheme.type })}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex gap-3 px-5 py-3 shrink-0 border-t border-border bg-muted/20">
                    <Button
                        variant="ghost"
                        onClick={handleCancel}
                        className="flex-1 h-10"
                    >
                        {t('common.cancel')}
                    </Button>
                    <Button
                        onClick={handleSave}
                        className="flex-1 h-10"
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </div>
        </div>
    );

    // Use Portal to render at document root
    return (
        <>
            {createPortal(modalContent, document.body)}
            {editingTheme && (
                <CustomThemeModal
                    open={!!editingTheme}
                    theme={editingTheme}
                    isNew={isNewTheme}
                    onSave={(theme) => {
                        if (isNewTheme) {
                            addTheme(theme);
                            setSelectedTheme(theme.id);
                            onThemeChange?.(theme.id);
                        } else {
                            updateTheme(theme.id, theme);
                            if (selectedTheme === theme.id) {
                                onThemeChange?.(theme.id);
                            }
                        }
                        setEditingTheme(null);
                        setIsNewTheme(false);
                    }}
                    onDelete={isNewTheme ? undefined : handleEditorDelete}
                    onCancel={handleEditorBack}
                />
            )}
        </>
    );
};

export default ThemeCustomizeModal;
