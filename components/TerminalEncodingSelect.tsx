import React from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface TerminalEncodingSelectProps {
  value?: string;
  inheritedValue?: string;
  onValueChange: (value: string | undefined) => void;
  className?: string;
}

const SUPPORTED_ENCODINGS = ["UTF-8", "GB18030"] as const;

export const resolveTerminalEncodingSelectValue = (value?: string): string => {
  const normalized = value?.trim() || "UTF-8";
  return SUPPORTED_ENCODINGS.find(
    (encoding) => encoding.toLowerCase() === normalized.toLowerCase(),
  ) || normalized;
};

export const getTerminalEncodingOptions = (currentValue?: string): string[] => {
  const normalizedCurrent = currentValue?.trim();
  if (!normalizedCurrent) return [...SUPPORTED_ENCODINGS];
  if (SUPPORTED_ENCODINGS.some((encoding) => encoding.toLowerCase() === normalizedCurrent.toLowerCase())) {
    return [...SUPPORTED_ENCODINGS];
  }
  return [normalizedCurrent, ...SUPPORTED_ENCODINGS];
};

export const TerminalEncodingSelect: React.FC<TerminalEncodingSelectProps> = ({
  value,
  inheritedValue,
  onValueChange,
  className = "h-10 w-full",
}) => {
  const { t } = useI18n();
  const effectiveValue = resolveTerminalEncodingSelectValue(value || inheritedValue);
  const options = getTerminalEncodingOptions(effectiveValue);
  const fallbackValue = "__fallback__";
  const selectedValue = value ? resolveTerminalEncodingSelectValue(value) : fallbackValue;
  const fallbackLabel = inheritedValue
    ? `${t("vault.groups.details.inherited")} (${resolveTerminalEncodingSelectValue(inheritedValue)})`
    : value
      ? `${t("common.reset")} (UTF-8)`
      : "UTF-8";

  return (
    <Select
      value={selectedValue}
      onValueChange={(nextValue) => onValueChange(nextValue === fallbackValue ? undefined : nextValue)}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder={t("terminal.toolbar.encoding")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={fallbackValue}>{fallbackLabel}</SelectItem>
        {options.map((encoding) => (
          <SelectItem key={encoding} value={encoding}>
            {encoding}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
