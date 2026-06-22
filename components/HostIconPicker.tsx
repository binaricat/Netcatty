import React from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import {
  DEFAULT_HOST_ICON_COLOR,
  DEFAULT_HOST_ICON_ID,
  HOST_ICON_COLORS,
  HOST_ICON_IDS,
  isHostIconColorId,
  isHostIconCustomColor,
  isHostIconId,
  resolveHostIconDefaultColorHex,
} from "../domain/hostIcon";
import type { HostIconColorId, HostIconColorMode, HostIconId, HostIconMode } from "../domain/models";
import { cn } from "../lib/utils";
import { renderHostIconGlyph } from "./hostIconRenderer";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type DistroOption = {
  value: string;
  label: string;
  icon?: string;
  bgClass: string;
};

type HostIconPickerProps = {
  distroMode?: "auto" | "manual";
  manualDistro?: string;
  effectiveDistro?: string;
  distroOptions: DistroOption[];
  getDistroOptionLabel: (value?: string) => string;
  iconMode?: HostIconMode;
  iconId?: HostIconId;
  iconColorMode?: HostIconColorMode;
  iconColor?: HostIconColorId;
  iconColorCustom?: string;
  manualIconMenuOpen?: boolean;
  onChange: (next: {
    distroMode?: "auto" | "manual";
    manualDistro?: string;
    iconMode?: HostIconMode;
    iconId?: HostIconId;
    iconColorMode?: HostIconColorMode;
    iconColor?: HostIconColorId;
    iconColorCustom?: string;
  }) => void;
};

const renderBrandOption = (option: DistroOption) => (
  <div className="flex min-w-0 items-center gap-2">
    <div
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[2px]",
        option.bgClass,
      )}
    >
      {option.icon ? (
        <img src={option.icon} alt={option.label} className="h-3 w-3 object-contain invert brightness-0" />
      ) : (
        <div className="h-2 w-2 rounded-full bg-white/70" />
      )}
    </div>
    <span className="truncate whitespace-nowrap">{option.label}</span>
  </div>
);

const renderTypeOption = (iconId: HostIconId, label: string, colorHex: string) => (
  <div className="flex min-w-0 items-center gap-2">
    <div
      className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[2px] text-white"
      style={{ backgroundColor: colorHex }}
    >
      {renderHostIconGlyph(iconId, "h-3 w-3")}
    </div>
    <span className="truncate whitespace-nowrap">{label}</span>
  </div>
);

const renderBrandColorPreview = (option: DistroOption, label: string) => (
  <div className="flex min-w-0 items-center gap-2">
    <span className={cn("h-4 w-4 shrink-0 rounded-full border border-border/70", option.bgClass)} />
    <span className="truncate whitespace-nowrap">{label}</span>
  </div>
);

const renderTypeColorPreview = (label: string, colorHex: string) => (
  <div className="flex min-w-0 items-center gap-2">
    <span className="h-4 w-4 shrink-0 rounded-full border border-border/70" style={{ backgroundColor: colorHex }} />
    <span className="truncate whitespace-nowrap">{label}</span>
  </div>
);

const colorHexForId = (colorId?: HostIconColorId) =>
  HOST_ICON_COLORS.find((color) => color.id === colorId)?.hex || HOST_ICON_COLORS[0].hex;

