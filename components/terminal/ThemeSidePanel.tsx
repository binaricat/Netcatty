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
      'w-full flex items-center gap-2.5 px-3 py-2 text-left group cursor-pointer'
    )}
    style={{ backgroundColor: isSelected ? 'var(--terminal-panel-active)' : 'transparent' }}
    onMouseEnter={(e) => {
      if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--terminal-panel-hover)';
    }}
    onMouseLeave={(e) => {
      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
    }}
  >
    {/* Color swatch */}
    <div
      className="h-6 w-8 rounded-[4px] flex-shrink-0 flex flex-col justify-center items-start pl-1 gap-0.5 border-[0.5px]"
      style={{ backgroundColor: theme.colors.background, borderColor: 'var(--terminal-panel-border)' }}
    >
      <div className="h-0.5 w-2.5 rounded-full" style={{ backgroundColor: theme.colors.green }} />
      <div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: theme.colors.blue }} />
      <div className="h-0.5 w-1.5 rounded-full" style={{ backgroundColor: theme.colors.yellow }} />
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-xs font-medium truncate">
        {theme.name}
      </div>
      <div className="text-[10px] capitalize" style={{ color: 'var(--terminal-panel-muted)' }}>
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
        className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
        style={{ color: 'var(--terminal-panel-muted)' }}
      >
        <Pencil size={10} />
      </div>
    )}
    {isSelected && !onEdit && (
      <Check size={12} className="flex-shrink-0" style={{ color: 'var(--terminal-panel-fg)' }} />
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
      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors'
    )}
    style={{ backgroundColor: isSelected ? 'var(--terminal-panel-active)' : 'transparent' }}
    onMouseEnter={(e) => {
      if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--terminal-panel-hover)';
    }}
    onMouseLeave={(e) => {
      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
    }}
  >
    <div className="flex-1 min-w-0">
      <div
        className="text-xs font-medium truncate"
        style={{ fontFamily: font.family }}
      >
        {font.name}
      </div>
      <div className="text-[10px] truncate" style={{ color: 'var(--terminal-panel-muted)' }}>{font.description}</div>
    </div>
    {isSelected && (
      <Check size={12} className="flex-shrink-0" style={{ color: 'var(--terminal-panel-fg)' }} />
    )}
  </button>
));
FontItem.displayName = 'FontItem';

interface ThemeSidePanelProps {
  currentThemeId: string;
  globalThemeId: string;
  currentFontFamilyId: string;
  globalFontFamilyId: string;
  currentFontSize: number;
  canResetTheme?: boolean;
  canResetFontFamily?: boolean;
  canResetFontSize?: boolean;
  onThemeChange: (themeId: string) => void;
  onThemeReset?: () => void;
  onFontFamilyChange: (fontFamilyId: string) => void;
  onFontFamilyReset?: () => void;
  onFontSizeChange: (fontSize: number) => void;
  onFontSizeReset?: () => void;
  isVisible?: boolean;
  previewColors?: {
    background: string;
    foreground: string;
  };
}

