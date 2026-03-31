import React, { useCallback } from "react";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { DARK_UI_THEMES, LIGHT_UI_THEMES } from "../../../infrastructure/config/uiThemes";
import { useAvailableUIFonts } from "../../../application/state/uiFontStore";
import { SUPPORTED_UI_LOCALES } from "../../../infrastructure/config/i18n";
import { cn } from "../../../lib/utils";
import { SectionHeader, SettingsTabContent, SettingRow, Toggle, Select } from "../settings-ui";
import { FontSelect } from "../FontSelect";
import { STORAGE_KEY_SHOW_RECENT_HOSTS } from "../../../infrastructure/config/storageKeys";
import { useStoredBoolean } from "../../../application/state/useStoredBoolean";

export default function SettingsAppearanceTab(props: {
  theme: "dark" | "light" | "system";
  setTheme: (theme: "dark" | "light" | "system") => void;
  lightUiThemeId: string;
  setLightUiThemeId: (themeId: string) => void;
  darkUiThemeId: string;
  setDarkUiThemeId: (themeId: string) => void;
  accentMode: "theme" | "custom";
  setAccentMode: (mode: "theme" | "custom") => void;
  customAccent: string;
  setCustomAccent: (color: string) => void;
  uiFontFamilyId: string;
  setUiFontFamilyId: (fontId: string) => void;
  uiLanguage: string;
  setUiLanguage: (language: string) => void;
  customCSS: string;
  setCustomCSS: (css: string) => void;
  isImmersive?: boolean;
  onToggleImmersive?: () => void;
}) {
  const { t } = useI18n();
  const availableUIFonts = useAvailableUIFonts();
  const {
    theme,
    setTheme,
    lightUiThemeId,
    setLightUiThemeId,
    darkUiThemeId,
    setDarkUiThemeId,
    accentMode,
    setAccentMode,
    customAccent,
    setCustomAccent,
    uiFontFamilyId,
    setUiFontFamilyId,
    uiLanguage,
    setUiLanguage,
    customCSS,
    setCustomCSS,
    isImmersive: _isImmersive,
    onToggleImmersive: _onToggleImmersive,
  } = props;

  const [showRecentHosts, setShowRecentHosts] = useStoredBoolean(
    STORAGE_KEY_SHOW_RECENT_HOSTS,
    true,
  );

  const getHslStyle = useCallback((hsl: string) => ({ backgroundColor: `hsl(${hsl})` }), []);

  const hexToHsl = useCallback((hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          break;
        case g:
          h = ((b - r) / d + 2) / 6;
          break;
        case b:
          h = ((r - g) / d + 4) / 6;
          break;
      }
    }
    return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
  }, []);

  const ACCENT_COLORS = [
    { name: "Sky", value: "199 89% 48%" },
    { name: "Blue", value: "221.2 83.2% 53.3%" },
    { name: "Indigo", value: "234 89% 62%" },
    { name: "Violet", value: "262.1 83.3% 57.8%" },
    { name: "Purple", value: "271 81% 56%" },
    { name: "Fuchsia", value: "292 84% 61%" },
    { name: "Pink", value: "330 81% 60%" },
    { name: "Rose", value: "346.8 77.2% 49.8%" },
    { name: "Red", value: "0 84.2% 60.2%" },
    { name: "Orange", value: "24.6 95% 53.1%" },
    { name: "Amber", value: "38 92% 50%" },
    { name: "Yellow", value: "48 96% 53%" },
    { name: "Lime", value: "84 81% 44%" },
    { name: "Green", value: "142.1 76.2% 36.3%" },
    { name: "Emerald", value: "160 84% 39%" },
    { name: "Teal", value: "173 80% 40%" },
    { name: "Cyan", value: "189 94% 43%" },
    { name: "Slate", value: "215 16% 47%" },
  ];

  const THEME_OPTIONS: { value: "light" | "system" | "dark"; icon: React.ReactNode; label: string }[] = [
    { value: "light", icon: <Sun size={14} />, label: t("settings.appearance.theme.light") },
    { value: "system", icon: <Monitor size={14} />, label: t("settings.appearance.theme.system") },
    { value: "dark", icon: <Moon size={14} />, label: t("settings.appearance.theme.dark") },
  ];

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
        <SettingRow
          label={t("settings.appearance.uiFont")}
          description={t("settings.appearance.uiFont.desc")}
        >
          <FontSelect
            value={uiFontFamilyId}
            fonts={availableUIFonts}
            onChange={(v) => setUiFontFamilyId(v)}
            className="w-48"
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.appearance.uiTheme")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.appearance.theme")}
          description={t("settings.appearance.theme.desc")}
        >
          <div className="flex items-center rounded-lg border border-border bg-muted/50 p-0.5">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  theme === opt.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.appearance.accentColor")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.appearance.accentColor.mode")}
          description={t("settings.appearance.accentColor.mode.desc")}
        >
          <div className="flex items-center gap-2">
            <Toggle
              checked={accentMode === "custom"}
              onChange={(checked) => setAccentMode(checked ? "custom" : "theme")}
            />
          </div>
        </SettingRow>
        {accentMode === "custom" && (
          <div className="py-3 space-y-2">
            <div className="text-sm font-medium">{t("settings.appearance.accentColor.custom")}</div>
            <div className="flex flex-wrap gap-2">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c.name}
                  onClick={() => setCustomAccent(c.value)}
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center transition-all shadow-sm",
                    customAccent === c.value
                      ? "ring-2 ring-offset-2 ring-foreground scale-110"
                      : "hover:scale-105",
                  )}
                  style={getHslStyle(c.value)}
                  title={c.name}
                >
                  {customAccent === c.value && <Check className="text-white drop-shadow-md" size={10} />}
                </button>
              ))}
              <label
                className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center transition-all shadow-sm cursor-pointer",
                  "bg-gradient-to-br from-pink-500 via-purple-500 to-blue-500",
                  !ACCENT_COLORS.some((c) => c.value === customAccent)
                    ? "ring-2 ring-offset-2 ring-foreground scale-110"
                    : "hover:scale-105",
                )}
                title={t("settings.appearance.customColor")}
              >
                <input
                  type="color"
                  className="sr-only"
                  onChange={(e) => setCustomAccent(hexToHsl(e.target.value))}
                />
                {!ACCENT_COLORS.some((c) => c.value === customAccent) ? (
                  <Check className="text-white drop-shadow-md" size={10} />
                ) : (
                  <Palette size={12} className="text-white drop-shadow-md" />
                )}
              </label>
            </div>
          </div>
        )}
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

      <SectionHeader title={t("settings.vault.title")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t('settings.vault.showRecentHosts')}
          description={t('settings.vault.showRecentHostsDesc')}
        >
          <Toggle checked={showRecentHosts} onChange={setShowRecentHosts} />
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
