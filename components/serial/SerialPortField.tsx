import React from "react";
import { RefreshCw, Usb } from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Combobox, type ComboboxOption } from "../ui/combobox";
import { Label } from "../ui/label";

export interface SerialPortFieldProps {
  value: string;
  onChange: (value: string) => void;
  portOptions: ComboboxOption[];
  isLoadingPorts: boolean;
  onRefresh: () => void;
  isPortValid: boolean;
  showRefreshIcon?: boolean;
}

export const SerialPortField: React.FC<SerialPortFieldProps> = ({
  value,
  onChange,
  portOptions,
  isLoadingPorts,
  onRefresh,
  isPortValid,
  showRefreshIcon = false,
}) => {
  const { t } = useI18n();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="serial-port">{t("serial.field.port")}</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoadingPorts}
          className="h-6 px-2 text-xs"
        >
          {showRefreshIcon && (
            <RefreshCw size={12} className={cn("mr-1", isLoadingPorts && "animate-spin")} />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      <Combobox
        options={portOptions}
        value={value}
        onValueChange={onChange}
        placeholder={t("serial.field.selectPort")}
        emptyText={t("serial.noPorts")}
        allowCreate
        createText={t("common.use")}
        icon={<Usb size={14} className="text-muted-foreground" />}
      />

      <p className="text-xs text-muted-foreground">
        {t("serial.field.namedPipeHint")}
      </p>
      {!isPortValid && value && (
        <p className="text-xs text-destructive">
          {t("serial.field.customPortPlaceholder")}
        </p>
      )}
    </div>
  );
};
