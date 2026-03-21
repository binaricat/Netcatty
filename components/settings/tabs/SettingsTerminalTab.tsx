import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { AlertCircle, ChevronRight, Import, Minus, Palette, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type {
  CursorShape,
  LinkModifier,
  RightClickBehavior,
  TerminalEmulationType,
  TerminalSettings,
} from "../../../domain/models";
import { DEFAULT_KEYWORD_HIGHLIGHT_RULES } from "../../../domain/models";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type TerminalFont } from "../../../infrastructure/config/fonts";
import { TERMINAL_THEMES } from "../../../infrastructure/config/terminalThemes";
import { customThemeStore, useCustomThemes } from "../../../application/state/customThemeStore";
import { parseItermcolors } from "../../../infrastructure/parsers/itermcolorsParser";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { SectionHeader, Select, SettingsTabContent, SettingRow, Toggle } from "../settings-ui";
import { ThemeSelectModal } from "../ThemeSelectModal";
import { TerminalFontSelect } from "../TerminalFontSelect";
import { CustomThemeModal } from "../../terminal/CustomThemeModal";
import type { TerminalTheme } from "../../../domain/models";

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
}) {
  const {
    terminalThemeId,
    setTerminalThemeId,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    updateTerminalSetting,
    availableFonts,
  } = props;
  const { t } = useI18n();

  // Local shell settings state
  const [defaultShell, setDefaultShell] = useState<string>("");
  const [shellValidation, setShellValidation] = useState<{ valid: boolean; message?: string } | null>(null);
  const [dirValidation, setDirValidation] = useState<{ valid: boolean; message?: string } | null>(null);
  const [themeModalOpen, setThemeModalOpen] = useState(false);

  // Subscribe to custom theme changes so editing in-place triggers re-render
  const customThemes = useCustomThemes();

  // Get current selected theme
  const currentTheme = useMemo(() => {
    return TERMINAL_THEMES.find(t => t.id === terminalThemeId)
      || customThemes.find(t => t.id === terminalThemeId)
      || TERMINAL_THEMES[0];
  }, [terminalThemeId, customThemes]);

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

  // Validate shell path when it changes
  useEffect(() => {
    const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
    const shellPath = terminalSettings.localShell;

    if (!shellPath) {
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
  }, [terminalSettings.localShell, t]);

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
      <ThemePreviewButton
        theme={currentTheme}
        onClick={() => setThemeModalOpen(true)}
        buttonLabel={t("settings.terminal.theme.selectButton")}
      />

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
          <div className="space-y-2.5">
            {terminalSettings.keywordHighlightRules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between">
                <span className="text-sm" style={{ color: rule.color }}>
                  {rule.label}
                </span>
                <label className="relative">
                  <input
                    type="color"
                    value={rule.color}
                    onChange={(e) => {
                      const newRules = terminalSettings.keywordHighlightRules.map((r) =>
                        r.id === rule.id ? { ...r, color: e.target.value } : r,
                      );
                      updateTerminalSetting("keywordHighlightRules", newRules);
                    }}
                    className="sr-only"
                  />
                  <span
                    className="block w-10 h-6 rounded-md cursor-pointer border border-border/50 hover:border-border transition-colors"
                    style={{ backgroundColor: rule.color }}
                  />
                </label>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="w-full mt-3 text-muted-foreground hover:text-foreground"
              onClick={() => {
                const resetRules = terminalSettings.keywordHighlightRules.map((rule) => {
                  const defaultRule = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
                  return defaultRule ? { ...rule, color: defaultRule.color } : rule;
                });
                updateTerminalSetting("keywordHighlightRules", resetRules);
              }}
            >
              <RotateCcw size={14} className="mr-2" />
              {t("settings.terminal.keywordHighlight.resetColors")}
            </Button>
          </div>
        )}
      </div>

      <SectionHeader title={t("settings.terminal.section.localShell")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.localShell.shell")}
          description={t("settings.terminal.localShell.shell.desc")}
        >
          <div className="flex flex-col gap-1 items-end">
            <Input
              value={terminalSettings.localShell}
              placeholder={t("settings.terminal.localShell.shell.placeholder")}
              onChange={(e) => updateTerminalSetting("localShell", e.target.value)}
              className={cn(
                "w-48",
                shellValidation && !shellValidation.valid && "border-destructive focus-visible:ring-destructive"
              )}
            />
            {defaultShell && !terminalSettings.localShell && (
              <span className="text-xs text-muted-foreground">
                {t("settings.terminal.localShell.shell.detected")}: {defaultShell}
              </span>
            )}
            {shellValidation && !shellValidation.valid && shellValidation.message && (
              <span className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle size={12} />
                {shellValidation.message}
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
              { value: "canvas", label: "Canvas" },
            ]}
            onChange={(v) => updateTerminalSetting("rendererType", v as "auto" | "webgl" | "canvas")}
            className="w-32"
          />
        </SettingRow>
      </div>
    </SettingsTabContent>
  );
}
