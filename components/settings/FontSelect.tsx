import React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { UIFont } from '../../infrastructure/config/uiFonts';

interface FontSelectProps {
  value: string;
  fonts: UIFont[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export const FontSelect: React.FC<FontSelectProps> = ({
  value,
  fonts,
  onChange,
  className,
  disabled,
}) => {
  const selectedFont = fonts.find(f => f.id === value);
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
          className="z-[200000] max-h-80 min-w-[12rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1"
          position="popper"
          sideOffset={4}
        >
          <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
            <ChevronUp className="h-4 w-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1 h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]">
            {fonts.map((font) => (
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

export default FontSelect;
