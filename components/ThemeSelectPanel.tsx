import React, { useMemo, useState } from 'react';
import { TERMINAL_THEMES } from '../infrastructure/config/terminalThemes';
import { useCustomThemes } from '../application/state/customThemeStore';
import { cn } from '../lib/utils';
import { TerminalTheme } from '../types';
import {
    AsidePanel,
    AsidePanelContent,
} from './ui/aside-panel';
import { ScrollArea } from './ui/scroll-area';

interface ThemeSelectPanelProps {
    open: boolean;
    selectedThemeId?: string;
    onSelect: (themeId: string) => void;
    onClose: () => void;
    onBack?: () => void;
    showBackButton?: boolean;
}

// Mini terminal preview component
const TerminalPreview: React.FC<{ theme: TerminalTheme; isSelected: boolean }> = ({
    theme,
    isSelected
}) => {
    return (
        <div
            className={cn(
                "w-16 h-10 rounded-md overflow-hidden border-2 flex-shrink-0",
                isSelected ? "border-primary" : "border-transparent"
            )}
            style={{ backgroundColor: theme.colors.background }}
        >
            <div className="p-1 text-[4px] font-mono leading-tight" style={{ color: theme.colors.foreground }}>
                <div>
                    <span style={{ color: theme.colors.green }}>$</span>{' '}
                    <span style={{ color: theme.colors.cyan }}>ls</span>
                </div>
                <div className="flex gap-0.5 flex-wrap">
                    <span style={{ color: theme.colors.blue }}>dir/</span>
                    <span style={{ color: theme.colors.green }}>file</span>
                </div>
                <div>
                    <span style={{ color: theme.colors.green }}>$</span>{' '}
                    <span
                        className="inline-block w-1 h-1.5"
                        style={{ backgroundColor: theme.colors.cursor }}
                    />
                </div>
            </div>
        </div>
    );
};

const ThemeSelectPanel: React.FC<ThemeSelectPanelProps> = ({
    open,
    selectedThemeId,
    onSelect,
    onClose,
    onBack,
    showBackButton = true,
}) => {
    // Reserved for future hover preview feature
    const [_hoveredThemeId, setHoveredThemeId] = useState<string | null>(null);

    const customThemes = useCustomThemes();

    // All themes combined
    const allThemes = useMemo(() => {
        return [...TERMINAL_THEMES, ...customThemes];
    }, [customThemes]);

    // Group themes by type - reserved for future sectioned view
    const _groupedThemes = useMemo(() => {
        const dark = allThemes.filter(t => t.type === 'dark');
        const light = allThemes.filter(t => t.type === 'light');
        return { dark, light };
    }, [allThemes]);

    // Find selected theme info - reserved for displaying selection details
    const _selectedTheme = useMemo(() => {
        return allThemes.find(t => t.id === selectedThemeId);
    }, [selectedThemeId, allThemes]);

    const renderThemeItem = (theme: TerminalTheme) => {
        const isSelected = theme.id === selectedThemeId;

        return (
            <button
                key={theme.id}
                className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left",
                    isSelected
                        ? "bg-primary/10"
                        : "hover:bg-secondary/50"
                )}
                onClick={() => onSelect(theme.id)}
                onMouseEnter={() => setHoveredThemeId(theme.id)}
                onMouseLeave={() => setHoveredThemeId(null)}
            >
                <TerminalPreview theme={theme} isSelected={isSelected} />
                <div className="flex-1 min-w-0">
                    <div className={cn(
                        "text-sm font-medium truncate",
                        isSelected && "text-primary"
                    )}>
                        {theme.name}
                    </div>
                    {theme.id === 'netcatty-dark' && (
                        <div className="text-xs text-muted-foreground">Default</div>
                    )}
                    {theme.id === 'netcatty-light' && (
                        <div className="text-xs text-muted-foreground">Light mode</div>
                    )}
                </div>
            </button>
        );
    };

    return (
        <AsidePanel
            open={open}
            onClose={onClose}
            title="Select Color Theme"
            showBackButton={showBackButton}
            onBack={onBack}
        >
            <AsidePanelContent className="p-0">
                <ScrollArea className="h-full">
                    <div className="py-2">
                        {/* All themes in a single list */}
                        {allThemes.map(renderThemeItem)}
                    </div>
                </ScrollArea>
            </AsidePanelContent>
        </AsidePanel>
    );
};

export default ThemeSelectPanel;
