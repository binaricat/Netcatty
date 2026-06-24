import React, { useMemo, useSyncExternalStore } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  getFontAvailabilityVersion,
  isFontInstalled,
  subscribeFontAvailability,
} from '../../lib/fontAvailability';

const AUTO_SENTINEL = '__auto__';

interface CjkFontOption {
  value: string;
  /** i18n key looked up via t(). Use '' for the Auto sentinel. */
  labelKey: string;
}

// Only true monospace CJK fonts. Proportional CJK fonts (PingFang SC,
// Microsoft YaHei UI, Hiragino Sans GB) render at non-2x widths and
// break terminal grid alignment — they are deliberately excluded here
// even though they are the OS defaults.
const OPTIONS: CjkFontOption[] = [
  { value: '',                       labelKey: 'settings.terminal.font.cjk.option.auto' },
  { value: 'Sarasa Mono SC',         labelKey: 'settings.terminal.font.cjk.option.sarasaSC' },
  { value: 'Sarasa Mono TC',         labelKey: 'settings.terminal.font.cjk.option.sarasaTC' },
  { value: 'Maple Mono CN',          labelKey: 'settings.terminal.font.cjk.option.mapleCN' },
  { value: 'Source Han Mono SC',     labelKey: 'settings.terminal.font.cjk.option.sourceHan' },
  { value: 'Noto Sans Mono CJK SC',  labelKey: 'settings.terminal.font.cjk.option.notoCJK' },
  { value: 'LXGW WenKai Mono',       labelKey: 'settings.terminal.font.cjk.option.lxgwWenkai' },
  { value: 'SimSun',                 labelKey: 'settings.terminal.font.cjk.option.simSun' },
];

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
  const matchedOption = OPTIONS.find((o) => o.value === value);
  const radixValue = value === '' ? AUTO_SENTINEL : (matchedOption?.value ?? value);
  const triggerLabel = matchedOption
    ? t(matchedOption.labelKey)
    : value
      ? t('settings.terminal.font.cjk.option.legacy', { font: value })
      : value;

  // Subscribe to font availability so the filter re-evaluates after the
  // Local Font Access API populates the authoritative install set
  // asynchronously (otherwise the dropdown would show stale availability
  // until the user manually changed `value`).
  const availabilityVersion = useSyncExternalStore(
    subscribeFontAvailability,
    getFontAvailabilityVersion,
    getFontAvailabilityVersion,
  );

  // "Auto" is always present; concrete fonts only appear when installed;
  // the currently-selected value (if any) is also always shown so users
  // can see and clear their setting even on a machine without the font.
  // Legacy selections (e.g. "PingFang SC" saved before we dropped
  // proportional fonts) are appended as a synthetic option with a
  // "not recommended" label so the user can see them and re-pick.
  const visibleOptions = useMemo(() => {
    // The version is read here only so eslint-react-hooks sees it
    // used; in practice we depend on it to invalidate this memo when
    // setSystemFamilies bumps it (isFontInstalled below reads module
    // state, so we need an explicit signal).
    void availabilityVersion;
    const filtered: Array<{ value: string; label: string }> = OPTIONS.filter(
      (opt) =>
        opt.value === '' ||
        opt.value === value ||
        isFontInstalled(opt.value),
    ).map((opt) => ({ value: opt.value, label: t(opt.labelKey) }));
    if (value && !OPTIONS.some((o) => o.value === value)) {
      filtered.push({
        value,
        label: t('settings.terminal.font.cjk.option.legacy', { font: value }),
      });
    }
    return filtered;
  }, [value, availabilityVersion, t]);
  const fitSelectedText = typeof className !== 'string' || !className.includes('w-full');

  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(next) => onChange(next === AUTO_SENTINEL ? '' : next)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 max-w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:min-w-0 [&>span]:truncate [&>span]:whitespace-nowrap',
          fitSelectedText && 'min-w-max',
          className,
        )}
      >
        <SelectPrimitive.Value>
          <span className="block truncate whitespace-nowrap" style={{ fontFamily: value ? `"${value}", monospace` : undefined }}>
            {triggerLabel}
          </span>
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="z-[200000] max-h-80 min-w-[14rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1"
          position="popper"
          sideOffset={4}
        >
          <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
            <ChevronUp className="h-4 w-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1 h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]">
            {visibleOptions.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value || AUTO_SENTINEL}
                value={opt.value || AUTO_SENTINEL}
                className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-4 w-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>
                  <span style={{ fontFamily: opt.value ? `"${opt.value}", monospace` : undefined }}>
                    {opt.label}
                  </span>
                </SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1">
            <ChevronDown className="h-4 w-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
};

export default TerminalCjkFontSelect;
