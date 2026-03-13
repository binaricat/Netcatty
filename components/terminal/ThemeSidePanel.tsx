/**
 * ThemeSidePanel - Theme/Font customization panel for the terminal side panel
 *
 * Adapted from ThemeCustomizeModal's left panel content.
 * No preview - the actual terminal behind serves as a live preview.
 * Changes apply in real-time.
 */

import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Check, Download, Minus, Palette, Pencil, Plus, Sparkles, Type } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useAvailableFonts } from '../../application/state/fontStore';
import { TERMINAL_THEMES, TerminalThemeConfig } from '../../infrastructure/config/terminalThemes';
import { MIN_FONT_SIZE, MAX_FONT_SIZE, TerminalFont } from '../../infrastructure/config/fonts';
import { useCustomThemes, useCustomThemeActions } from '../../application/state/customThemeStore';
import { parseItermcolors } from '../../infrastructure/parsers/itermcolorsParser';
import { CustomThemeModal } from './CustomThemeModal';
import { cn } from '../../lib/utils';
import { TerminalTheme } from '../../domain/models';
import { ScrollArea } from '../ui/scroll-area';

type TabType = 'theme' | 'font' | 'custom';

// Memoized theme item component
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
      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors group cursor-pointer',
      isSelected
        ? 'bg-accent/50'
        : 'hover:bg-accent/50'
    )}
  >
    {/* Color swatch */}
    <div
      className="w-6 h-6 rounded-md flex-shrink-0 flex flex-col justify-center items-start pl-0.5 gap-0.5 border border-border/50"
      style={{ backgroundColor: theme.colors.background }}
    >
      <div className="h-0.5 w-2.5 rounded-full" style={{ backgroundColor: theme.colors.green }} />
      <div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: theme.colors.blue }} />
      <div className="h-0.5 w-1.5 rounded-full" style={{ backgroundColor: theme.colors.yellow }} />
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-xs font-medium truncate">
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
        className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/80 opacity-0 group-hover:opacity-100 transition-all"
      >
        <Pencil size={10} />
      </div>
    )}
    {isSelected && !onEdit && (
      <Check size={12} className="text-primary flex-shrink-0" />
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
      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
      isSelected
        ? 'bg-accent/50'
        : 'hover:bg-accent/50'
    )}
  >
    <div className="flex-1 min-w-0">
      <div
        className="text-xs font-medium truncate"
        style={{ fontFamily: font.family }}
      >
        {font.name}
      </div>
      <div className="text-[10px] text-muted-foreground truncate">{font.description}</div>
    </div>
    {isSelected && (
      <Check size={12} className="text-primary flex-shrink-0" />
    )}
  </button>
));
FontItem.displayName = 'FontItem';

