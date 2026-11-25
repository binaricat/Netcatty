import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  refreshFonts,
  useFontsLoading,
  useInstalledFontFamilies,
} from '../../application/state/fontStore';
import { isFontInstalled } from '../../lib/fontAvailability';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  buildTerminalCjkFontOptions,
  getTerminalCjkFontSelectionStatus,
  RECOMMENDED_CJK_FONT_FAMILIES,
  type TerminalCjkFontOptionKind,
} from '../../domain/terminalCjkFonts';

const previewFontFamily = (family: string): string | undefined => {
  const trimmed = family.trim();
  if (!trimmed) return undefined;
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}", monospace`;
};

interface Props {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  label?: string;
  description?: string;
}

export const TerminalCjkFontSelect: React.FC<Props> = ({
  value,
  onChange,
  className,
  disabled,
  label,
  description,
}) => {
  const { t } = useI18n();
  const installedFamilies = useInstalledFontFamilies();
  const isLoading = useFontsLoading();
  const [previewValue, setPreviewValue] = useState(value);

  useEffect(() => {
    setPreviewValue(value);
  }, [value]);

  const availableRecommendedFamilies = RECOMMENDED_CJK_FONT_FAMILIES.filter(
    (family) => isFontInstalled(family),
  );

  const options = useMemo<ComboboxOption[]>(() => {
    const built = buildTerminalCjkFontOptions({
      installedFamilies,
      selectedValue: value,
      availableRecommendedFamilies,
    });
    const kindLabels: Record<TerminalCjkFontOptionKind, string> = {
      auto: '',
      recommended: t('settings.terminal.font.cjk.option.recommended'),
      installed: t('settings.terminal.font.cjk.option.installed'),
      unverified: t('settings.terminal.font.cjk.option.unverified'),
      unavailable: t('settings.terminal.font.cjk.option.unavailable'),
    };

    return built.map((option) => {
      const label = option.kind === 'auto'
        ? t('settings.terminal.font.cjk.option.auto')
        : option.value.trim();
      return {
        value: option.value,
        label,
        sublabel: kindLabels[option.kind] || undefined,
        labelStyle: option.value
          ? { fontFamily: previewFontFamily(option.value) }
          : undefined,
      };
    });
  }, [availableRecommendedFamilies, installedFamilies, t, value]);

  const previewSelection = previewValue.trim();
  const status = getTerminalCjkFontSelectionStatus(
    previewSelection,
    installedFamilies,
    availableRecommendedFamilies,
    Boolean(previewSelection && isFontInstalled(previewSelection)),
  );
  const selectedFontFamily = previewFontFamily(value);
  const previewFamily = previewFontFamily(previewValue);
  const controls = (
    <div className="flex items-center gap-2">
      <Combobox
        options={options}
        value={value}
        onValueChange={onChange}
        placeholder={t('settings.terminal.font.cjk.searchPlaceholder')}
        emptyText={t('settings.terminal.font.cjk.empty')}
        allowCreate
        createText={t('settings.terminal.font.cjk.useCustom')}
        triggerClassName="h-9"
        inputStyle={{ fontFamily: selectedFontFamily }}
        onInputValueChange={setPreviewValue}
        disabled={disabled}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              aria-label={t('settings.terminal.font.cjk.refresh')}
              disabled={disabled || isLoading}
              onClick={() => void refreshFonts()}
            >
              <RefreshCw size={14} className={cn(isLoading && 'animate-spin')} />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('settings.terminal.font.cjk.refresh')}</TooltipContent>
      </Tooltip>
    </div>
  );

  const preview = previewValue.trim() && (
    <>
      <pre
        className="m-0 py-2 text-center text-base leading-7 text-foreground"
        style={{ fontFamily: previewFamily }}
      >
        {'你好 │ ABC  │ 123\n123  │ 测试 │ ABC'}
      </pre>

      {status === 'alignment-risk' && (
        <p className="m-0 text-center text-xs text-amber-600 dark:text-amber-400">
          {t('settings.terminal.font.cjk.alignmentWarning')}
        </p>
      )}
      {status === 'unavailable' && (
        <p className="m-0 text-center text-xs text-muted-foreground">
          {t('settings.terminal.font.cjk.unavailableWarning')}
        </p>
      )}
    </>
  );

  if (label) {
    return (
      <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 py-3', className)}>
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
        </div>
        <div className="w-72 shrink-0">{controls}</div>
        {preview && <div className="col-span-2 justify-self-center">{preview}</div>}
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {controls}
      {preview}
    </div>
  );
};

export default TerminalCjkFontSelect;
