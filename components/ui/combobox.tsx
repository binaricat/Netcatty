import { Check, ChevronDown, Plus, X } from "lucide-react"
import * as React from "react"
import { cn } from "../../lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

export interface ComboboxOption {
    value: string;
    label: string;
    sublabel?: string;
    icon?: React.ReactNode;
    labelStyle?: React.CSSProperties;
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
    inputStyle?: React.CSSProperties;
    onInputValueChange?: (value: string) => void;
    disabled?: boolean;
    clearable?: boolean;
    selectValueOnFocus?: boolean;
    ariaLabel?: string;
}

export const comboboxWheelDeltaToPixels = (deltaY: number, deltaMode: number): number => {
    if (deltaMode === 1) return deltaY * 16
    if (deltaMode === 2) return deltaY * 280
    return deltaY
}

export type ComboboxScrollableTarget = {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}

export const filterComboboxOptions = (
    options: ComboboxOption[],
    inputValue: string,
    isSearching: boolean,
): ComboboxOption[] => {
    if (!isSearching || !inputValue.trim()) return options
    const lower = inputValue.trim().toLowerCase()
    return options.filter(
        (option) =>
            option.label.toLowerCase().includes(lower) ||
            option.value.toLowerCase().includes(lower) ||
            option.sublabel?.toLowerCase().includes(lower)
    )
}

export const applyComboboxWheelScroll = (
    target: ComboboxScrollableTarget,
    deltaY: number,
    deltaMode: number,
): boolean => {
    if (target.scrollHeight <= target.clientHeight) return false

    target.scrollTop += comboboxWheelDeltaToPixels(deltaY, deltaMode)
    return true
}

export const getNextComboboxActiveIndex = (
    currentIndex: number,
    optionCount: number,
    direction: 1 | -1,
): number => {
    if (optionCount <= 0) return -1
    if (currentIndex < 0 || currentIndex >= optionCount) {
        return direction === 1 ? 0 : optionCount - 1
    }
    return (currentIndex + direction + optionCount) % optionCount
}

export type ComboboxFocusableInput = Pick<HTMLInputElement, "focus" | "select">;

export const focusComboboxInput = (
    input: ComboboxFocusableInput | null,
    selectValue: boolean,
): void => {
    input?.focus()
    if (selectValue) input?.select()
}

export const selectComboboxInputIfFocused = (
    input: ComboboxFocusableInput | null,
    activeElement: Element | null,
): void => {
    if (input && input === activeElement) input.select()
}

export const canComboboxOpen = (disabled: boolean, nextOpen: boolean): boolean =>
    !disabled || !nextOpen

/**
 * Incremental rendering limits for large option lists (e.g. the font pickers
 * can list hundreds of locally installed fonts). Rendering every option at
 * once freezes the UI, so we mount an initial slice and grow the window as
 * the user scrolls deeper, and slide the bounded window when arrow
 * navigation jumps to an option beyond it.
 */
export const COMBOBOX_INITIAL_RENDER_LIMIT = 60
export const COMBOBOX_RENDER_LIMIT_STEP = 120
const COMBOBOX_EXPAND_SCROLL_THRESHOLD_PX = 80

export const comboboxNextRenderLimit = (
    currentLimit: number,
    optionCount: number,
): number | null => {
    if (optionCount <= currentLimit) return null
    return Math.min(currentLimit + COMBOBOX_RENDER_LIMIT_STEP, optionCount)
}

export const shouldExpandComboboxWindow = (
    target: ComboboxScrollableTarget,
    renderedCount: number,
    optionCount: number,
): boolean => {
    if (renderedCount >= optionCount) return false
    const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight)
    return distanceFromBottom <= COMBOBOX_EXPAND_SCROLL_THRESHOLD_PX
}

export const shouldResetComboboxWindow = (target: ComboboxScrollableTarget): boolean =>
    target.scrollTop <= COMBOBOX_EXPAND_SCROLL_THRESHOLD_PX

/**
 * Keyboard navigation can land beyond the mounted window (e.g. ArrowUp wraps
 * straight to the last option). Instead of growing the prefix until that
 * index is mounted — which mounts every row for large lists — slide the
 * bounded window so the destination sits at its edge. Returns the new window
 * start, or null when the active option is already mounted.
 */
