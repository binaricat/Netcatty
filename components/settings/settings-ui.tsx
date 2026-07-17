import React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";
import { TabsContent } from "../ui/tabs";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      checked ? "bg-primary" : "bg-input",
    )}
  >
    <span
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
        checked ? "translate-x-4" : "translate-x-0",
      )}
    />
  </button>
);

interface SelectProps {
  value: string;
  options: { value: string; label: string; icon?: React.ReactNode }[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

export const Select: React.FC<SelectProps> = ({
  value,
  options,
  onChange,
  className,
  disabled,
  placeholder,
}) => {
  const selectedOption = options.find((opt) => opt.value === value);
  const fitSelectedText = typeof className !== "string" || !className.includes("w-full");
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          "flex h-9 max-w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:min-w-0 [&>span]:truncate [&>span]:whitespace-nowrap",
          fitSelectedText && "min-w-max",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder}>
          <span className="flex min-w-0 items-center gap-2 truncate whitespace-nowrap">
            {selectedOption?.icon}
            <span className="truncate whitespace-nowrap">{selectedOption?.label}</span>
          </span>
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="z-[200000] max-h-80 w-max max-w-[min(24rem,var(--radix-select-content-available-width))] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1"
          position="popper"
          sideOffset={4}
          style={{ minWidth: "max(12rem, var(--radix-select-trigger-width))" }}
        >
          <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
            <ChevronUp className="h-4 w-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                className="relative flex w-full min-w-0 cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-4 w-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>
                  <span className="flex min-w-0 items-center gap-2 whitespace-normal break-words leading-snug">
                    {opt.icon}
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

export const SectionHeader: React.FC<{ title: string; className?: string }> = ({
  title,
  className,
}) => <h3 className={cn("text-sm font-semibold text-foreground mb-3", className)}>{title}</h3>;

/** Section title row → content gap (shared across settings pages). */
export const settingsSectionGapClassName = "gap-2";

/** Groups a section title (optional icon/actions) with its content at a uniform gap. */
export const SettingsSection: React.FC<{
  title?: string;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, leading, actions, children, className }) => (
  <section className={cn("flex flex-col", settingsSectionGapClassName, className)}>
    {(title || leading || actions) && (
      <div
        className={cn(
          "flex min-h-8 items-center gap-2",
          actions && "justify-between gap-4",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          {title ? <h3 className="text-sm font-semibold text-foreground">{title}</h3> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    )}
    {children}
  </section>
);

export const settingCardClassName = "rounded-lg border bg-card";

interface SettingCardProps {
  children: React.ReactNode;
  className?: string;
  /** Row list with dividers; vertical spacing comes from SettingRow. */
  divided?: boolean;
  /** Free-form content; apply even padding on all sides. */
  padded?: boolean;
}

export const SettingCard: React.FC<SettingCardProps> = ({
  children,
  className,
  divided = false,
  padded = false,
}) => (
  <div
    className={cn(
      settingCardClassName,
      padded ? "p-4" : "px-4",
      divided && "space-y-0 divide-y divide-border",
      className,
    )}
  >
    {children}
  </div>
);

interface SettingRowProps {
  label?: string;
  description?: string;
  children: React.ReactNode;
  align?: "center" | "start";
}

export const SettingRow: React.FC<SettingRowProps> = ({ label, description, children, align = "center" }) => (
  <div className={cn("flex justify-between py-3 gap-4", align === "start" ? "items-start" : "items-center")}>
    <div className="flex-1 min-w-0">
      {label && <div className="text-sm font-medium">{label}</div>}
      {description && (
        <div className={cn("text-xs text-muted-foreground", label && "mt-0.5")}>{description}</div>
      )}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

export const SettingsTabContent: React.FC<{
  value: string;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <TabsContent value={value} className="flex-1 m-0 h-full overflow-hidden">
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="p-6 space-y-6">{children}</div>
    </div>
  </TabsContent>
);