const ThemeSidePanelInner: React.FC<ThemeSidePanelProps> = ({
  currentThemeId,
  globalThemeId,
  currentFontFamilyId,
  globalFontFamilyId,
  currentFontSize,
  canResetTheme = false,
  canResetFontFamily = false,
  canResetFontSize = false,
  onThemeChange,
  onThemeReset,
  onFontFamilyChange,
  onFontFamilyReset,
  onFontSizeChange,
  onFontSizeReset,
  isVisible = true,
  previewColors,
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
  const globalTheme = useMemo(
    () => allThemes.find((theme) => theme.id === globalThemeId) || TERMINAL_THEMES[0],
    [allThemes, globalThemeId],
  );
  const globalFont = useMemo(
    () => availableFonts.find((font) => font.id === globalFontFamilyId) || availableFonts[0],
    [availableFonts, globalFontFamilyId],
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
  const panelVars = {
    ['--terminal-panel-bg' as never]: previewColors?.background ?? 'var(--background)',
    ['--terminal-panel-fg' as never]: previewColors?.foreground ?? 'var(--foreground)',
    ['--terminal-panel-muted' as never]: 'color-mix(in srgb, var(--terminal-panel-fg) 58%, var(--terminal-panel-bg) 42%)',
    ['--terminal-panel-border' as never]: 'color-mix(in srgb, var(--terminal-panel-fg) 12%, var(--terminal-panel-bg) 88%)',
    ['--terminal-panel-hover' as never]: 'color-mix(in srgb, var(--terminal-panel-fg) 12%, var(--terminal-panel-bg) 88%)',
    ['--terminal-panel-active' as never]: 'color-mix(in srgb, var(--terminal-panel-fg) 16%, var(--terminal-panel-bg) 84%)',
  } as React.CSSProperties;

  return (
    <>
      <div
        className="h-full flex flex-col overflow-hidden"
        style={{
          ...panelVars,
          backgroundColor: 'var(--terminal-panel-bg)',
          color: 'var(--terminal-panel-fg)',
          borderColor: 'var(--terminal-panel-border)',
        }}
      >
        {/* Tab Bar */}
        <div className="flex p-1.5 gap-0.5 shrink-0 border-b" style={{ borderColor: 'var(--terminal-panel-border)' }}>
          <button
            onClick={() => { setActiveTab('theme'); setEditingTheme(null); }}
            className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all"
            style={{
              backgroundColor: activeTab === 'theme' ? 'var(--terminal-panel-active)' : 'transparent',
              color: activeTab === 'theme' ? 'var(--terminal-panel-fg)' : 'var(--terminal-panel-muted)',
            }}
          >
            <Palette size={12} />
            {t('terminal.themeModal.tab.theme')}
          </button>
          <button
            onClick={() => setActiveTab('font')}
            className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all"
            style={{
              backgroundColor: activeTab === 'font' ? 'var(--terminal-panel-active)' : 'transparent',
              color: activeTab === 'font' ? 'var(--terminal-panel-fg)' : 'var(--terminal-panel-muted)',
            }}
          >
            <Type size={12} />
            {t('terminal.themeModal.tab.font')}
          </button>
          <button
            onClick={() => setActiveTab('custom')}
            className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all"
            style={{
              backgroundColor: activeTab === 'custom' ? 'var(--terminal-panel-active)' : 'transparent',
              color: activeTab === 'custom' ? 'var(--terminal-panel-fg)' : 'var(--terminal-panel-muted)',
            }}
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
                    <div className="text-[9px] uppercase tracking-wider mt-2 mb-1 px-1 font-semibold" style={{ color: 'var(--terminal-panel-muted)' }}>
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
                {canResetTheme && (
                  <>
                    <div className="text-[9px] uppercase tracking-wider mt-2 mb-1 px-1 font-semibold" style={{ color: 'var(--terminal-panel-muted)' }}>
                      {t('terminal.themeModal.globalTheme')}
                    </div>
                    <ThemeItem
                      theme={globalTheme}
                      isSelected={!canResetTheme}
                      onSelect={() => onThemeReset?.()}
                    />
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
                {canResetFontFamily && (
                  <>
                    <div className="text-[9px] uppercase tracking-wider mt-2 mb-1 px-1 font-semibold" style={{ color: 'var(--terminal-panel-muted)' }}>
                      {t('terminal.themeModal.globalFont')}
                    </div>
                    <FontItem
                      font={globalFont}
                      isSelected={!canResetFontFamily}
                      onSelect={() => onFontFamilyReset?.()}
                    />
                  </>
                )}
              </div>
            )}
            {activeTab === 'custom' && !editingTheme && (
              <div>
                <button
                  onClick={handleNewTheme}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--terminal-panel-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                    <div
                      className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: 'color-mix(in srgb, var(--terminal-panel-fg) 10%, transparent)',
                        color: 'var(--terminal-panel-fg)',
                      }}
                    >
                      <Plus size={12} />
                    </div>
                  <div>
                    <div className="text-xs font-medium">{t('terminal.customTheme.new')}</div>
                    <div className="text-[10px]" style={{ color: 'var(--terminal-panel-muted)' }}>{t('terminal.customTheme.newDesc')}</div>
                  </div>
                </button>
                <button
                  onClick={handleImportFile}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--terminal-panel-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <div className="w-6 h-6 rounded-md flex items-center justify-center bg-blue-500/10 text-blue-500 shrink-0">
                    <Download size={12} />
                  </div>
                  <div>
                    <div className="text-xs font-medium">{t('terminal.customTheme.import')}</div>
                    <div className="text-[10px]" style={{ color: 'var(--terminal-panel-muted)' }}>{t('terminal.customTheme.importDesc')}</div>
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
                    <div className="text-[9px] uppercase tracking-wider mt-2 mb-1 px-1 font-semibold" style={{ color: 'var(--terminal-panel-muted)' }}>
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
          <div className="p-2.5 border-t shrink-0" style={{ borderColor: 'var(--terminal-panel-border)' }}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'var(--terminal-panel-muted)' }}>
                {t('terminal.themeModal.fontSize')}
              </div>
              {canResetFontSize && (
                <button
                  onClick={onFontSizeReset}
                  className="text-[10px] font-medium hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--terminal-panel-fg)' }}
                >
                  {t('common.useGlobal')}
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg p-1.5" style={{ backgroundColor: 'var(--terminal-panel-hover)' }}>
              <button
                onClick={() => handleFontSizeChange(-1)}
                disabled={currentFontSize <= MIN_FONT_SIZE}
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed transition-colors border"
                style={{
                  backgroundColor: 'var(--terminal-panel-bg)',
                  color: 'var(--terminal-panel-fg)',
                  borderColor: 'var(--terminal-panel-border)',
                }}
              >
                <Minus size={12} />
              </button>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold tabular-nums">{currentFontSize}</span>
                <span className="text-[9px]" style={{ color: 'var(--terminal-panel-muted)' }}>px</span>
              </div>
              <button
                onClick={() => handleFontSizeChange(1)}
                disabled={currentFontSize >= MAX_FONT_SIZE}
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed transition-colors border"
                style={{
                  backgroundColor: 'var(--terminal-panel-bg)',
                  color: 'var(--terminal-panel-fg)',
                  borderColor: 'var(--terminal-panel-border)',
                }}
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
        )}

        {/* Current selection info */}
        <div className="px-2.5 py-1.5 border-t shrink-0" style={{ borderColor: 'var(--terminal-panel-border)' }}>
          <div className="text-[9px] truncate" style={{ color: 'var(--terminal-panel-muted)' }}>
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
