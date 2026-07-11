import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { AlertCircle, Import, Minus, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  CursorShape,
  TerminalEmulationType,
  TerminalSettings,
} from "../../../domain/models";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { MAX_FONT_SIZE, MIN_FONT_SIZE, resolveTerminalFontFamilyId, type TerminalFont } from "../../../infrastructure/config/fonts";
import { TERMINAL_THEMES } from "../../../infrastructure/config/terminalThemes";
import { customThemeStore, useCustomThemes } from "../../../application/state/customThemeStore";
import { parseItermcolors } from "../../../infrastructure/parsers/itermcolorsParser";
import { cn } from "../../../lib/utils";
import { useDiscoveredShells } from "../../../lib/useDiscoveredShells";
import { parseShellArgs, formatShellArgs } from "../../../domain/shellArgs";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select as ShadcnSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SectionHeader, Select, SettingsTabContent, SettingRow, Toggle } from "../settings-ui";
import { ThemeSelectModal } from "../ThemeSelectModal";
import { TerminalFontSelect } from "../TerminalFontSelect";
import { TerminalCjkFontSelect } from "../TerminalCjkFontSelect";
import { CustomThemeModal } from "../../terminal/CustomThemeModal";
import type { TerminalTheme } from "../../../domain/models";
import { resolveFollowedTerminalThemeId, resolveManualTerminalThemeId } from "../../../domain/terminalAppearance";

import { KeywordHighlightRulesEditor, ThemePreviewButton } from "./SettingsTerminalTabControls";
import { TerminalBehaviorSettings } from "./TerminalBehaviorSettings";
import {
  TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS,
  type TerminalSidePanelAutoOpenTab,
} from "../../../domain/terminalSidePanelAutoOpen";

const FONT_WEIGHT_OPTIONS = [
  { value: "100", labelKey: "settings.terminal.font.weight.thin" },
  { value: "200", labelKey: "settings.terminal.font.weight.extraLight" },
  { value: "300", labelKey: "settings.terminal.font.weight.light" },
  { value: "400", labelKey: "settings.terminal.font.weight.normal" },
  { value: "500", labelKey: "settings.terminal.font.weight.medium" },
  { value: "600", labelKey: "settings.terminal.font.weight.semiBold" },
  { value: "700", labelKey: "settings.terminal.font.weight.bold" },
  { value: "800", labelKey: "settings.terminal.font.weight.extraBold" },
  { value: "900", labelKey: "settings.terminal.font.weight.black" },
];

