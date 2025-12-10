import React, { useState, useMemo } from 'react';
import { Users } from 'lucide-react';
import { TerminalTheme } from '../types';
import { TERMINAL_THEMES } from '../infrastructure/config/terminalThemes';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';
import {
  AsidePanel,
  AsidePanelContent,
} from './ui/aside-panel';

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
  const [hoveredThemeId, setHoveredThemeId] = useState<string | null>(null);

  // Group themes by type
  const groupedThemes = useMemo(() => {
    const dark = TERMINAL_THEMES.filter(t => t.type === 'dark');
    const light = TERMINAL_THEMES.filter(t => t.type === 'light');
    return { dark, light };
  }, []);

  // Find selected theme info
  const selectedTheme = useMemo(() => {
    return TERMINAL_THEMES.find(t => t.id === selectedThemeId);
  }, [selectedThemeId]);

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
          {/* Show usage stats or badge */}
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {theme.id === 'termius-dark' && (
              <span className="text-muted-foreground">∞</span>
            )}
            {theme.id === 'termius-light' && (
              <>
                <Users size={10} />
                <span>34561</span>
              </>
            )}
            {theme.id === 'flexoki-dark' && (
              <span className="text-xs">new</span>
            )}
            {theme.id === 'flexoki-light' && (
              <span className="text-xs">new</span>
            )}
            {theme.id.startsWith('kanagawa') && (
              <>
                <Users size={10} />
                <span>{Math.floor(Math.random() * 20000)}</span>
              </>
            )}
            {theme.id.startsWith('hacker') && (
              <>
                <Users size={10} />
                <span>{Math.floor(Math.random() * 15000)}</span>
              </>
            )}
          </div>
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
            {TERMINAL_THEMES.map(renderThemeItem)}
          </div>
        </ScrollArea>
      </AsidePanelContent>
    </AsidePanel>
  );
};

export default ThemeSelectPanel;