export const comboboxWindowStartForActiveIndex = (
    activeOptionIndex: number,
    windowStart: number,
    renderLimit: number,
    optionCount: number,
): number | null => {
    if (optionCount <= 0 || activeOptionIndex < 0) return null
    if (activeOptionIndex < windowStart) return activeOptionIndex
    if (activeOptionIndex >= windowStart + renderLimit) {
        return Math.max(0, Math.min(activeOptionIndex - renderLimit + 1, optionCount - renderLimit))
    }
    return null
}

function ComboboxOptionsList({
    children,
    id,
    listbox = false,
    onScrollCapture,
    scrollRef,
}: {
    children: React.ReactNode;
    id?: string;
    listbox?: boolean;
    onScrollCapture?: React.UIEventHandler<HTMLDivElement>;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
    const handleWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
        const handled = applyComboboxWheelScroll(event.currentTarget, event.deltaY, event.deltaMode)
        if (!handled) return

        event.preventDefault()
        event.stopPropagation()
        event.nativeEvent.stopImmediatePropagation()
    }

    return (
        <div
            id={id}
            ref={scrollRef}
            role={listbox ? "listbox" : undefined}
            className="max-h-[280px] overflow-y-auto overscroll-contain p-1"
            onWheelCapture={handleWheelCapture}
            onScrollCapture={onScrollCapture}
        >
            {children}
        </div>
    )
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
    inputStyle,
    onInputValueChange,
    disabled = false,
    clearable = true,
    selectValueOnFocus = false,
    ariaLabel,
}: ComboboxProps) {
    const [open, setOpen] = React.useState(false)
    const [inputValue, setInputValue] = React.useState("")
    const [activeIndex, setActiveIndex] = React.useState(-1)
    // Track if user is actively searching (typed something after opening)
    const [isSearching, setIsSearching] = React.useState(false)
    // Incremental rendering window for very large option lists
    const [renderLimit, setRenderLimit] = React.useState(COMBOBOX_INITIAL_RENDER_LIMIT)
    // First mounted option index, so keyboard jumps slide the window instead
    // of mounting the entire prefix of a large list.
    const [windowStart, setWindowStart] = React.useState(0)
    const inputRef = React.useRef<HTMLInputElement>(null)
    const wasOpenRef = React.useRef(false)
    const activeOptionRef = React.useRef<HTMLButtonElement>(null)
    const optionsScrollRef = React.useRef<HTMLDivElement>(null)
    // True while scroll events on the options list are caused by this
    // component scrolling the active option into view (keyboard navigation,
    // mouse hover) rather than by the user scrolling manually.
    const navigationalScrollRef = React.useRef(false)
    const listboxId = React.useId()

    // Sync input value with external value when not focused
    React.useEffect(() => {
        const wasOpen = wasOpenRef.current
        wasOpenRef.current = open

        if (!open) {
            const selected = options.find((opt) => opt.value === value)
            setInputValue(selected?.label || value || "")
            setIsSearching(false)

            if (wasOpen && selectValueOnFocus) {
                // The restored label lands after the close event. Reselect it on the next
                // frame so the next keystroke replaces it instead of appending to it.
                requestAnimationFrame(() => {
                    selectComboboxInputIfFocused(
                        inputRef.current,
                        typeof document === "undefined" ? null : document.activeElement,
                    )
                })
            }
        }
    }, [value, options, open, selectValueOnFocus])

    // Show all options when dropdown is open but user hasn't started searching
    const filteredOptions = React.useMemo(() => {
        return filterComboboxOptions(options, inputValue, isSearching)
    }, [options, inputValue, isSearching])

    // Restart the window from its initial size whenever the picker opens or
    // the filtered result set changes (option set, search mode, or query), so
    // a previously grown or slid window never persists across a changed list.
    // The reset happens during render (React discards the render output and
    // re-renders immediately after a render-phase state update), so a changed
    // result set is never committed with a stale, oversized window.
    const [windowKey, setWindowKey] = React.useState({ open, filteredOptions })
    if (windowKey.open !== open || windowKey.filteredOptions !== filteredOptions) {
        setWindowKey({ open, filteredOptions })
        setRenderLimit(COMBOBOX_INITIAL_RENDER_LIMIT)
        setWindowStart(0)
    }

    const renderedOptions = React.useMemo(() => {
        return filteredOptions.slice(windowStart, windowStart + renderLimit)
    }, [filteredOptions, windowStart, renderLimit])

    // Resetting the render window alone is not enough: the listbox DOM node
    // keeps (or clamps) its previous scrollTop, so a fresh initial slice
    // would be displayed near its bottom instead of at its first match.
    React.useEffect(() => {
        if (optionsScrollRef.current) optionsScrollRef.current.scrollTop = 0
    }, [open, filteredOptions])

    const expandRenderWindow = React.useCallback(() => {
        setRenderLimit((current) => {
            const next = comboboxNextRenderLimit(current, options.length)
            return next ?? current
        })
    }, [options.length])

    const handleOptionsScrollCapture = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget
        const scrollTarget = {
            clientHeight: target.clientHeight,
            scrollHeight: target.scrollHeight,
            scrollTop: target.scrollTop,
        }
        // Scrolling back to the top restores the initial window so options
        // above a slid window become reachable again. The active index must
        // be cleared too, otherwise the active-option effect immediately
        // slides the window back to a stale active option.
        // Scrolls emitted by scrolling the active option into view are not
        // manual scrolls: skipping the reset keeps ArrowUp navigation able to
        // slide into the preceding window without losing the active option.
        if (windowStart > 0 && shouldResetComboboxWindow(scrollTarget)) {
            if (navigationalScrollRef.current) return
            setActiveIndex(-1)
            setWindowStart(0)
            setRenderLimit(COMBOBOX_INITIAL_RENDER_LIMIT)
            return
        }
        // Programmatic scrolls from scrolling the active option into view can
        // also land near the bottom of a slid window (e.g. at the last window
        // while keyboard-navigating). Those are not manual scrolls either, so
        // skip expansion to keep the keyboard window at a fixed size instead
        // of growing it on every ArrowUp/ArrowDown wrap boundary.
        if (navigationalScrollRef.current) return
        if (!shouldExpandComboboxWindow(scrollTarget, renderedOptions.length, filteredOptions.length)) {
            return
        }
        // A slid window that already reaches the final option cannot mount
        // more rows by growing renderLimit (the slice is capped by the option
        // count), so growing it here without mounting anything would leave an
        // inflated limit behind; a later wrap back to index 0 would then reset
        // windowStart to zero and mount the entire grown prefix in one commit.
        if (windowStart + renderedOptions.length >= filteredOptions.length) return
        expandRenderWindow()
    }, [windowStart, renderedOptions.length, filteredOptions.length, expandRenderWindow])

    const showCreateOption = React.useMemo(() => {
        if (!allowCreate || !inputValue.trim() || !isSearching) return false
        const lower = inputValue.toLowerCase().trim()
        return !options.some((opt) => opt.value.toLowerCase() === lower || opt.label.toLowerCase() === lower)
    }, [allowCreate, inputValue, options, isSearching])

    const selectableOptionCount = filteredOptions.length + (showCreateOption ? 1 : 0)
    const hasActiveOption = activeIndex >= 0 && activeIndex < selectableOptionCount

    // Keyboard navigation must never land on an option that is not mounted
    // yet, otherwise its aria-activedescendant id would not exist. Slide the
    // bounded window so the destination is mounted without mounting the
    // entire prefix of a large list. This runs during render (React discards
    // the render and re-renders immediately after a render-phase state
    // update), so the commit that exposes a new active descendant already
    // has that option mounted — a post-commit effect would commit an
    // aria-activedescendant id that does not exist in the DOM yet.
    const [activeWindowKey, setActiveWindowKey] = React.useState({
        activeIndex,
        showCreateOption,
        windowStart,
        renderLimit,
        filteredCount: filteredOptions.length,
    })
    if (
        activeIndex >= 0 &&
        (activeWindowKey.activeIndex !== activeIndex ||
            activeWindowKey.showCreateOption !== showCreateOption ||
            activeWindowKey.windowStart !== windowStart ||
            activeWindowKey.renderLimit !== renderLimit ||
            activeWindowKey.filteredCount !== filteredOptions.length)
    ) {
        setActiveWindowKey({
            activeIndex,
            showCreateOption,
            windowStart,
            renderLimit,
            filteredCount: filteredOptions.length,
        })
        const optionIndex = activeIndex - (showCreateOption ? 1 : 0)
        const nextWindowStart = comboboxWindowStartForActiveIndex(
            optionIndex,
            windowStart,
            renderLimit,
            filteredOptions.length,
        )
        if (nextWindowStart !== null) setWindowStart(nextWindowStart)
    }

    React.useEffect(() => {
        // Scrolling the active option into view emits scroll events even when
        // keyboard navigation slides the window toward the top of the list.
        // Mark them as navigational so the manual-scroll reset below does not
        // mistake them for the user scrolling back to the top, which would
        // clear the active option and make preceding windows unreachable by
        // ArrowUp. The flag is cleared on the next frame, once the scroll
        // events for this update have been dispatched.
        navigationalScrollRef.current = true
        activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
        requestAnimationFrame(() => {
            navigationalScrollRef.current = false
        })
    }, [activeIndex, renderedOptions.length, windowStart])

    React.useEffect(() => {
        if (!disabled || !open) return
        setOpen(false)
        setActiveIndex(-1)
        setIsSearching(false)
        onInputValueChange?.(value ?? "")
    }, [disabled, open, onInputValueChange, value])

    const handleSelect = (optValue: string) => {
        if (disabled) return
        onValueChange?.(optValue)
        onInputValueChange?.(optValue)
        setOpen(false)
        setActiveIndex(-1)
        const selected = options.find((opt) => opt.value === optValue)
        setInputValue(selected?.label || optValue)
    }

    const handleCreate = () => {
        if (disabled) return
        const newValue = inputValue.trim()
        if (newValue) {
            onCreateNew?.(newValue)
            onValueChange?.(newValue)
            onInputValueChange?.(newValue)
            setOpen(false)
            setActiveIndex(-1)
        }
    }

    const focusAndSelectInput = () => {
        // Defer so selection wins over click-to-place-caret on focus.
        requestAnimationFrame(() => {
            focusComboboxInput(inputRef.current, true)
        })
    }

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInputValue(e.target.value)
        onInputValueChange?.(e.target.value)
        setIsSearching(true)
        setActiveIndex(-1)
        if (!open) setOpen(true)
    }

    const handleInputFocus = () => {
        if (selectValueOnFocus) focusAndSelectInput()
    }

    const handleOpenChange = (nextOpen: boolean) => {
        if (!canComboboxOpen(disabled, nextOpen)) return
        setOpen(nextOpen)
        setActiveIndex(-1)
        if (nextOpen) {
            if (selectValueOnFocus) {
                // Opening a closed picker from its chevron should also replace on first keystroke.
                focusAndSelectInput()
            }
        } else {
            onInputValueChange?.(value ?? "")
        }
    }

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) setOpen(true)
            const direction = e.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((current) =>
                getNextComboboxActiveIndex(current, selectableOptionCount, direction)
            )
        } else if (e.key === 'Enter') {
            e.preventDefault()
            if (hasActiveOption) {
                if (showCreateOption && activeIndex === 0) {
                    handleCreate()
                } else {
                    const optionIndex = activeIndex - (showCreateOption ? 1 : 0)
                    const activeOption = filteredOptions[optionIndex]
                    if (activeOption) handleSelect(activeOption.value)
                }
            } else if (showCreateOption) {
                handleCreate()
            } else if (filteredOptions.length === 1) {
                handleSelect(filteredOptions[0].value)
            }
        } else if (e.key === 'Escape') {
            handleOpenChange(false)
        }
    }

    const handleClear = (e: React.MouseEvent) => {
        if (disabled) return
        e.stopPropagation()
        setInputValue("")
        onInputValueChange?.("")
        onValueChange?.("")
        inputRef.current?.focus()
    }

    return (
        <Popover open={open && !disabled} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild disabled={disabled}>
                <div
                    aria-disabled={disabled}
                    className={cn(
                        "flex h-10 w-full items-center rounded-md border border-input bg-background text-sm min-w-0 overflow-hidden",
                        "hover:bg-secondary/50 transition-colors",
                        "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
                        disabled && "cursor-not-allowed opacity-50 hover:bg-background",
                        triggerClassName
                    )}
                >
                    {icon && <span className="pl-3 shrink-0 text-muted-foreground">{icon}</span>}
                    <input
                        ref={inputRef}
                        type="text"
                        value={inputValue}
                        onChange={handleInputChange}
                        onFocus={handleInputFocus}
                        onKeyDown={handleInputKeyDown}
                        role="combobox"
                        aria-label={ariaLabel}
                        aria-autocomplete="list"
                        aria-expanded={open && !disabled}
                        aria-controls={listboxId}
                        aria-activedescendant={
                            open && !disabled && hasActiveOption
                                ? `${listboxId}-option-${activeIndex}`
                                : undefined
                        }
                        placeholder={placeholder}
                        style={inputStyle}
                        className="flex-1 min-w-0 h-full px-3 bg-transparent outline-none placeholder:text-muted-foreground"
                        disabled={disabled}
                    />
                    {clearable && !disabled && inputValue && (
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
                className={cn("app-no-drag p-0 border-border/60", className)}
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(e) => e.preventDefault()}
                style={{ width: 'var(--radix-popover-trigger-width)' }}
            >
                {/* Options List */}
                <ComboboxOptionsList id={listboxId} listbox scrollRef={optionsScrollRef} onScrollCapture={handleOptionsScrollCapture}>
                    {filteredOptions.length === 0 && !showCreateOption ? (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                            {emptyText}
                        </div>
                    ) : (
                        <>
                            {/* Create new option */}
                            {showCreateOption && (
                                <button
                                    ref={activeIndex === 0 ? activeOptionRef : undefined}
                                    id={`${listboxId}-option-0`}
                                    role="option"
                                    aria-selected={false}
                                    aria-posinset={1}
                                    aria-setsize={selectableOptionCount}
                                    tabIndex={-1}
                                    type="button"
                                    className={cn(
                                        "flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-secondary/80 transition-colors text-left",
                                        activeIndex === 0 && "bg-secondary/80",
                                    )}
                                    onClick={handleCreate}
                                    onMouseEnter={() => setActiveIndex(0)}
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

                            {/* Existing options (rendered incrementally for large lists) */}
                            {renderedOptions.map((option, optionIndex) => {
                                const selectableIndex = optionIndex + windowStart + (showCreateOption ? 1 : 0)
                                return (
                                    <button
                                        key={option.value}
                                        ref={activeIndex === selectableIndex ? activeOptionRef : undefined}
                                        id={`${listboxId}-option-${selectableIndex}`}
                                        role="option"
                                        aria-selected={value === option.value}
                                        aria-posinset={selectableIndex + 1}
                                        aria-setsize={selectableOptionCount}
                                        tabIndex={-1}
                                        type="button"
                                        className={cn(
                                            "flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors text-left",
                                            value === option.value
                                                ? "bg-primary/10 text-foreground"
                                                : "hover:bg-secondary/80",
                                            activeIndex === selectableIndex && "bg-secondary/80",
                                        )}
                                        onClick={() => handleSelect(option.value)}
                                        onMouseEnter={() => setActiveIndex(selectableIndex)}
                                    >
                                        {option.icon && (
                                            <span className="shrink-0 text-muted-foreground">{option.icon}</span>
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <div className="truncate font-medium" style={option.labelStyle}>{option.label}</div>
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
                                )
                            })}
                        </>
                    )}
                </ComboboxOptionsList>
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
                        "flex min-h-10 w-full items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm",
                        "hover:bg-secondary/50 transition-colors cursor-text",
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
                className={cn("app-no-drag p-0 border-border/60", className)}
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(e) => e.preventDefault()}
                style={{ width: 'var(--radix-popover-trigger-width)' }}
            >
                {/* Options List */}
                <ComboboxOptionsList>
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
                </ComboboxOptionsList>
            </PopoverContent>
        </Popover>
    )
}

export default Combobox
