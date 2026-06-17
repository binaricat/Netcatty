import { RotateCcw } from "lucide-react";
import React from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import {
  DEFAULT_HOST_ICON_COLOR,
  DEFAULT_HOST_ICON_ID,
  HOST_ICON_COLORS,
  HOST_ICON_IDS,
  isHostIconColorId,
  isHostIconId,
  normalizeHostIconSelection,
} from "../domain/hostIcon";
import type { HostIconColorId, HostIconId, HostIconMode } from "../domain/models";
import { cn } from "../lib/utils";
import { renderHostIconGlyph } from "./hostIconRenderer";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type HostIconPickerProps = {
  iconMode?: HostIconMode;
  iconId?: HostIconId;
  iconColor?: HostIconColorId;
  onChange: (next: { iconMode?: HostIconMode; iconId?: HostIconId; iconColor?: HostIconColorId }) => void;
  onReset: () => void;
};

export const HostIconPicker: React.FC<HostIconPickerProps> = ({
  iconMode,
  iconId,
  iconColor,
  onChange,
  onReset,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const custom = iconMode === "custom";
  const normalizedSelection = normalizeHostIconSelection({ iconMode, iconId, iconColor });
  const selectedIconId = custom && isHostIconId(normalizedSelection.iconId)
    ? normalizedSelection.iconId
    : DEFAULT_HOST_ICON_ID;
  const hasCustomColor = isHostIconColorId(normalizedSelection.iconColor);
  const selectedColor = hasCustomColor ? normalizedSelection.iconColor : DEFAULT_HOST_ICON_COLOR;
  const selectedColorHex =
    HOST_ICON_COLORS.find((color) => color.id === selectedColor)?.hex || HOST_ICON_COLORS[0].hex;

  const setCustom = () => onChange({ iconMode: "custom", iconId: selectedIconId, iconColor: selectedColor });
  const updateIcon = (nextIconId: HostIconId) =>
    onChange({ iconMode: "custom", iconId: nextIconId, iconColor: selectedColor });
  const updateColor = (nextColor: HostIconColorId) => {
    if (custom) {
      onChange({ iconMode: "custom", iconId: selectedIconId, iconColor: nextColor });
      return;
    }
    onChange({ iconMode: "auto", iconColor: nextColor });
  };
  const visibleIconIds = custom && !expanded ? HOST_ICON_IDS.slice(0, 10) : HOST_ICON_IDS;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={custom ? "ghost" : "secondary"}
          size="sm"
          className="h-8 flex-1"
          onClick={onReset}
        >
          {t("hostDetails.icon.mode.auto")}
        </Button>
        <Button
          type="button"
          variant={custom ? "secondary" : "ghost"}
          size="sm"
          className="h-8 flex-1"
          onClick={setCustom}
        >
          {t("hostDetails.icon.mode.custom")}
        </Button>
        {(custom || hasCustomColor) && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onReset}
            aria-label={t("hostDetails.icon.reset")}
          >
            <RotateCcw size={14} />
          </Button>
        )}
      </div>

      {custom && (
        <div className="space-y-2">
          <div className="grid grid-cols-5 gap-2">
            {visibleIconIds.map((optionIconId) => {
              const selected = selectedIconId === optionIconId;
              return (
                <Tooltip key={optionIconId}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t(`hostDetails.icon.option.${optionIconId}`)}
                      aria-pressed={selected}
                      className={cn(
                        "flex h-9 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-secondary",
                        selected ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/60",
                      )}
                      onClick={() => updateIcon(optionIconId)}
                    >
                      {renderHostIconGlyph(optionIconId, "h-4 w-4")}
                      <span className="sr-only">{t(`hostDetails.icon.option.${optionIconId}`)}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t(`hostDetails.icon.option.${optionIconId}`)}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => setExpanded((value) => !value)}
          >
            {t(expanded ? "hostDetails.icon.hideLibrary" : "hostDetails.icon.showLibrary")}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-8 gap-2">
        {HOST_ICON_COLORS.map((color) => {
          const selected = hasCustomColor && selectedColor === color.id;
          return (
            <Tooltip key={color.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t(`hostDetails.icon.color.${color.id}`)}
                  aria-pressed={selected}
                  className={cn(
                    "h-7 rounded-md border transition-transform hover:scale-105",
                    selected ? "border-primary ring-2 ring-primary/30" : "border-border/60",
                  )}
                  style={{ backgroundColor: color.hex }}
                  onClick={() => updateColor(color.id)}
                >
                  <span className="sr-only">{t(`hostDetails.icon.color.${color.id}`)}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t(`hostDetails.icon.color.${color.id}`)}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-secondary/40 px-2.5 py-2 text-xs text-muted-foreground">
        <span className="h-4 w-4 rounded" style={{ backgroundColor: hasCustomColor ? selectedColorHex : undefined }} />
        <span>{t(custom ? "hostDetails.icon.customOverridesDistro" : "hostDetails.icon.autoUsesDistro")}</span>
      </div>
    </div>
  );
};
