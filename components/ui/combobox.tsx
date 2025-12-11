import { Check, ChevronDown, Plus, X } from "lucide-react"
import * as React from "react"
import { cn } from "../../lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import { ScrollArea } from "./scroll-area"

export interface ComboboxOption {
    value: string;
    label: string;
    sublabel?: string;
    icon?: React.ReactNode;
}

interface ComboboxProps {
    options: ComboboxOption[];
    value?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    emptyText?: string;
    allowCreate?: boolean;
    onCreateNew?: (value: string) => void;
    createText?: string;
    icon?: React.ReactNode;
    className?: string;
    triggerClassName?: string;
    disabled?: boolean;
}

export function Combobox({
    options,
    value,
    onValueChange,
    placeholder = "Select...",
    emptyText = "No results found",
    allowCreate = false,
    onCreateNew,
    createText = "Create",
    icon,
    className,
    triggerClassName,
    disabled = false,
}: ComboboxProps) {
    const [open, setOpen] = React.useState(false)
    const [inputValue, setInputValue] = React.useState("")
    const inputRef = React.useRef<HTMLInputElement>(null)

    // Sync input value with external value when not focused
    React.useEffect(() => {
        if (!open) {
            const selected = options.find((opt) => opt.value === value)
            setInputValue(selected?.label || value || "")
        }
    }, [value, options, open])

    const filteredOptions = React.useMemo(() => {
        if (!inputValue.trim()) return options
        const lower = inputValue.toLowerCase()
        return options.filter(
            (opt) =>
                opt.label.toLowerCase().includes(lower) ||
                opt.value.toLowerCase().includes(lower) ||
                opt.sublabel?.toLowerCase().includes(lower)
        )
    }, [options, inputValue])

    const showCreateOption = React.useMemo(() => {
        if (!allowCreate || !inputValue.trim()) return false
        const lower = inputValue.toLowerCase().trim()
        return !options.some((opt) => opt.value.toLowerCase() === lower || opt.label.toLowerCase() === lower)
    }, [allowCreate, inputValue, options])

    const handleSelect = (optValue: string) => {
        onValueChange?.(optValue)
        setOpen(false)
        const selected = options.find((opt) => opt.value === optValue)
        setInputValue(selected?.label || optValue)
    }

    const handleCreate = () => {
        const newValue = inputValue.trim()
        if (newValue) {
            onCreateNew?.(newValue)
            onValueChange?.(newValue)
            setOpen(false)
        }
    }

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInputValue(e.target.value)
        if (!open) setOpen(true)
    }

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            if (showCreateOption) {
                handleCreate()
            } else if (filteredOptions.length === 1) {
                handleSelect(filteredOptions[0].value)
            }
        } else if (e.key === 'Escape') {
            setOpen(false)
        }
    }

    const handleClear = (e: React.MouseEvent) => {
        e.stopPropagation()
        setInputValue("")
        onValueChange?.("")
        inputRef.current?.focus()
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild disabled={disabled}>
                <div
                    className={cn(
                        "flex h-10 w-full items-center rounded-md border border-input bg-background text-sm ring-offset-background",
                        "hover:bg-secondary/50 transition-colors",
                        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        triggerClassName
                    )}
                >
                    {icon && <span className="pl-3 shrink-0 text-muted-foreground">{icon}</span>}
                    <input
                        ref={inputRef}
                        type="text"
                        value={inputValue}
                        onChange={handleInputChange}
                        onKeyDown={handleInputKeyDown}
                        placeholder={placeholder}
                        className="flex-1 h-full px-3 bg-transparent outline-none placeholder:text-muted-foreground"
                        disabled={disabled}
                    />
                    {inputValue && (
                        <button
                            type="button"
                            onClick={handleClear}
                            className="pr-1 text-muted-foreground hover:text-foreground"
                        >
                            <X size={14} />
                        </button>
                    )}
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50 pr-3 box-content" />
                </div>
            </PopoverTrigger>
            <PopoverContent
                className={cn("p-0 border-border/60", className)}
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(e) => e.preventDefault()}
                style={{ width: 'var(--radix-popover-trigger-width)' }}
            >
                {/* Options List */}
                <ScrollArea className="max-h-[280px]">
                    <div className="p-1">
                        {filteredOptions.length === 0 && !showCreateOption ? (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                                {emptyText}
                            </div>
                        ) : (
                            <>
                                {/* Create new option */}
                                {showCreateOption && (
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-secondary/80 transition-colors text-left"
                                        onClick={handleCreate}
                                    >
                                        <Plus size={16} className="text-primary shrink-0" />
                                        <span className="text-muted-foreground">{createText}</span>
                                        <span className="font-medium text-foreground">{inputValue}</span>
                                    </button>
                                )}

                                {/* Separator if both create and options exist */}
                                {showCreateOption && filteredOptions.length > 0 && (
                                    <div className="h-px bg-border/60 my-1" />
                                )}

                                {/* Existing options */}
                                {filteredOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={cn(
                                            "flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors text-left",
                                            value === option.value
                                                ? "bg-primary/10 text-foreground"
                                                : "hover:bg-secondary/80"
                                        )}
                                        onClick={() => handleSelect(option.value)}
                                    >
                                        {option.icon && (
                                            <span className="shrink-0 text-muted-foreground">{option.icon}</span>
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <div className="truncate font-medium">{option.label}</div>
                                            {option.sublabel && (
                                                <div className="text-xs text-muted-foreground truncate">
                                                    {option.sublabel}
                                                </div>
                                            )}
                                        </div>
                                        {value === option.value && (
                                            <Check size={16} className="shrink-0 text-primary" />
                                        )}
                                    </button>
                                ))}
                            </>
                        )}
                    </div>
                </ScrollArea>
            </PopoverContent>
        </Popover>
    )
}