interface ThemeSidePanelProps {
  currentThemeId: string;
  currentFontFamilyId: string;
  currentFontSize: number;
  onThemeChange: (themeId: string) => void;
  onFontFamilyChange: (fontFamilyId: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  isVisible?: boolean;
}

const ThemeSidePanelInner: React.FC<ThemeSidePanelProps> = ({
  currentThemeId,
  currentFontFamilyId,
  currentFontSize,
  onThemeChange,
  onFontFamilyChange,
  onFontSizeChange,
  isVisible = true,
}) => {
  const { t } = useI18n();
  const availableFonts = useAvailableFonts();
  const customThemes = useCustomThemes();
  const { addTheme, updateTheme, deleteTheme } = useCustomThemeActions();

  const [activeTab, setActiveTab] = useState<TabType>('theme');
  const [editingTheme, setEditingTheme] = useState<TerminalTheme | null>(null);
  const [isNewTheme, setIsNewTheme] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allThemes = useMemo(
    () => [...TERMINAL_THEMES, ...customThemes],
    [customThemes]
  );

  const handleThemeSelect = useCallback((themeId: string) => {
    setEditingTheme(null);
    onThemeChange(themeId);
  }, [onThemeChange]);

  const handleFontSelect = useCallback((fontId: string) => {
    onFontFamilyChange(fontId);
  }, [onFontFamilyChange]);

  const handleFontSizeChange = useCallback((delta: number) => {
    const newSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, currentFontSize + delta));
    onFontSizeChange(newSize);
  }, [currentFontSize, onFontSizeChange]);

  const handleNewTheme = useCallback(() => {
    const base = allThemes.find(t => t.id === currentThemeId) || TERMINAL_THEMES[0];
    const newTheme: TerminalTheme = {
      ...base,
      id: `custom-${Date.now()}`,
      name: `${base.name} (Custom)`,
      isCustom: true,
      colors: { ...base.colors },
    };
    setEditingTheme(newTheme);
    setIsNewTheme(true);
  }, [currentThemeId, allThemes]);

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
        onThemeChange(parsed.id);
        setActiveTab('theme');
      } else {
        window.alert(t('terminal.customTheme.importError') || 'Failed to parse the selected file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [addTheme, onThemeChange, t]);

  const handleEditTheme = useCallback((themeId: string) => {
    const theme = customThemes.find(t => t.id === themeId);
    if (theme) {
      setEditingTheme({ ...theme, colors: { ...theme.colors } });
      setIsNewTheme(false);
    }
  }, [customThemes]);

  const handleEditorDelete = useCallback((themeId: string) => {
    deleteTheme(themeId);
    if (currentThemeId === themeId) {
      onThemeChange(TERMINAL_THEMES[0].id);
    }
    setEditingTheme(null);
    setIsNewTheme(false);
  }, [deleteTheme, currentThemeId, onThemeChange]);

  if (!isVisible) return null;

  const builtinThemes = TERMINAL_THEMES;

  return (
    <>
      <div className="h-full flex flex-col bg-background overflow-hidden">
        {/* Tab Bar */}
        <div className="flex p-1.5 gap-0.5 shrink-0 border-b border-border/50">
          <button
            onClick={() => { setActiveTab('theme'); setEditingTheme(null); }}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all',
              activeTab === 'theme'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
          >
            <Palette size={12} />
            {t('terminal.themeModal.tab.theme')}
          </button>
          <button
            onClick={() => setActiveTab('font')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all',
              activeTab === 'font'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
          >
            <Type size={12} />
            {t('terminal.themeModal.tab.font')}
          </button>
          <button
            onClick={() => setActiveTab('custom')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all',
              activeTab === 'custom'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
          >
            <Sparkles size={12} />
            {t('terminal.themeModal.tab.custom')}
          </button>
        </div>

        {/* List Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="py-1">
            {activeTab === 'theme' && (
              <div>
                {builtinThemes.map(theme => (
                  <ThemeItem
                    key={theme.id}
                    theme={theme}
                    isSelected={currentThemeId === theme.id && !editingTheme}
                    onSelect={handleThemeSelect}
                  />
                ))}
                {customThemes.length > 0 && (
                  <>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-2 mb-1 px-1 font-semibold">
                      {t('terminal.customTheme.section')}
                    </div>
                    {customThemes.map(theme => (
                      <ThemeItem
                        key={theme.id}
                        theme={theme}
                        isSelected={currentThemeId === theme.id && !editingTheme}
                        onSelect={handleThemeSelect}
                        onEdit={handleEditTheme}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
            {activeTab === 'font' && (
              <div>
                {availableFonts.map(font => (
                  <FontItem
                    key={font.id}
                    font={font}
                    isSelected={currentFontFamilyId === font.id}
                    onSelect={handleFontSelect}
                  />
                ))}
              </div>
            )}
            {activeTab === 'custom' && !editingTheme && (
              <div>
                <button
                  onClick={handleNewTheme}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                >
                  <div className="w-6 h-6 rounded-md flex items-center justify-center bg-primary/10 text-primary shrink-0">
                    <Plus size={12} />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-foreground">{t('terminal.customTheme.new')}</div>
                    <div className="text-[10px] text-muted-foreground">{t('terminal.customTheme.newDesc')}</div>
                  </div>
                </button>
                <button
                  onClick={handleImportFile}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                >
                  <div className="w-6 h-6 rounded-md flex items-center justify-center bg-blue-500/10 text-blue-500 shrink-0">
                    <Download size={12} />
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
                {customThemes.length > 0 && (
                  <>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-2 mb-1 px-1 font-semibold">
                      {t('terminal.customTheme.yourThemes')}
                    </div>
                    {customThemes.map(theme => (
                      <ThemeItem
                        key={theme.id}
                        theme={theme}
                        isSelected={currentThemeId === theme.id}
                        onSelect={handleThemeSelect}
                        onEdit={handleEditTheme}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Font Size Control (only in font tab) */}
        {activeTab === 'font' && (
          <div className="p-2.5 border-t border-border/50 shrink-0">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
              {t('terminal.themeModal.fontSize')}
            </div>
            <div className="flex items-center justify-between gap-2 bg-muted/30 rounded-lg p-1.5">
              <button
                onClick={() => handleFontSizeChange(-1)}
                disabled={currentFontSize <= MIN_FONT_SIZE}
                className="w-7 h-7 rounded-md flex items-center justify-center bg-background hover:bg-accent text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-border"
              >
                <Minus size={12} />
              </button>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold text-foreground tabular-nums">{currentFontSize}</span>
                <span className="text-[9px] text-muted-foreground">px</span>
              </div>
              <button
                onClick={() => handleFontSizeChange(1)}
                disabled={currentFontSize >= MAX_FONT_SIZE}
                className="w-7 h-7 rounded-md flex items-center justify-center bg-background hover:bg-accent text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-border"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
        )}

        {/* Current selection info */}
        <div className="px-2.5 py-1.5 border-t border-border/50 shrink-0">
          <div className="text-[9px] text-muted-foreground truncate">
            {allThemes.find(t => t.id === currentThemeId)?.name ?? currentThemeId} • {availableFonts.find(f => f.id === currentFontFamilyId)?.name ?? currentFontFamilyId} • {currentFontSize}px
          </div>
        </div>
      </div>

      {/* Custom Theme Editor Modal */}
      {editingTheme && (
        <CustomThemeModal
          open={!!editingTheme}
          theme={editingTheme}
          isNew={isNewTheme}
          onSave={(theme) => {
            if (isNewTheme) {
              addTheme(theme);
              onThemeChange(theme.id);
            } else {
              updateTheme(theme.id, theme);
              if (currentThemeId === theme.id) {
                onThemeChange(theme.id);
              }
            }
            setEditingTheme(null);
            setIsNewTheme(false);
          }}
          onDelete={isNewTheme ? undefined : handleEditorDelete}
          onCancel={() => { setEditingTheme(null); setIsNewTheme(false); }}
        />
      )}
    </>
  );
};

export const ThemeSidePanel = memo(ThemeSidePanelInner);
ThemeSidePanel.displayName = 'ThemeSidePanel';
