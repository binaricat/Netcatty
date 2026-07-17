import React, { useMemo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
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
}

export const TerminalCjkFontSelect: React.FC<Props> = ({
  value,
  onChange,
  className,
  disabled,
}) => {
  const { t } = useI18n();
  const installedFamilies = useInstalledFontFamilies();
  const isLoading = useFontsLoading();

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
      unavailable: t('settings.terminal.font.cjk.option.unavailable'),
    };

    return built.map((option) => {
      const label = option.kind === 'auto'
        ? t('settings.terminal.font.cjk.option.auto')
        : option.value;
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

  const status = getTerminalCjkFontSelectionStatus(
    value,
    installedFamilies,
    availableRecommendedFamilies,
    Boolean(value && isFontInstalled(value)),
  );
  const selectedFontFamily = previewFontFamily(value);

  return (
    <div className={cn('space-y-2', className)}>
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
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          aria-label={t('settings.terminal.font.cjk.refresh')}
          title={t('settings.terminal.font.cjk.refresh')}
          disabled={disabled || isLoading}
          onClick={() => void refreshFonts()}
        >
          <RefreshCw size={14} className={cn(isLoading && 'animate-spin')} />
        </Button>
      </div>

      {value && (
        <div
          className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm"
          style={{ fontFamily: selectedFontFamily }}
        >
          ABC 你好 123 │ ──
        </div>
      )}

      {status === 'alignment-risk' && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{t('settings.terminal.font.cjk.alignmentWarning')}</span>
        </p>
      )}
      {status === 'unavailable' && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{t('settings.terminal.font.cjk.unavailableWarning')}</span>
        </p>
      )}
    </div>
  );
};

export default TerminalCjkFontSelect;
