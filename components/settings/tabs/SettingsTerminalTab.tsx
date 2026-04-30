import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { AlertCircle, ChevronRight, Import, Minus, Palette, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type {
  CursorShape,
  LinkModifier,
  RightClickBehavior,
  TerminalEmulationType,
  TerminalSettings,
} from "../../../domain/models";
import { DEFAULT_KEYWORD_HIGHLIGHT_RULES, type KeywordHighlightRule } from "../../../domain/models";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type TerminalFont } from "../../../infrastructure/config/fonts";
import { TERMINAL_THEMES } from "../../../infrastructure/config/terminalThemes";
import { customThemeStore, useCustomThemes } from "../../../application/state/customThemeStore";
import { parseItermcolors } from "../../../infrastructure/parsers/itermcolorsParser";
import { cn } from "../../../lib/utils";
import { useDiscoveredShells } from "../../../lib/useDiscoveredShells";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { SectionHeader, Select, SettingsTabContent, SettingRow, Toggle } from "../settings-ui";
import { ThemeSelectModal } from "../ThemeSelectModal";
import { TerminalFontSelect } from "../TerminalFontSelect";
import { CustomThemeModal } from "../../terminal/CustomThemeModal";
import type { TerminalTheme } from "../../../domain/models";

// Keyword highlight rules editor for global settings
const DEFAULT_NEW_RULE_COLOR = '#F87171';

const AddCustomRuleDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editRule?: KeywordHighlightRule | null;
  onAdd: (rule: KeywordHighlightRule) => void;
}> = ({ open, onOpenChange, editRule, onAdd }) => {
  const { t } = useI18n();
  const [label, setLabel] = useState('');
  const [pattern, setPattern] = useState('');
  const [color, setColor] = useState(DEFAULT_NEW_RULE_COLOR);
  const [patternError, setPatternError] = useState<string | null>(null);

  const reset = () => { setLabel(''); setPattern(''); setColor(DEFAULT_NEW_RULE_COLOR); setPatternError(null); };

  // Populate form when editing
  useEffect(() => {
    if (open && editRule) {
      setLabel(editRule.label);
      setPattern(editRule.patterns[0] || '');
      setColor(editRule.color);
      setPatternError(null);
    } else if (!open) {
      reset();
    }
  }, [open, editRule]);

  const handleSubmit = () => {
    if (!label.trim() || !pattern.trim()) return;
    try { new RegExp(pattern, 'gi'); } catch {
      setPatternError(t('settings.terminal.keywordHighlight.invalidPattern'));
      return;
    }
    // When editing, replace only the first pattern and keep any additional ones
    const patterns = editRule
      ? [pattern, ...editRule.patterns.slice(1)]
      : [pattern];
    onAdd({ id: editRule?.id ?? crypto.randomUUID(), label: label.trim(), patterns, color, enabled: editRule?.enabled ?? true });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{editRule ? t('settings.terminal.keywordHighlight.editCustom') : t('settings.terminal.keywordHighlight.addCustom')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.terminal.keywordHighlight.labelField')}</Label>
            <div className="flex gap-2">
              <Input
                placeholder={t('settings.terminal.keywordHighlight.labelPlaceholder')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="flex-1"
              />
              <label className="relative flex-shrink-0">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="sr-only" />
                <span className="block w-9 h-9 rounded-md cursor-pointer border border-border/50 hover:border-border" style={{ backgroundColor: color }} />
              </label>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.terminal.keywordHighlight.patternField')}</Label>
            <Input
              placeholder={t('settings.terminal.keywordHighlight.patternPlaceholder')}
              value={pattern}
              onChange={(e) => { setPattern(e.target.value); if (patternError) setPatternError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              className={cn("font-mono", patternError && "border-destructive")}
            />
            {patternError && <div className="text-xs text-destructive">{patternError}</div>}
          </div>
          {label.trim() && pattern.trim() && !patternError && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <span className="text-xs text-muted-foreground">{t('settings.terminal.keywordHighlight.preview')}:</span>
              <span className="text-sm font-medium" style={{ color }}>{label}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!label.trim() || !pattern.trim()}>{editRule ? t('common.save') : t('common.add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const KeywordHighlightRulesEditor: React.FC<{
  rules: KeywordHighlightRule[];
  onChange: (rules: KeywordHighlightRule[]) => void;
}> = ({ rules, onChange }) => {
  const { t } = useI18n();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<KeywordHighlightRule | null>(null);

  const isBuiltIn = (id: string) => DEFAULT_KEYWORD_HIGHLIGHT_RULES.some((r) => r.id === id);

  return (
    <div className="space-y-2.5">
      {rules.map((rule) => {
        const custom = !isBuiltIn(rule.id);
        return (
          <div key={rule.id} className="flex items-center gap-2 group">
            <div className="flex-1 min-w-0 flex items-center gap-1.5">
              <span className={cn("text-sm truncate", !rule.enabled && "text-muted-foreground line-through")} style={rule.enabled ? { color: rule.color } : undefined}>
                {rule.label}
              </span>
              {custom && (
                <>
                  <Pencil
                    size={10}
                    className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground cursor-pointer"
                    onClick={() => { setEditingRule(rule); setAddDialogOpen(true); }}
                  />
                  <Trash2
                    size={10}
                    className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground cursor-pointer"
                    onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                  />
                </>
              )}
            </div>
            <label className="relative flex-shrink-0">
              <input
                type="color"
                value={rule.color}
                onChange={(e) => onChange(rules.map((r) => r.id === rule.id ? { ...r, color: e.target.value } : r))}
                className="sr-only"
              />
              <span
                className="block w-8 h-5 rounded cursor-pointer border border-border/50 hover:border-border transition-colors"
                style={{ backgroundColor: rule.color }}
              />
            </label>
          </div>
        );
      })}

      <div className="flex pt-2 mt-2 border-t border-border/50">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 text-muted-foreground hover:text-foreground"
          onClick={() => setAddDialogOpen(true)}
        >
          <Plus size={14} className="mr-1.5" />
          {t('settings.terminal.keywordHighlight.addCustom')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 text-muted-foreground hover:text-foreground"
          onClick={() => {
            onChange(rules.map((rule) => {
              const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
              return def ? { ...rule, color: def.color } : rule;
            }));
          }}
        >
          <RotateCcw size={14} className="mr-1.5" />
          {t("settings.terminal.keywordHighlight.resetColors")}
        </Button>
      </div>

      <AddCustomRuleDialog
        open={addDialogOpen}
        onOpenChange={(v) => { setAddDialogOpen(v); if (!v) setEditingRule(null); }}
        editRule={editingRule}
        onAdd={(rule) => {
          if (editingRule) {
            onChange(rules.map((r) => r.id === editingRule.id ? rule : r));
          } else {
            onChange([...rules, rule]);
          }
          setEditingRule(null);
        }}
      />
    </div>
  );
};

// Theme preview button component
const ThemePreviewButton: React.FC<{
  theme: (typeof TERMINAL_THEMES)[0];
  onClick: () => void;
  buttonLabel: string;
}> = ({ theme, onClick, buttonLabel }) => {
  const c = theme.colors;
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-4 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-all text-left",
      )}
    >
      {/* Theme preview swatch */}
      <div
        className="w-20 h-14 rounded-lg flex-shrink-0 flex flex-col justify-center items-start pl-2 gap-0.5 border border-border/50"
        style={{ backgroundColor: c.background }}
      >
        <div className="flex gap-1 items-center">
          <span className="font-mono text-[8px]" style={{ color: c.green }}>$</span>
          <span className="font-mono text-[8px]" style={{ color: c.blue }}>ls</span>
        </div>
        <div className="flex gap-0.5">
          <div className="h-1 w-3 rounded-full" style={{ backgroundColor: c.cyan }} />
          <div className="h-1 w-4 rounded-full" style={{ backgroundColor: c.magenta }} />
        </div>
        <div className="flex gap-1 items-center">
          <span className="font-mono text-[8px]" style={{ color: c.green }}>$</span>
          <span className="inline-block w-1.5 h-2 animate-pulse" style={{ backgroundColor: c.cursor }} />
        </div>
      </div>

      {/* Theme info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{theme.name}</div>
        <div className="text-xs text-muted-foreground capitalize">{theme.type}</div>
      </div>

      {/* Action button area */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-xs">{buttonLabel}</span>
        <ChevronRight size={16} />
      </div>
    </button>
  );
};

export default function SettingsTerminalTab(props: {
  terminalThemeId: string;
  setTerminalThemeId: (id: string) => void;
  followAppTerminalTheme: boolean;
  setFollowAppTerminalTheme: (value: boolean) => void;
  terminalFontFamilyId: string;
  setTerminalFontFamilyId: (id: string) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  terminalSettings: TerminalSettings;
  updateTerminalSetting: <K extends keyof TerminalSettings>(
    key: K,
    value: TerminalSettings[K],
  ) => void;
  availableFonts: TerminalFont[];
  workspaceFocusStyle: 'dim' | 'border';
  setWorkspaceFocusStyle: (style: 'dim' | 'border') => void;
}) {
  const {
    terminalThemeId,
    setTerminalThemeId,
    followAppTerminalTheme,
    setFollowAppTerminalTheme,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    updateTerminalSetting,
    availableFonts,
    workspaceFocusStyle,
    setWorkspaceFocusStyle,
  } = props;
  const { t } = useI18n();

  // Local shell settings state
  const [defaultShell, setDefaultShell] = useState<string>("");
  const [shellValidation, setShellValidation] = useState<{ valid: boolean; message?: string } | null>(null);
  const [dirValidation, setDirValidation] = useState<{ valid: boolean; message?: string } | null>(null);

  const discoveredShells = useDiscoveredShells();
  const [showCustomShellInput, setShowCustomShellInput] = useState(() => {
    if (!terminalSettings.localShell) return false;
    return !discoveredShells.some(s => s.id === terminalSettings.localShell);
  });
  const [customShellModalOpen, setCustomShellModalOpen] = useState(false);
  const [customShellDraft, setCustomShellDraft] = useState("");

  // Update showCustomShellInput once discovered shells load
  useEffect(() => {
    if (!terminalSettings.localShell) return;
    setShowCustomShellInput(!discoveredShells.some(s => s.id === terminalSettings.localShell));
  }, [discoveredShells, terminalSettings.localShell]);
  const [themeModalOpen, setThemeModalOpen] = useState(false);

  // Subscribe to custom theme changes so editing in-place triggers re-render
  const customThemes = useCustomThemes();

  // Get current selected theme
  const currentTheme = useMemo(() => {
    return TERMINAL_THEMES.find(t => t.id === terminalThemeId)
      || customThemes.find(t => t.id === terminalThemeId)
      || TERMINAL_THEMES[0];
  }, [terminalThemeId, customThemes]);

  const handleAutocompleteGhostTextChange = useCallback((enabled: boolean) => {
    updateTerminalSetting("autocompleteGhostText", enabled);
    if (enabled) {
      updateTerminalSetting("autocompletePopupMenu", false);
    }
  }, [updateTerminalSetting]);

  const handleAutocompletePopupMenuChange = useCallback((enabled: boolean) => {
    updateTerminalSetting("autocompletePopupMenu", enabled);
    if (enabled) {
      updateTerminalSetting("autocompleteGhostText", false);
    }
  }, [updateTerminalSetting]);

  // Import .itermcolors file
  const importFileRef = useRef<HTMLInputElement>(null);
  const handleImportItermcolors = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    const name = file.name.replace(/\.(itermcolors|xml)$/i, '');
    const reader = new FileReader();
    reader.onload = () => {
      const xml = reader.result as string;
      const parsed = parseItermcolors(xml, name);
      if (parsed) {
        customThemeStore.addTheme(parsed);
        setTerminalThemeId(parsed.id);
      } else {
        console.error('[Settings] Failed to parse .itermcolors file:', file.name);
        window.alert(t('terminal.customTheme.importError') || 'Failed to parse the selected file. Please ensure it is a valid .itermcolors XML file.');
      }
    };
    reader.onerror = () => {
      console.error('[Settings] Failed to read file:', file.name, reader.error);
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [setTerminalThemeId, t]);

  // New custom theme modal
  const [customThemeModalOpen, setCustomThemeModalOpen] = useState(false);
  const [customThemeData, setCustomThemeData] = useState<TerminalTheme | null>(null);
  const [isEditingTheme, setIsEditingTheme] = useState(false);

  // Check if current theme is a custom theme
  const isCustomTheme = useMemo(() => {
    return currentTheme?.isCustom === true;
  }, [currentTheme]);

  const handleNewCustomTheme = useCallback(() => {
    const base = TERMINAL_THEMES.find(t => t.id === terminalThemeId)
      || customThemeStore.getThemeById(terminalThemeId)
      || TERMINAL_THEMES[0];
    const newTheme: TerminalTheme = {
      ...base,
      id: `custom-${Date.now()}`,
      name: `${base.name} (Custom)`,
      isCustom: true,
      colors: { ...base.colors },
    };
    setCustomThemeData(newTheme);
    setIsEditingTheme(false);
    setCustomThemeModalOpen(true);
  }, [terminalThemeId]);

  const handleEditCustomTheme = useCallback(() => {
    if (!currentTheme?.isCustom) return;
    setCustomThemeData({ ...currentTheme, colors: { ...currentTheme.colors } });
    setIsEditingTheme(true);
    setCustomThemeModalOpen(true);
  }, [currentTheme]);

  const handleDeleteCustomTheme = useCallback(() => {
    if (!currentTheme?.isCustom) return;
    customThemeStore.deleteTheme(currentTheme.id);
    setTerminalThemeId(TERMINAL_THEMES[0].id);
  }, [currentTheme, setTerminalThemeId]);

  // Fetch default shell on mount
  useEffect(() => {
    const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
    if (bridge?.getDefaultShell) {
      bridge.getDefaultShell().then((shell) => {
        setDefaultShell(shell);
      }).catch(() => {
        // Ignore errors - might not be in Electron
      });
    }
  }, []);

  // Validate shell path when it changes (only for custom paths, not discovered shell ids)
  useEffect(() => {
    const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
    const shellPath = terminalSettings.localShell;

    if (!shellPath) {
      setShellValidation(null);
      return;
    }

    // Skip validation for discovered shell ids — only validate custom paths
    if (discoveredShells.some(s => s.id === shellPath)) {
      setShellValidation(null);
      return;
    }

    if (!bridge?.validatePath) {
      setShellValidation(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      bridge.validatePath(shellPath, 'file').then((result) => {
        if (result.exists && result.isFile) {
          setShellValidation({ valid: true });
        } else if (result.exists && result.isDirectory) {
          setShellValidation({ valid: false, message: t("settings.terminal.localShell.shell.isDirectory") });
        } else {
          setShellValidation({ valid: false, message: t("settings.terminal.localShell.shell.notFound") });
        }
      }).catch(() => {
        setShellValidation(null);
      });
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [terminalSettings.localShell, discoveredShells, t]);

  // Validate directory path when it changes
  useEffect(() => {
    const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
    const dirPath = terminalSettings.localStartDir;

    if (!dirPath) {
      setDirValidation(null);
      return;
    }

    if (!bridge?.validatePath) {
      setDirValidation(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      bridge.validatePath(dirPath, 'directory').then((result) => {
        if (result.exists && result.isDirectory) {
          setDirValidation({ valid: true });
        } else if (result.exists && result.isFile) {
          setDirValidation({ valid: false, message: t("settings.terminal.localShell.startDir.isFile") });
        } else {
          setDirValidation({ valid: false, message: t("settings.terminal.localShell.startDir.notFound") });
        }
      }).catch(() => {
        setDirValidation(null);
      });
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [terminalSettings.localStartDir, t]);

  const clampFontSize = useCallback((next: number) => {
    const safe = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, next));
    setTerminalFontSize(safe);
  }, [setTerminalFontSize]);

  return (
    <SettingsTabContent value="terminal">
      <SectionHeader title={t("settings.terminal.section.theme")} />
      <div className="rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.theme.followApp")}
          description={t("settings.terminal.theme.followApp.desc")}
        >
          <Toggle
            checked={followAppTerminalTheme}
            onChange={setFollowAppTerminalTheme}
          />
        </SettingRow>
      </div>
      {!followAppTerminalTheme && (
        <ThemePreviewButton
          theme={currentTheme}
          onClick={() => setThemeModalOpen(true)}
          buttonLabel={t("settings.terminal.theme.selectButton")}
        />
      )}

      <ThemeSelectModal
        open={themeModalOpen}
        onClose={() => setThemeModalOpen(false)}
        selectedThemeId={terminalThemeId}
        onSelect={setTerminalThemeId}
      />

      {/* Theme action buttons */}
      <div className="flex items-center gap-2 -mt-1">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={handleNewCustomTheme}
        >
          <Palette size={14} />
          {t('terminal.customTheme.new')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => importFileRef.current?.click()}
        >
          <Import size={14} />
          {t('terminal.customTheme.import')}
        </Button>
        {isCustomTheme && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleEditCustomTheme}
            >
              <Pencil size={14} />
              {t('common.edit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={handleDeleteCustomTheme}
            >
              <Trash2 size={14} />
              {t('common.delete')}
            </Button>
          </>
        )}
        <input
          ref={importFileRef}
          type="file"
          accept=".itermcolors"
          className="hidden"
          onChange={handleImportItermcolors}
        />
      </div>

      {/* Custom Theme Modal */}
      {customThemeData && (
        <CustomThemeModal
          open={customThemeModalOpen}
          theme={customThemeData}
          isNew={!isEditingTheme}
          onSave={(theme) => {
            if (isEditingTheme) {
              customThemeStore.updateTheme(theme.id, theme);
            } else {
              customThemeStore.addTheme(theme);
            }
            setTerminalThemeId(theme.id);
            setCustomThemeModalOpen(false);
            setCustomThemeData(null);
          }}
          onDelete={isEditingTheme ? (themeId) => {
            customThemeStore.deleteTheme(themeId);
            setTerminalThemeId(TERMINAL_THEMES[0].id);
            setCustomThemeModalOpen(false);
            setCustomThemeData(null);
          } : undefined}
          onCancel={() => {
            setCustomThemeModalOpen(false);
            setCustomThemeData(null);
          }}
        />
      )}

      <SectionHeader title={t("settings.terminal.section.font")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.font.family")}
          description={t("settings.terminal.font.family.desc")}
        >
          <TerminalFontSelect
            value={terminalFontFamilyId}
            fonts={availableFonts}
            onChange={(id) => setTerminalFontFamilyId(id)}
            className="w-48"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.font.size")}
          description={t("settings.terminal.font.size.desc")}
        >
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => clampFontSize(terminalFontSize - 1)}
              disabled={terminalFontSize <= MIN_FONT_SIZE}
            >
              <Minus size={14} />
            </Button>
            <span className="text-sm font-mono w-10 text-center">{terminalFontSize}px</span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => clampFontSize(terminalFontSize + 1)}
              disabled={terminalFontSize >= MAX_FONT_SIZE}
            >
              <Plus size={14} />
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.font.weight")}
          description={t("settings.terminal.font.weight.desc")}
        >
          <Select
            value={String(terminalSettings.fontWeight)}
            options={[
              { value: "100", label: "100 - Thin" },
              { value: "200", label: "200 - Extra Light" },
              { value: "300", label: "300 - Light" },
              { value: "400", label: "400 - Normal" },
              { value: "500", label: "500 - Medium" },
              { value: "600", label: "600 - Semi Bold" },
              { value: "700", label: "700 - Bold" },
              { value: "800", label: "800 - Extra Bold" },
              { value: "900", label: "900 - Black" },
            ]}
            onChange={(v) => updateTerminalSetting("fontWeight", parseInt(v))}
            className="w-40"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.font.weightBold")}
          description={t("settings.terminal.font.weightBold.desc")}
        >
          <Select
            value={String(terminalSettings.fontWeightBold)}
            options={[
              { value: "100", label: "100 - Thin" },
              { value: "200", label: "200 - Extra Light" },
              { value: "300", label: "300 - Light" },
              { value: "400", label: "400 - Normal" },
              { value: "500", label: "500 - Medium" },
              { value: "600", label: "600 - Semi Bold" },
              { value: "700", label: "700 - Bold" },
              { value: "800", label: "800 - Extra Bold" },
              { value: "900", label: "900 - Black" },
            ]}
            onChange={(v) => updateTerminalSetting("fontWeightBold", parseInt(v))}
            className="w-40"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.font.linePadding")}
          description={t("settings.terminal.font.linePadding.desc")}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={terminalSettings.linePadding}
              onChange={(e) => updateTerminalSetting("linePadding", parseInt(e.target.value))}
              className="w-24 accent-primary"
            />
            <span className="text-sm text-muted-foreground w-6 text-center">{terminalSettings.linePadding}</span>
          </div>
        </SettingRow>

        <SettingRow label={t("settings.terminal.font.emulationType")}>
          <Select
            value={terminalSettings.terminalEmulationType}
            options={[
              { value: "xterm-256color", label: "xterm-256color" },
              { value: "xterm-16color", label: "xterm-16color" },
              { value: "xterm", label: "xterm" },
            ]}
            onChange={(v) =>
              updateTerminalSetting("terminalEmulationType", v as TerminalEmulationType)
            }
            className="w-44"
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.cursor")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow label={t("settings.terminal.cursor.style")}>
          <Select
            value={terminalSettings.cursorShape}
            options={[
              { value: "block", label: t("settings.terminal.cursor.style.block") },
              { value: "bar", label: t("settings.terminal.cursor.style.bar") },
              { value: "underline", label: t("settings.terminal.cursor.style.underline") },
            ]}
            onChange={(v) => updateTerminalSetting("cursorShape", v as CursorShape)}
            className="w-32"
          />
        </SettingRow>

        <SettingRow label={t("settings.terminal.cursor.blink")}>
          <Toggle
            checked={terminalSettings.cursorBlink}
            onChange={(v) => updateTerminalSetting("cursorBlink", v)}
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.keyboard")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.keyboard.altAsMeta")}
          description={t("settings.terminal.keyboard.altAsMeta.desc")}
        >
          <Toggle checked={terminalSettings.altAsMeta} onChange={(v) => updateTerminalSetting("altAsMeta", v)} />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.accessibility")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.accessibility.minimumContrastRatio")}
          description={t("settings.terminal.accessibility.minimumContrastRatio.desc")}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={21}
              step={1}
              value={terminalSettings.minimumContrastRatio}
              onChange={(e) =>
                updateTerminalSetting("minimumContrastRatio", parseInt(e.target.value))
              }
              className="w-24 accent-primary"
            />
            <span className="text-sm text-muted-foreground w-6 text-center">
              {terminalSettings.minimumContrastRatio}
            </span>
          </div>
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.behavior")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.behavior.rightClick")}
          description={t("settings.terminal.behavior.rightClick.desc")}
        >
          <Select
            value={terminalSettings.rightClickBehavior}
            options={[
              { value: "context-menu", label: t("settings.terminal.behavior.rightClick.menu") },
              { value: "paste", label: t("settings.terminal.behavior.rightClick.paste") },
              { value: "select-word", label: t("settings.terminal.behavior.rightClick.selectWord") },
            ]}
            onChange={(v) => updateTerminalSetting("rightClickBehavior", v as RightClickBehavior)}
            className="w-36"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.copyOnSelect")}
          description={t("settings.terminal.behavior.copyOnSelect.desc")}
        >
          <Toggle checked={terminalSettings.copyOnSelect} onChange={(v) => updateTerminalSetting("copyOnSelect", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.middleClickPaste")}
          description={t("settings.terminal.behavior.middleClickPaste.desc")}
        >
          <Toggle checked={terminalSettings.middleClickPaste} onChange={(v) => updateTerminalSetting("middleClickPaste", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.bracketedPaste")}
          description={t("settings.terminal.behavior.bracketedPaste.desc")}
        >
          <Toggle checked={!terminalSettings.disableBracketedPaste} onChange={(v) => updateTerminalSetting("disableBracketedPaste", !v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.clearWipesScrollback")}
          description={t("settings.terminal.behavior.clearWipesScrollback.desc")}
        >
          <Toggle checked={terminalSettings.clearWipesScrollback ?? true} onChange={(v) => updateTerminalSetting("clearWipesScrollback", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.preserveSelectionOnInput")}
          description={t("settings.terminal.behavior.preserveSelectionOnInput.desc")}
        >
          <Toggle checked={terminalSettings.preserveSelectionOnInput ?? false} onChange={(v) => updateTerminalSetting("preserveSelectionOnInput", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.osc52Clipboard")}
          description={t("settings.terminal.behavior.osc52Clipboard.desc")}
        >
          <Select
            value={terminalSettings.osc52Clipboard ?? 'write-only'}
            options={[
              { value: "off", label: t("settings.terminal.behavior.osc52Clipboard.off") },
              { value: "write-only", label: t("settings.terminal.behavior.osc52Clipboard.writeOnly") },
              { value: "read-write", label: t("settings.terminal.behavior.osc52Clipboard.readWrite") },
              { value: "prompt", label: t("settings.terminal.behavior.osc52Clipboard.prompt") },
            ]}
            onChange={(v) => updateTerminalSetting("osc52Clipboard", v as "off" | "write-only" | "read-write" | "prompt")}
            className="w-40"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnInput")}
          description={t("settings.terminal.behavior.scrollOnInput.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnInput} onChange={(v) => updateTerminalSetting("scrollOnInput", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnOutput")}
          description={t("settings.terminal.behavior.scrollOnOutput.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnOutput} onChange={(v) => updateTerminalSetting("scrollOnOutput", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnKeyPress")}
          description={t("settings.terminal.behavior.scrollOnKeyPress.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnKeyPress} onChange={(v) => updateTerminalSetting("scrollOnKeyPress", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnPaste")}
          description={t("settings.terminal.behavior.scrollOnPaste.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnPaste} onChange={(v) => updateTerminalSetting("scrollOnPaste", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.smoothScrolling")}
          description={t("settings.terminal.behavior.smoothScrolling.desc")}
        >
          <Toggle checked={terminalSettings.smoothScrolling} onChange={(v) => updateTerminalSetting("smoothScrolling", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.linkModifier")}
          description={t("settings.terminal.behavior.linkModifier.desc")}
        >
          <Select
            value={terminalSettings.linkModifier}
            options={[
              { value: "none", label: t("settings.terminal.behavior.linkModifier.none") },
              { value: "ctrl", label: t("settings.terminal.behavior.linkModifier.ctrl") },
              { value: "alt", label: t("settings.terminal.behavior.linkModifier.alt") },
              { value: "meta", label: t("settings.terminal.behavior.linkModifier.meta") },
            ]}
            onChange={(v) => updateTerminalSetting("linkModifier", v as LinkModifier)}
            className="w-48"
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.scrollback")} />
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground mb-3">
          {t("settings.terminal.scrollback.desc")}
        </p>
        <div className="space-y-1">
          <Label className="text-xs">{t("settings.terminal.scrollback.rows")}</Label>
          <Input
            type="number"
            min={0}
            max={100000}
            value={terminalSettings.scrollback}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val) && val >= 0 && val <= 100000) {
                updateTerminalSetting("scrollback", val);
              }
            }}
            className="w-full"
          />
        </div>
      </div>

      <SectionHeader title={t("settings.terminal.section.keywordHighlight")} />
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-medium">
            {t("settings.terminal.keywordHighlight.title")}
          </span>
          <Toggle
            checked={terminalSettings.keywordHighlightEnabled}
            onChange={(v) => updateTerminalSetting("keywordHighlightEnabled", v)}
          />
        </div>
        {terminalSettings.keywordHighlightEnabled && (
          <KeywordHighlightRulesEditor
            rules={terminalSettings.keywordHighlightRules}
            onChange={(rules) => updateTerminalSetting("keywordHighlightRules", rules)}
          />
        )}
      </div>

      <SectionHeader title={t("settings.terminal.section.localShell")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.localShell.shell")}
          description={t("settings.terminal.localShell.shell.desc")}
        >
          <div className="flex flex-col gap-1 items-end">
            <select
              className="h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
              value={
                showCustomShellInput
                  ? "__custom__"
                  : terminalSettings.localShell || ""
              }
              onChange={(e) => {
                const value = e.target.value;
                if (value === "__custom__") {
                  setCustomShellDraft(terminalSettings.localShell || "");
                  setCustomShellModalOpen(true);
                } else {
                  setShowCustomShellInput(false);
                  updateTerminalSetting("localShell", value);
                }
              }}
            >
              <option value="">
                {t("settings.terminal.localShell.shell.default")}
                {defaultShell ? ` (${defaultShell.split(/[/\\]/).pop()})` : ""}
              </option>
              {discoveredShells.map((shell) => (
                <option key={shell.id} value={shell.id}>
                  {shell.name}
                </option>
              ))}
              <option value="__custom__">{t("settings.terminal.localShell.shell.custom")}</option>
            </select>
            {showCustomShellInput && (
              <span className="text-xs text-muted-foreground truncate max-w-48">
                {terminalSettings.localShell}
              </span>
            )}
            {!showCustomShellInput && defaultShell && !terminalSettings.localShell && (
              <span className="text-xs text-muted-foreground">
                {t("settings.terminal.localShell.shell.detected")}: {defaultShell}
              </span>
            )}
          </div>
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.localShell.startDir")}
          description={t("settings.terminal.localShell.startDir.desc")}
        >
          <div className="flex flex-col gap-1">
            <Input
              value={terminalSettings.localStartDir}
              placeholder={t("settings.terminal.localShell.startDir.placeholder")}
              onChange={(e) => updateTerminalSetting("localStartDir", e.target.value)}
              className={cn(
                "w-48",
                dirValidation && !dirValidation.valid && "border-destructive focus-visible:ring-destructive"
              )}
            />
            {dirValidation && !dirValidation.valid && dirValidation.message && (
              <span className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle size={12} />
                {dirValidation.message}
              </span>
            )}
          </div>
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.connection")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.connection.keepaliveInterval")}
          description={t("settings.terminal.connection.keepaliveInterval.desc")}
        >
          <Input
            type="number"
            min={0}
            max={3600}
            value={terminalSettings.keepaliveInterval}
            onChange={(e) => {
              const val = parseInt(e.target.value) || 0;
              if (val >= 0 && val <= 3600) {
                updateTerminalSetting("keepaliveInterval", val);
              }
            }}
            className="w-24"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.connection.x11Display")}
          description={t("settings.terminal.connection.x11Display.desc")}
        >
          <Input
            value={terminalSettings.x11Display}
            onChange={(e) => updateTerminalSetting("x11Display", e.target.value)}
            placeholder={t("settings.terminal.connection.x11Display.placeholder")}
            className="w-48"
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.serverStats")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.serverStats.show")}
          description={t("settings.terminal.serverStats.show.desc")}
        >
          <Toggle
            checked={terminalSettings.showServerStats}
            onChange={(v) => updateTerminalSetting("showServerStats", v)}
          />
        </SettingRow>

        {terminalSettings.showServerStats && (
          <SettingRow
            label={t("settings.terminal.serverStats.refreshInterval")}
            description={t("settings.terminal.serverStats.refreshInterval.desc")}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={5}
                max={300}
                value={terminalSettings.serverStatsRefreshInterval}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 5;
                  if (val >= 5 && val <= 300) {
                    updateTerminalSetting("serverStatsRefreshInterval", val);
                  }
                }}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">{t("settings.terminal.serverStats.seconds")}</span>
            </div>
          </SettingRow>
        )}
      </div>

      <SectionHeader title={t("settings.terminal.section.rendering")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.rendering.renderer")}
          description={t("settings.terminal.rendering.renderer.desc")}
        >
          <Select
            value={terminalSettings.rendererType}
            options={[
              { value: "auto", label: t("settings.terminal.rendering.auto") },
              { value: "webgl", label: "WebGL" },
              { value: "dom", label: "DOM" },
            ]}
            onChange={(v) => updateTerminalSetting("rendererType", v as "auto" | "webgl" | "dom")}
            className="w-32"
          />
        </SettingRow>
      </div>
      {/* Autocomplete */}
      <SectionHeader title={t("settings.terminal.section.workspaceFocus")} />
      <div className="space-y-1">
        <SettingRow
          label={t("settings.terminal.workspaceFocus.style")}
          description={t("settings.terminal.workspaceFocus.style.desc")}
        >
          <Select
            value={workspaceFocusStyle}
            onChange={(v) => setWorkspaceFocusStyle(v as 'dim' | 'border')}
            options={[
              { value: 'dim', label: t("settings.terminal.workspaceFocus.dim") },
              { value: 'border', label: t("settings.terminal.workspaceFocus.border") },
            ]}
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.autocomplete")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.autocomplete.enabled")}
          description={t("settings.terminal.autocomplete.enabled.desc")}
        >
          <Toggle
            checked={terminalSettings.autocompleteEnabled}
            onChange={(v) => updateTerminalSetting("autocompleteEnabled", v)}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.autocomplete.ghostText")}
          description={t("settings.terminal.autocomplete.ghostText.desc")}
        >
          <Toggle
            checked={terminalSettings.autocompleteGhostText}
            onChange={handleAutocompleteGhostTextChange}
            disabled={!terminalSettings.autocompleteEnabled}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.autocomplete.popupMenu")}
          description={t("settings.terminal.autocomplete.popupMenu.desc")}
        >
          <Toggle
            checked={terminalSettings.autocompletePopupMenu}
            onChange={handleAutocompletePopupMenuChange}
            disabled={!terminalSettings.autocompleteEnabled}
          />
        </SettingRow>
      </div>
      {/* Custom Shell Modal */}
      <Dialog open={customShellModalOpen} onOpenChange={setCustomShellModalOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t("settings.terminal.localShell.shell.custom")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("settings.terminal.localShell.shell.customPath")}</label>
              <Input
                value={customShellDraft}
                placeholder={t("settings.terminal.localShell.shell.placeholder")}
                onChange={(e) => setCustomShellDraft(e.target.value)}
                className="w-full"
                autoFocus
              />
              {shellValidation && !shellValidation.valid && shellValidation.message && (
                <span className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle size={12} />
                  {shellValidation.message}
                </span>
              )}
              {shellValidation?.valid && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  ✓ {t("settings.terminal.localShell.shell.pathValid")}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t("settings.terminal.localShell.shell.commonPaths")}</label>
              <div className="flex flex-wrap gap-1.5">
                {["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/bin/sh", "powershell.exe", "pwsh.exe", "cmd.exe"].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setCustomShellDraft(p)}
                    className="text-xs px-2 py-1 rounded-md border border-border bg-muted/50 hover:bg-muted transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setCustomShellModalOpen(false)}
              className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                updateTerminalSetting("localShell", customShellDraft);
                setShowCustomShellInput(true);
                setCustomShellModalOpen(false);
              }}
              disabled={!customShellDraft.trim()}
              className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsTabContent>
  );
}