export const HostIconPicker: React.FC<HostIconPickerProps> = ({
  distroMode,
  manualDistro,
  effectiveDistro,
  distroOptions,
  getDistroOptionLabel,
  iconMode,
  iconId,
  iconColorMode,
  iconColor,
  iconColorCustom,
  manualIconMenuOpen,
  onChange,
}) => {
  const { t } = useI18n();
  const manualSource = distroMode === "manual" || iconMode === "custom";
  const selectedBrandId = manualDistro || effectiveDistro || "linux";
  const selectedBrand = distroOptions.find((option) => option.value === selectedBrandId);
  const selectedIconId = isHostIconId(iconId) ? iconId : DEFAULT_HOST_ICON_ID;
  const selectedIconTab = iconMode === "custom" ? "type" : "brand";
  const manualColor = iconColorMode === "manual" ||
    (iconColorMode !== "auto" && (isHostIconColorId(iconColor) || isHostIconCustomColor(iconColorCustom)));
  const selectedPresetColor = isHostIconColorId(iconColor) ? iconColor : DEFAULT_HOST_ICON_COLOR;
  const selectedCustomColor = isHostIconCustomColor(iconColorCustom) ? iconColorCustom : colorHexForId(selectedPresetColor);
  const selectedColorValue = isHostIconCustomColor(iconColorCustom) ? "custom" : selectedPresetColor;
  const manualPreviewColor = isHostIconCustomColor(iconColorCustom)
    ? selectedCustomColor
    : colorHexForId(selectedPresetColor);
  const selectedTypePreviewColor = manualColor
    ? manualPreviewColor
    : resolveHostIconDefaultColorHex(selectedIconId);
  const autoColorPreviewLabel = selectedIconTab === "type"
    ? t(`hostDetails.icon.option.${selectedIconId}`)
    : getDistroOptionLabel(selectedBrandId);
  const selectedManualIconValue = selectedIconTab === "type" ? `type:${selectedIconId}` : `brand:${selectedBrandId}`;
  const [customColorDraft, setCustomColorDraft] = React.useState(selectedCustomColor);
  const [iconMenuTab, setIconMenuTab] = React.useState<"brand" | "type">(selectedIconTab);

  React.useEffect(() => {
    setCustomColorDraft(selectedCustomColor);
  }, [selectedCustomColor]);

  React.useEffect(() => {
    setIconMenuTab(selectedIconTab);
  }, [selectedIconTab]);

  const setSource = (value: "auto" | "manual") => {
    if (value === "auto") {
      onChange({ distroMode: "auto", iconMode: undefined, iconId: undefined });
      return;
    }
    onChange({
      distroMode: "manual",
      manualDistro: selectedBrandId,
      iconMode: undefined,
      iconId: undefined,
    });
  };

  const setManualIcon = (value: string) => {
    if (value.startsWith("type:")) {
      const nextIconId = value.slice("type:".length);
      if (isHostIconId(nextIconId)) {
        onChange({ distroMode: "manual", iconMode: "custom", iconId: nextIconId });
      }
      return;
    }
    if (value.startsWith("brand:")) {
      onChange({
        distroMode: "manual",
        manualDistro: value.slice("brand:".length),
        iconMode: undefined,
        iconId: undefined,
      });
    }
  };

  const switchIconMenuTab = (nextTab: "brand" | "type") => {
    setIconMenuTab(nextTab);
  };

  const setColorMode = (value: "auto" | "manual") => {
    if (value === "auto") {
      onChange({ iconColorMode: "auto", iconColor: undefined, iconColorCustom: undefined });
      return;
    }
    onChange({ iconColorMode: "manual", iconColor: selectedPresetColor, iconColorCustom: undefined });
  };

  const setColorChoice = (value: string) => {
    if (value === "custom") {
      onChange({ iconColorMode: "manual", iconColor: undefined, iconColorCustom: selectedCustomColor });
      return;
    }
    if (isHostIconColorId(value)) {
      onChange({ iconColorMode: "manual", iconColor: value, iconColorCustom: undefined });
    }
  };

  const setCustomColor = (value: string) => {
    setCustomColorDraft(value);
    if (isHostIconCustomColor(value)) {
      onChange({
        iconColorMode: "manual",
        iconColor: undefined,
        iconColorCustom: value,
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("hostDetails.icon.source")}</span>
          <Select value={manualSource ? "manual" : "auto"} onValueChange={(value) => setSource(value as "auto" | "manual")}>
            <SelectTrigger className="h-8" aria-label={t("hostDetails.icon.source")}>
              <span className="truncate whitespace-nowrap pr-2 text-left">
                {manualSource ? t("hostDetails.distro.mode.manual") : t("hostDetails.distro.mode.auto")}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("hostDetails.distro.mode.auto")}</SelectItem>
              <SelectItem value="manual">{t("hostDetails.distro.mode.manual")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {manualSource ? (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("hostDetails.icon.manualLabel")}</span>
            <Select
              value={selectedManualIconValue}
              onValueChange={setManualIcon}
              {...(manualIconMenuOpen === undefined ? {} : { open: manualIconMenuOpen })}
            >
              <SelectTrigger className="h-8" aria-label={t("hostDetails.icon.manualLabel")}>
                {selectedIconTab === "type"
                  ? renderTypeOption(selectedIconId, t(`hostDetails.icon.option.${selectedIconId}`), selectedTypePreviewColor)
                  : selectedBrand
                    ? renderBrandOption(selectedBrand)
                    : <SelectValue placeholder={t("hostDetails.distro.unknown")} />}
              </SelectTrigger>
              <SelectContent className="min-w-[16rem]" hideScrollButtons>
                <div className="sticky top-0 z-10 bg-popover px-1 pb-1">
                  <div className="grid h-8 grid-cols-2 rounded-md bg-muted/50 p-0.5">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={iconMenuTab === "brand"}
                      className={cn(
                        "rounded-sm text-xs font-medium transition-colors",
                        iconMenuTab === "brand" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                      )}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        switchIconMenuTab("brand");
                      }}
                    >
                      {t("hostDetails.icon.tab.brand")}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={iconMenuTab === "type"}
                      className={cn(
                        "rounded-sm text-xs font-medium transition-colors",
                        iconMenuTab === "type" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                      )}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        switchIconMenuTab("type");
                      }}
                    >
                      {t("hostDetails.icon.tab.type")}
                    </button>
                  </div>
                </div>
                {iconMenuTab === "brand"
                  ? distroOptions.map((option) => (
                    <SelectItem key={option.value} value={`brand:${option.value}`}>
                      {renderBrandOption(option)}
                    </SelectItem>
                  ))
                  : HOST_ICON_IDS.map((optionIconId) => (
                    <SelectItem key={optionIconId} value={`type:${optionIconId}`}>
                      {renderTypeOption(
                        optionIconId,
                        t(`hostDetails.icon.option.${optionIconId}`),
                        manualColor ? manualPreviewColor : resolveHostIconDefaultColorHex(optionIconId),
                      )}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("hostDetails.distro.detectedLabel")}</span>
            <div className="flex h-8 items-center rounded-md border border-border/60 bg-background/50 px-3 text-sm">
              {effectiveDistro ? getDistroOptionLabel(effectiveDistro) : t("hostDetails.distro.unknown")}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border/60 pt-3">
        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("hostDetails.icon.colorLabel")}</span>
            <Select value={manualColor ? "manual" : "auto"} onValueChange={(value) => setColorMode(value as "auto" | "manual")}>
              <SelectTrigger className="h-8" aria-label={t("hostDetails.icon.colorLabel")}>
                <span className="truncate whitespace-nowrap pr-2 text-left">
                  {manualColor ? t("hostDetails.icon.colorManual") : t("hostDetails.icon.colorAuto")}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("hostDetails.icon.colorAuto")}</SelectItem>
                <SelectItem value="manual">{t("hostDetails.icon.colorManual")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {manualColor ? (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("hostDetails.icon.colorChoice")}</span>
              <Select value={selectedColorValue} onValueChange={setColorChoice}>
                <SelectTrigger className="h-8" aria-label={t("hostDetails.icon.colorChoice")}>
                  <div className="flex min-w-0 items-center gap-2 pr-2">
                    <span className="h-4 w-4 shrink-0 rounded-full border border-border/70" style={{ backgroundColor: manualPreviewColor }} />
                    <span className="truncate whitespace-nowrap">
                      {selectedColorValue === "custom"
                        ? t("hostDetails.icon.color.custom")
                        : t(`hostDetails.icon.color.${selectedPresetColor}`)}
                    </span>
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {HOST_ICON_COLORS.map((color) => (
                    <SelectItem key={color.id} value={color.id}>
                      <div className="flex items-center gap-2">
                        <span className="h-4 w-4 rounded-full border border-border/70" style={{ backgroundColor: color.hex }} />
                        <span>{t(`hostDetails.icon.color.${color.id}`)}</span>
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">{t("hostDetails.icon.color.custom")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("hostDetails.icon.autoColorLabel")}</span>
              <div className="flex h-8 items-center rounded-md border border-border/60 bg-background/50 px-3 text-sm">
                {selectedIconTab === "type"
                  ? renderTypeColorPreview(autoColorPreviewLabel, selectedTypePreviewColor)
                  : selectedBrand
                    ? renderBrandColorPreview(selectedBrand, autoColorPreviewLabel)
                    : renderTypeColorPreview(t("hostDetails.distro.unknown"), colorHexForId(DEFAULT_HOST_ICON_COLOR))}
              </div>
            </div>
          )}
        </div>

        {manualColor && selectedColorValue === "custom" && (
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="color"
              value={isHostIconCustomColor(customColorDraft) ? customColorDraft : selectedCustomColor}
              onChange={(event) => setCustomColor(event.target.value)}
              className="h-8 w-12 shrink-0 cursor-pointer p-1"
              aria-label={t("hostDetails.icon.color.custom")}
            />
            <Input
              value={customColorDraft}
              onChange={(event) => setCustomColor(event.target.value)}
              className="h-8 font-mono text-xs"
              aria-label={t("hostDetails.icon.color.custom")}
            />
          </div>
        )}
      </div>
    </div>
  );
};