function SettingsTerminalTab(props: {
  terminalThemeId: string;
  setTerminalThemeId: (id: string) => void;
  resolvedTheme: "dark" | "light";
  followAppTerminalTheme: boolean;
  setFollowAppTerminalTheme: (value: boolean) => void;
  terminalThemeDarkId: string;
  setTerminalThemeDarkId: (id: string) => void;
  terminalThemeLightId: string;
  setTerminalThemeLightId: (id: string) => void;
  lightUiThemeId: string;
  darkUiThemeId: string;
  terminalFontFamilyId: string;
  setTerminalFontFamilyId: (id: string) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  terminalSettings: TerminalSettings;
  updateTerminalSetting: <K extends keyof TerminalSettings>(
    key: K,
    value: TerminalSettings[K],
  ) => void;
  terminalSidePanelAutoOpen: boolean;
  setTerminalSidePanelAutoOpen: (enabled: boolean) => void;
  terminalSidePanelAutoOpenTab: TerminalSidePanelAutoOpenTab;
  setTerminalSidePanelAutoOpenTab: (tab: TerminalSidePanelAutoOpenTab) => void;
  availableFonts: TerminalFont[];
  workspaceFocusStyle: 'dim' | 'border';
  setWorkspaceFocusStyle: (style: 'dim' | 'border') => void;
}) {
  const {
    terminalThemeId,
    setTerminalThemeId,
    resolvedTheme,
    followAppTerminalTheme,
    setFollowAppTerminalTheme,
    terminalThemeDarkId,
    setTerminalThemeDarkId,
    terminalThemeLightId,
    setTerminalThemeLightId,
    lightUiThemeId,
    darkUiThemeId,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    updateTerminalSetting,
    terminalSidePanelAutoOpen,
    setTerminalSidePanelAutoOpen,
    terminalSidePanelAutoOpenTab,
    setTerminalSidePanelAutoOpenTab,
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
  const [customArgsDraft, setCustomArgsDraft] = useState("");

  // Update showCustomShellInput once discovered shells load
  useEffect(() => {
    if (!terminalSettings.localShell) return;
    setShowCustomShellInput(!discoveredShells.some(s => s.id === terminalSettings.localShell));
  }, [discoveredShells, terminalSettings.localShell]);

  // Seed the drafts from current settings and open the custom-shell editor.
  // Used both when picking "Custom…" and when re-editing an existing custom shell.
  const openCustomShellModal = useCallback(() => {
    setCustomShellDraft(terminalSettings.localShell || "");
    setCustomArgsDraft(formatShellArgs(terminalSettings.localShellArgs ?? []));
    setCustomShellModalOpen(true);
  }, [terminalSettings.localShell, terminalSettings.localShellArgs]);
  const [themeModalSlot, setThemeModalSlot] = useState<'dark' | 'light' | null>(null);

  // Subscribe to custom theme changes so editing in-place triggers re-render
  const customThemes = useCustomThemes();

  const findTerminalTheme = useCallback((id: string) => (
    TERMINAL_THEMES.find(t => t.id === id)
      || customThemes.find(t => t.id === id)
      || null
  ), [customThemes]);

  const followedPreviewTheme = useMemo(() => {
    const id = resolveFollowedTerminalThemeId({
      resolvedTheme,
      lightUiThemeId,
      darkUiThemeId,
      fallbackThemeId: terminalThemeId,
    });
    return findTerminalTheme(id) || findTerminalTheme(terminalThemeId) || TERMINAL_THEMES[0];
  }, [darkUiThemeId, findTerminalTheme, lightUiThemeId, resolvedTheme, terminalThemeId]);

  const darkPreviewTheme = useMemo(() => {
    const id = resolveManualTerminalThemeId({
      resolvedTheme: 'dark',
      terminalThemeDarkId, terminalThemeLightId,
      lightUiThemeId, darkUiThemeId, fallbackThemeId: terminalThemeId,
    });
    return findTerminalTheme(id) || findTerminalTheme(terminalThemeId) || TERMINAL_THEMES[0];
  }, [darkUiThemeId, findTerminalTheme, lightUiThemeId, terminalThemeDarkId, terminalThemeId, terminalThemeLightId]);

  const lightPreviewTheme = useMemo(() => {
    const id = resolveManualTerminalThemeId({
      resolvedTheme: 'light',
      terminalThemeDarkId, terminalThemeLightId,
      lightUiThemeId, darkUiThemeId, fallbackThemeId: terminalThemeId,
    });
    return findTerminalTheme(id) || findTerminalTheme(terminalThemeId) || TERMINAL_THEMES[0];
  }, [darkUiThemeId, findTerminalTheme, lightUiThemeId, terminalThemeDarkId, terminalThemeId, terminalThemeLightId]);

  const currentTheme = followAppTerminalTheme
    ? followedPreviewTheme
    : resolvedTheme === 'dark'
      ? darkPreviewTheme
      : lightPreviewTheme;

  const setManualThemeForResolvedMode = useCallback((themeId: string) => {
    if (resolvedTheme === 'dark') {
      setTerminalThemeDarkId(themeId);
    } else {
      setTerminalThemeLightId(themeId);
    }
    setTerminalThemeId(themeId);
  }, [resolvedTheme, setTerminalThemeDarkId, setTerminalThemeId, setTerminalThemeLightId]);

  const fontWeightOptions = useMemo(() => (
    FONT_WEIGHT_OPTIONS.map((option) => ({
      value: option.value,
      label: `${option.value} - ${t(option.labelKey)}`,
    }))
  ), [t]);

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
        setManualThemeForResolvedMode(parsed.id);
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
  }, [setManualThemeForResolvedMode, t]);

  // New custom theme modal
  const [customThemeModalOpen, setCustomThemeModalOpen] = useState(false);
  const [customThemeData, setCustomThemeData] = useState<TerminalTheme | null>(null);
  const [isEditingTheme, setIsEditingTheme] = useState(false);

  // Check if current theme is a custom theme
  const isCustomTheme = useMemo(() => {
    return currentTheme?.isCustom === true;
  }, [currentTheme]);

  const handleNewCustomTheme = useCallback(() => {
    const base = currentTheme || TERMINAL_THEMES[0];
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
  }, [currentTheme]);

  const handleEditCustomTheme = useCallback(() => {
    if (!currentTheme?.isCustom) return;
    setCustomThemeData({ ...currentTheme, colors: { ...currentTheme.colors } });
    setIsEditingTheme(true);
    setCustomThemeModalOpen(true);
  }, [currentTheme]);

  const handleDeleteCustomTheme = useCallback(() => {
    if (!currentTheme?.isCustom) return;
    customThemeStore.deleteTheme(currentTheme.id);
    setManualThemeForResolvedMode(followedPreviewTheme.id);
  }, [currentTheme, followedPreviewTheme.id, setManualThemeForResolvedMode]);

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
        <div className="space-y-2">
          <div>
            <div className="text-xs text-muted-foreground mb-1.5 px-1">
              {t("settings.terminal.theme.darkTheme")}
            </div>
            <ThemePreviewButton
              theme={darkPreviewTheme}
              onClick={() => setThemeModalSlot('dark')}
              buttonLabel={t("settings.terminal.theme.selectButton")}
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1.5 px-1">
              {t("settings.terminal.theme.lightTheme")}
            </div>
            <ThemePreviewButton
              theme={lightPreviewTheme}
              onClick={() => setThemeModalSlot('light')}
              buttonLabel={t("settings.terminal.theme.selectButton")}
            />
          </div>
        </div>
      )}

      <ThemeSelectModal
        open={themeModalSlot !== null}
        onClose={() => setThemeModalSlot(null)}
        selectedThemeId={themeModalSlot === 'dark' ? darkPreviewTheme.id : lightPreviewTheme.id}
        onSelect={(id) => {
          if (themeModalSlot === 'dark') {
            setTerminalThemeDarkId(id);
          } else if (themeModalSlot === 'light') {
            setTerminalThemeLightId(id);
          }
          if (themeModalSlot === resolvedTheme) {
            setTerminalThemeId(id);
          }
        }}
        filterType={themeModalSlot === 'light' ? 'light' : 'dark'}
      />

      {!followAppTerminalTheme && (
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
      )}

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
            setManualThemeForResolvedMode(theme.id);
            setCustomThemeModalOpen(false);
            setCustomThemeData(null);
          }}
          onDelete={isEditingTheme ? (themeId) => {
            customThemeStore.deleteTheme(themeId);
            setManualThemeForResolvedMode(followedPreviewTheme.id);
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
            value={resolveTerminalFontFamilyId(
              terminalFontFamilyId,
              typeof navigator !== "undefined" ? navigator.platform : "",
            )}
            fonts={availableFonts}
            onChange={(id) => setTerminalFontFamilyId(id)}
            className="w-48"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.font.cjk")}
          description={t("settings.terminal.font.cjk.desc")}
        >
          <TerminalCjkFontSelect
            value={terminalSettings.fallbackFont ?? ""}
            onChange={(next) => updateTerminalSetting("fallbackFont", next)}
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
            options={fontWeightOptions}
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
            options={fontWeightOptions}
            onChange={(v) => updateTerminalSetting("fontWeightBold", parseInt(v))}
            className="w-40"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.font.smoothing")}
          description={t("settings.terminal.font.smoothing.desc")}
        >
          <Toggle
            checked={terminalSettings.fontSmoothing}
            onChange={(v) => updateTerminalSetting("fontSmoothing", v)}
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
        <SettingRow
          label={t("settings.terminal.keyboard.optionArrowWordJump")}
          description={t("settings.terminal.keyboard.optionArrowWordJump.desc")}
        >
          <Toggle checked={terminalSettings.optionArrowWordJump} onChange={(v) => updateTerminalSetting("optionArrowWordJump", v)} />
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

      <TerminalBehaviorSettings
        t={t}
        terminalSettings={terminalSettings}
        updateTerminalSetting={updateTerminalSetting}
      />

      <SectionHeader title={t("settings.terminal.section.sidePanel")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.sidePanel.autoOpen")}
          description={t("settings.terminal.sidePanel.autoOpen.desc")}
        >
          <Toggle checked={terminalSidePanelAutoOpen} onChange={setTerminalSidePanelAutoOpen} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.sidePanel.autoOpenPane")}
          description={t("settings.terminal.sidePanel.autoOpenPane.desc")}
        >
          <Select
            value={terminalSidePanelAutoOpenTab}
            options={TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS.map((tab) => ({
              value: tab,
              label: t(`settings.terminal.sidePanel.pane.${tab}`),
            }))}
            onChange={(value) => setTerminalSidePanelAutoOpenTab(value as TerminalSidePanelAutoOpenTab)}
            disabled={!terminalSidePanelAutoOpen}
            className="w-36"
          />
        </SettingRow>
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
            <ShadcnSelect
              value={
                showCustomShellInput
                  ? "__custom__"
                  : (terminalSettings.localShell || "__default__")
              }
              onValueChange={(value) => {
                if (value === "__custom__") {
                  openCustomShellModal();
                } else if (value === "__default__") {
                  setShowCustomShellInput(false);
                  updateTerminalSetting("localShell", "");
                  // Custom args only apply to a custom path; clear them so a stale
                  // value can't leak into a discovered/default shell launch (#1221).
                  updateTerminalSetting("localShellArgs", []);
                } else {
                  setShowCustomShellInput(false);
                  updateTerminalSetting("localShell", value);
                  updateTerminalSetting("localShellArgs", []);
                }
              }}
            >
              <SelectTrigger className="h-9 w-48 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t("settings.terminal.localShell.shell.default")}
                  {defaultShell ? ` (${defaultShell.split(/[/\\]/).pop()})` : ""}
                </SelectItem>
                {discoveredShells.map((shell) => (
                  <SelectItem key={shell.id} value={shell.id}>
                    {shell.name}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">{t("settings.terminal.localShell.shell.custom")}</SelectItem>
              </SelectContent>
            </ShadcnSelect>
            {showCustomShellInput && (
              <button
                type="button"
                onClick={openCustomShellModal}
                title={t("common.edit")}
                className="flex items-center gap-1 text-xs text-muted-foreground max-w-48 hover:text-foreground"
              >
                <Pencil size={11} className="shrink-0" />
                <span className="truncate">
                  {terminalSettings.localShell}
                  {terminalSettings.localShellArgs?.length ? ` ${formatShellArgs(terminalSettings.localShellArgs)}` : ""}
                </span>
              </button>
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
          label={t("settings.terminal.connection.verifyHostKeys")}
          description={t("settings.terminal.connection.verifyHostKeys.desc")}
        >
          <Toggle
            checked={terminalSettings.verifyHostKeys}
            onChange={(v) => updateTerminalSetting("verifyHostKeys", v)}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.connection.sshAutoReconnectEnabled")}
          description={t("settings.terminal.connection.sshAutoReconnectEnabled.desc")}
        >
          <Toggle
            checked={terminalSettings.sshAutoReconnectEnabled}
            onChange={(v) => updateTerminalSetting("sshAutoReconnectEnabled", v)}
          />
        </SettingRow>
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
          label={t("settings.terminal.connection.keepaliveCountMax")}
          description={t("settings.terminal.connection.keepaliveCountMax.desc")}
        >
          <Input
            type="number"
            min={1}
            max={100}
            value={terminalSettings.keepaliveCountMax}
            onChange={(e) => {
              const val = parseInt(e.target.value) || 1;
              if (val >= 1 && val <= 100) {
                updateTerminalSetting("keepaliveCountMax", val);
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
          label={t("settings.terminal.hostInfoBar.show")}
          description={t("settings.terminal.hostInfoBar.show.desc")}
        >
          <Toggle
            checked={terminalSettings.showHostInfoBar}
            onChange={(v) => updateTerminalSetting("showHostInfoBar", v)}
          />
        </SettingRow>
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

      <SectionHeader title={t("settings.terminal.section.systemManager")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.systemManager.processRefreshInterval")}
          description={t("settings.terminal.systemManager.processRefreshInterval.desc")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={2}
              max={60}
              value={terminalSettings.systemManagerProcessRefreshInterval}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 3;
                if (val >= 2 && val <= 60) {
                  updateTerminalSetting("systemManagerProcessRefreshInterval", val);
                }
              }}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">{t("settings.terminal.serverStats.seconds")}</span>
          </div>
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.systemManager.tmuxRefreshInterval")}
          description={t("settings.terminal.systemManager.tmuxRefreshInterval.desc")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={2}
              max={60}
              value={terminalSettings.systemManagerTmuxRefreshInterval}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 3;
                if (val >= 2 && val <= 60) {
                  updateTerminalSetting("systemManagerTmuxRefreshInterval", val);
                }
              }}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">{t("settings.terminal.serverStats.seconds")}</span>
          </div>
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.systemManager.dockerListRefreshInterval")}
          description={t("settings.terminal.systemManager.dockerListRefreshInterval.desc")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={3}
              max={120}
              value={terminalSettings.systemManagerDockerListRefreshInterval}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 5;
                if (val >= 3 && val <= 120) {
                  updateTerminalSetting("systemManagerDockerListRefreshInterval", val);
                }
              }}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">{t("settings.terminal.serverStats.seconds")}</span>
          </div>
        </SettingRow>
        <SettingRow
          label={t("settings.terminal.systemManager.dockerStatsRefreshInterval")}
          description={t("settings.terminal.systemManager.dockerStatsRefreshInterval.desc")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={2}
              max={60}
              value={terminalSettings.systemManagerDockerStatsRefreshInterval}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 3;
                if (val >= 2 && val <= 60) {
                  updateTerminalSetting("systemManagerDockerStatsRefreshInterval", val);
                }
              }}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">{t("settings.terminal.serverStats.seconds")}</span>
          </div>
        </SettingRow>
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
        <SettingRow
          label={t("settings.terminal.rendering.hibernateHiddenTabs")}
          description={t("settings.terminal.rendering.hibernateHiddenTabs.desc")}
        >
          <Toggle
            checked={terminalSettings.hibernateHiddenTabs}
            onChange={(v) => updateTerminalSetting("hibernateHiddenTabs", v)}
          />
        </SettingRow>
        {terminalSettings.hibernateHiddenTabs && (
          <>
          <SettingRow
            label={t("settings.terminal.rendering.hibernateHiddenTabsDelay")}
            description={t("settings.terminal.rendering.hibernateHiddenTabsDelay.desc")}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={5}
                max={600}
                value={terminalSettings.hibernateHiddenTabsDelaySec}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!Number.isNaN(val) && val >= 5 && val <= 600) {
                    updateTerminalSetting("hibernateHiddenTabsDelaySec", val);
                  }
                }}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">{t("settings.terminal.serverStats.seconds")}</span>
            </div>
          </SettingRow>
          <SettingRow
            label={t("settings.terminal.rendering.hibernateSkipAltScreen")}
            description={t("settings.terminal.rendering.hibernateSkipAltScreen.desc")}
          >
            <Toggle
              checked={terminalSettings.hibernateSkipAltScreen}
              onChange={(v) => updateTerminalSetting("hibernateSkipAltScreen", v)}
            />
          </SettingRow>
          <SettingRow
            label={t("settings.terminal.rendering.hibernateKeepRendererCount")}
            description={t("settings.terminal.rendering.hibernateKeepRendererCount.desc")}
          >
            <Input
              type="number"
              min={0}
              max={12}
              value={terminalSettings.hibernateKeepRendererCount}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!Number.isNaN(val) && val >= 0 && val <= 12) {
                  updateTerminalSetting("hibernateKeepRendererCount", val);
                }
              }}
              className="w-20"
            />
          </SettingRow>
          <SettingRow
            label={t("settings.terminal.rendering.hibernateReplayChunkBytes")}
            description={t("settings.terminal.rendering.hibernateReplayChunkBytes.desc")}
          >
            <Input
              type="number"
              min={4096}
              max={65536}
              step={1024}
              value={terminalSettings.hibernateReplayChunkBytes}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!Number.isNaN(val) && val >= 4096 && val <= 65536) {
                  updateTerminalSetting("hibernateReplayChunkBytes", val);
                }
              }}
              className="w-28"
            />
          </SettingRow>
          <SettingRow
            label={t("settings.terminal.rendering.hibernatePreferWasmSerialize")}
            description={t("settings.terminal.rendering.hibernatePreferWasmSerialize.desc")}
          >
            <Toggle
              checked={terminalSettings.hibernatePreferWasmSerialize}
              onChange={(v) => updateTerminalSetting("hibernatePreferWasmSerialize", v)}
            />
          </SettingRow>
          </>
        )}
      </div>
      {/* Autocomplete */}
      <SectionHeader title={t("settings.terminal.section.workspaceFocus")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
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
            className="w-40"
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
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("settings.terminal.localShell.shell.customArgs")}</label>
              <Input
                value={customArgsDraft}
                placeholder={t("settings.terminal.localShell.shell.customArgs.placeholder")}
                onChange={(e) => setCustomArgsDraft(e.target.value)}
                className="w-full"
              />
              <span className="text-xs text-muted-foreground">{t("settings.terminal.localShell.shell.customArgs.desc")}</span>
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
                updateTerminalSetting("localShellArgs", parseShellArgs(customArgsDraft));
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

export default React.memo(SettingsTerminalTab);
