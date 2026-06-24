import React, { useMemo, useSyncExternalStore } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  extractPrimaryFamily,
  getFontAvailabilityVersion,
  hasAuthoritativeData,
  isFontInstalled,
  subscribeFontAvailability,
} from '../../lib/fontAvailability';
import type { TerminalFont } from '../../infrastructure/config/fonts';

interface TerminalFontSelectProps {
  value: string;
  fonts: TerminalFont[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export const TerminalFontSelect: React.FC<TerminalFontSelectProps> = ({
  value,
  fonts,
  onChange,
  className,
  disabled,
}) => {
  const selectedFont = fonts.find(f => f.id === value);

  // Subscribe to font availability so the filter re-evaluates after the
  // Local Font Access API populates the authoritative install set
  // asynchronously, even if the `fonts` prop ref hasn't changed.
  const availabilityVersion = useSyncExternalStore(
    subscribeFontAvailability,
    getFontAvailabilityVersion,
    getFontAvailabilityVersion,
  );

  // Hide fonts that aren't actually rendered on this machine so users
  // don't pick a font and then see no visible change. The currently
  // selected font is always shown so the user can read their setting.
  //
  // When the Local Font Access API has populated authoritative data,
  // trust it: an empty or near-empty result means the user really has
  // few monospace fonts (Layer 3 still gives at least one option via
  // bundled Sarasa Mono SC). When canvas-only fallback is in play,
  // we keep a safety net at length>=1 to avoid an empty dropdown if
  // detection misfires.
  const visibleFonts = useMemo(() => {
    // Referenced so eslint-react-hooks sees the dep used; the real
    // purpose is to invalidate this memo when setSystemFamilies bumps
    // the version (isFontInstalled reads module state).
    void availabilityVersion;
    const filtered = fonts.filter(
      (f) => f.id === value || isFontInstalled(extractPrimaryFamily(f.family)),
    );
    if (hasAuthoritativeData()) return filtered;
    return filtered.length >= 1 ? filtered : fonts;
  }, [fonts, value, availabilityVersion]);
  const fitSelectedText = typeof className !== 'string' || !className.includes('w-full');

  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 max-w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:min-w-0 [&>span]:truncate [&>span]:whitespace-nowrap',
          fitSelectedText && 'min-w-max',
          className
        )}
      >
        <SelectPrimitive.Value>
          <span className="block truncate whitespace-nowrap" style={{ fontFamily: selectedFont?.family }}>
            {selectedFont?.name || value}
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
            {visibleFonts.map((font) => (
              <SelectPrimitive.Item
                key={font.id}
                value={font.id}
                className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-4 w-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>
                  <span style={{ fontFamily: font.family }}>{font.name}</span>
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

export default TerminalFontSelect;