// Multi-select Combobox for tags
interface MultiComboboxProps {
    options: ComboboxOption[];
    values: string[];
    onValuesChange?: (values: string[]) => void;
    placeholder?: string;
    emptyText?: string;
    allowCreate?: boolean;
    onCreateNew?: (value: string) => void;
    createText?: string;
    icon?: React.ReactNode;
    className?: string;
    triggerClassName?: string;
    disabled?: boolean;
}

export function MultiCombobox({
    options,
    values,
    onValuesChange,
    placeholder = "Add...",
    emptyText = "No results found",
    allowCreate = false,
    onCreateNew,
    createText = "Create Tag",
    icon,
    className,
    triggerClassName,
    disabled = false,
}: MultiComboboxProps) {
    const [open, setOpen] = React.useState(false)
    const [inputValue, setInputValue] = React.useState("")
    const inputRef = React.useRef<HTMLInputElement>(null)

    const filteredOptions = React.useMemo(() => {
        if (!inputValue.trim()) return options
        const lower = inputValue.toLowerCase()
        return options.filter(
            (opt) =>
                opt.label.toLowerCase().includes(lower) ||
                opt.value.toLowerCase().includes(lower)
        )
    }, [options, inputValue])

    const showCreateOption = React.useMemo(() => {
        if (!allowCreate || !inputValue.trim()) return false
        const lower = inputValue.toLowerCase().trim()
        return !options.some((opt) => opt.value.toLowerCase() === lower || opt.label.toLowerCase() === lower)
    }, [allowCreate, inputValue, options])

    const handleToggle = (optValue: string) => {
        const newValues = values.includes(optValue)
            ? values.filter((v) => v !== optValue)
            : [...values, optValue]
        onValuesChange?.(newValues)
    }

    const handleCreate = () => {
        const newValue = inputValue.trim()
        if (newValue && !values.includes(newValue)) {
            onCreateNew?.(newValue)
            onValuesChange?.([...values, newValue])
            setInputValue("")
        }
    }

    const handleRemove = (e: React.MouseEvent, val: string) => {
        e.stopPropagation()
        onValuesChange?.(values.filter((v) => v !== val))
    }

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            if (showCreateOption) {
                handleCreate()
            } else if (filteredOptions.length === 1 && !values.includes(filteredOptions[0].value)) {
                handleToggle(filteredOptions[0].value)
                setInputValue("")
            }
        } else if (e.key === 'Escape') {
            setOpen(false)
        } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
            // Remove last tag on backspace when input is empty
            onValuesChange?.(values.slice(0, -1))
        }
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild disabled={disabled}>
                <div
                    className={cn(
                        "flex min-h-10 w-full items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background",
                        "hover:bg-secondary/50 transition-colors cursor-text",
                        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        triggerClassName
                    )}
                    onClick={() => inputRef.current?.focus()}
                >
                    {icon && <span className="pl-1 shrink-0 text-muted-foreground">{icon}</span>}
                    <div className="flex-1 flex flex-wrap gap-1.5 items-center min-w-0">
                        {values.map((val) => (
                            <span
                                key={val}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium"
                            >
                                {val}
                                <button
                                    type="button"
                                    onClick={(e) => handleRemove(e, val)}
                                    className="hover:bg-primary/20 rounded p-0.5"
                                >
                                    <X size={12} />
                                </button>
                            </span>
                        ))}
                        <input
                            ref={inputRef}
                            type="text"
                            value={inputValue}
                            onChange={(e) => {
                                setInputValue(e.target.value)
                                if (!open) setOpen(true)
                            }}
                            onKeyDown={handleInputKeyDown}
                            placeholder={values.length === 0 ? placeholder : ""}
                            className="flex-1 min-w-[60px] h-6 bg-transparent outline-none placeholder:text-muted-foreground text-sm"
                            disabled={disabled}
                        />
                    </div>
                </div>
            </PopoverTrigger>
            <PopoverContent
                className={cn("p-0 border-border/60", className)}
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(e) => e.preventDefault()}
                style={{ width: 'var(--radix-popover-trigger-width)' }}
            >
                {/* Options List */}
                <ScrollArea className="max-h-[280px]">
                    <div className="p-1">
                        {filteredOptions.length === 0 && !showCreateOption ? (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                                {emptyText}
                            </div>
                        ) : (
                            <>
                                {/* Create new option */}
                                {showCreateOption && (
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-secondary/80 transition-colors text-left"
                                        onClick={handleCreate}
                                    >
                                        <Plus size={16} className="text-primary shrink-0" />
                                        <span className="text-muted-foreground">{createText}</span>
                                        <span className="font-medium text-foreground">{inputValue}</span>
                                    </button>
                                )}

                                {/* Separator if both create and options exist */}
                                {showCreateOption && filteredOptions.length > 0 && (
                                    <div className="h-px bg-border/60 my-1" />
                                )}

                                {/* Existing options */}
                                {filteredOptions.map((option) => {
                                    const isSelected = values.includes(option.value)
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            className={cn(
                                                "flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors text-left",
                                                isSelected
                                                    ? "bg-primary/10 text-foreground"
                                                    : "hover:bg-secondary/80"
                                            )}
                                            onClick={() => {
                                                handleToggle(option.value)
                                                setInputValue("")
                                            }}
                                        >
                                            <div className={cn(
                                                "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                                                isSelected ? "bg-primary border-primary" : "border-muted-foreground/40"
                                            )}>
                                                {isSelected && <Check size={12} className="text-primary-foreground" />}
                                            </div>
                                            <span className="truncate flex-1">{option.label}</span>
                                        </button>
                                    )
                                })}
                            </>
                        )}
                    </div>
                </ScrollArea>
            </PopoverContent>
        </Popover>
    )
}

export default Combobox
