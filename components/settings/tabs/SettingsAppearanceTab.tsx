import React, { useCallback } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { DARK_UI_THEMES, LIGHT_UI_THEMES } from "../../../infrastructure/config/uiThemes";
import { SUPPORTED_UI_LOCALES } from "../../../infrastructure/config/i18n";
import { cn } from "../../../lib/utils";
import { SectionHeader, SettingsTabContent, SettingRow, Toggle, Select } from "../settings-ui";

export default function SettingsAppearanceTab(props: {
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  lightUiThemeId: string;
  setLightUiThemeId: (themeId: string) => void;
  darkUiThemeId: string;
  setDarkUiThemeId: (themeId: string) => void;
  uiLanguage: string;
  setUiLanguage: (language: string) => void;
  customCSS: string;
  setCustomCSS: (css: string) => void;
}) {
  const { t } = useI18n();
  const {
    theme,
    setTheme,
    lightUiThemeId,
    setLightUiThemeId,
    darkUiThemeId,
    setDarkUiThemeId,
    uiLanguage,
    setUiLanguage,
    customCSS,
    setCustomCSS,
  } = props;

  const getHslStyle = useCallback((hsl: string) => ({ backgroundColor: `hsl(${hsl})` }), []);

  const renderThemeSwatches = (
    options: { id: string; name: string; tokens: { background: string } }[],
    value: string,
    onChange: (next: string) => void,
  ) => (
    <div className="flex flex-wrap gap-2 justify-end">
      {options.map((preset) => (
        <button
          key={preset.id}
          onClick={() => onChange(preset.id)}
          className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center transition-all shadow-sm border border-border/70",
            value === preset.id
              ? "ring-2 ring-offset-2 ring-foreground scale-110"
              : "hover:scale-105",
          )}
          style={getHslStyle(preset.tokens.background)}
          title={preset.name}
        >
          {value === preset.id && <Check className="text-white drop-shadow-md" size={10} />}
        </button>
      ))}
    </div>
  );

  return (
    <SettingsTabContent value="appearance">
      <SectionHeader title={t("settings.appearance.language")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.appearance.language")}
          description={t("settings.appearance.language.desc")}
        >
          <Select
            value={uiLanguage}
            options={SUPPORTED_UI_LOCALES.map((l) => ({ value: l.id, label: l.label }))}
            onChange={(v) => setUiLanguage(v)}
            className="w-40"
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.appearance.uiTheme")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.appearance.darkMode")}
          description={t("settings.appearance.darkMode.desc")}
        >
          <div className="flex items-center gap-2">
            <Sun size={14} className="text-muted-foreground" />
            <Toggle checked={theme === "dark"} onChange={(v) => setTheme(v ? "dark" : "light")} />
            <Moon size={14} className="text-muted-foreground" />
          </div>
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.appearance.themeColor")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.appearance.themeColor.light")}
          description={t("settings.appearance.themeColor.desc")}
        >
          {renderThemeSwatches(LIGHT_UI_THEMES, lightUiThemeId, setLightUiThemeId)}
        </SettingRow>
        <SettingRow label={t("settings.appearance.themeColor.dark")}>
          {renderThemeSwatches(DARK_UI_THEMES, darkUiThemeId, setDarkUiThemeId)}
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.appearance.customCss")} />
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("settings.appearance.customCss.desc")}
        </p>
        <textarea
          value={customCSS}
          onChange={(e) => setCustomCSS(e.target.value)}
          placeholder={t("settings.appearance.customCss.placeholder")}
          className="w-full h-32 px-3 py-2 text-xs font-mono bg-muted/50 border border-border rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-primary/50"
          spellCheck={false}
        />
      </div>
    </SettingsTabContent>
  );
}
