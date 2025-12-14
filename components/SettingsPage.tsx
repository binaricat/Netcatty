/**
 * Settings Page - Standalone settings window content
 * This component is rendered in a separate Electron window
 */
import {
    Check,
    Cloud,
    Download,
    Keyboard,
    Minus,
    Moon,
    Palette,
    Plus,
    RotateCcw,
    Sun,
    TerminalSquare,
    Upload,
    X,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { CloudSyncSettings } from "./CloudSyncSettings";
import type { SyncPayload } from "../domain/sync";
import {
    CursorShape,
    RightClickBehavior,
    HotkeyScheme,
    TerminalEmulationType,
    LinkModifier,
    DEFAULT_KEYWORD_HIGHLIGHT_RULES,
    keyEventToString,
} from "../domain/models";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { TERMINAL_FONTS, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../infrastructure/config/fonts";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toast";
import { useSettingsState } from "../application/state/useSettingsState";
import { useVaultState } from "../application/state/useVaultState";
import { useWindowControls } from "../application/state/useWindowControls";

// More comprehensive color palette
const COLORS = [
    // Blues
    { name: "Sky Blue", value: "199 89% 48%" },
    { name: "Blue", value: "221.2 83.2% 53.3%" },
    { name: "Indigo", value: "234 89% 62%" },
    // Purples
    { name: "Violet", value: "262.1 83.3% 57.8%" },
    { name: "Purple", value: "271 81% 56%" },
    { name: "Fuchsia", value: "292 84% 61%" },
    // Pinks & Reds
    { name: "Pink", value: "330 81% 60%" },
    { name: "Rose", value: "346.8 77.2% 49.8%" },
    { name: "Red", value: "0 84.2% 60.2%" },
    // Oranges & Yellows
    { name: "Orange", value: "24.6 95% 53.1%" },
    { name: "Amber", value: "38 92% 50%" },
    { name: "Yellow", value: "48 96% 53%" },
    // Greens
    { name: "Lime", value: "84 81% 44%" },
    { name: "Green", value: "142.1 76.2% 36.3%" },
    { name: "Emerald", value: "160 84% 39%" },
    { name: "Teal", value: "173 80% 40%" },
    // Neutrals
    { name: "Cyan", value: "189 94% 43%" },
    { name: "Slate", value: "215 16% 47%" },
];

// Toggle component
interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            checked ? "bg-primary" : "bg-input"
        )}
    >
        <span
            className={cn(
                "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
                checked ? "translate-x-4" : "translate-x-0"
            )}
        />
    </button>
);

// Select component
interface SelectProps {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    className?: string;
    disabled?: boolean;
}

const Select: React.FC<SelectProps> = ({ value, options, onChange, className, disabled }) => (
    <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
            "h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
        )}
    >
        {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
                {opt.label}
            </option>
        ))}
    </select>
);

// Helper: render terminal preview
const renderTerminalPreview = (theme: typeof TERMINAL_THEMES[0]) => {
    const c = theme.colors;
    const lines = [
        { prompt: "~", cmd: "ssh prod-server", color: c.foreground },
        { prompt: "prod", cmd: "ls -la", color: c.green },
        { prompt: "prod", cmd: "cat config.json", color: c.cyan },
    ];
    return (
        <div
            className="font-mono text-[9px] leading-tight p-1.5 rounded overflow-hidden h-full"
            style={{ backgroundColor: c.background, color: c.foreground }}
        >
            {lines.map((l, i) => (
                <div key={i} className="flex gap-1 truncate">
                    <span style={{ color: c.blue }}>{l.prompt}</span>
                    <span style={{ color: c.magenta }}>$</span>
                    <span style={{ color: l.color }}>{l.cmd}</span>
                </div>
            ))}
            <div className="flex gap-1">
                <span style={{ color: c.blue }}>~</span>
                <span style={{ color: c.magenta }}>$</span>
                <span
                    className="inline-block w-1.5 h-2.5 animate-pulse"
                    style={{ backgroundColor: c.cursor }}
                />
            </div>
        </div>
    );
};

// TerminalThemeCard
interface TerminalThemeCardProps {
    theme: typeof TERMINAL_THEMES[0];
    active: boolean;
    onClick: () => void;
}

const TerminalThemeCard: React.FC<TerminalThemeCardProps> = ({
    theme,
    active,
    onClick,
}) => (
    <button
        onClick={onClick}
        className={cn(
            "relative flex flex-col rounded-lg border-2 transition-all overflow-hidden text-left",
            active
                ? "border-primary ring-2 ring-primary/20"
                : "border-border hover:border-primary/50"
        )}
    >
        <div className="h-16">{renderTerminalPreview(theme)}</div>
        <div className="px-2 py-1.5 text-xs font-medium border-t bg-card">
            {theme.name}
        </div>
        {active && (
            <div className="absolute top-1 right-1 w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                <Check size={10} className="text-primary-foreground" />
            </div>
        )}
    </button>
);

// Section Header
const SectionHeader: React.FC<{ title: string; className?: string }> = ({ title, className }) => (
    <h3 className={cn("text-sm font-semibold text-foreground mb-3", className)}>
        {title}
    </h3>
);

// Setting Row
interface SettingRowProps {
    label: string;
    description?: string;
    children: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({ label, description, children }) => (
    <div className="flex items-center justify-between py-3 gap-4">
        <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{label}</div>
            {description && (
                <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
            )}
        </div>
        <div className="shrink-0">{children}</div>
    </div>
);

// Tab content wrapper
const SettingsTabContent: React.FC<{
    value: string;
    children: React.ReactNode;
}> = ({ value, children }) => (
    <TabsContent value={value} className="flex-1 m-0 h-full overflow-hidden">
        <ScrollArea className="h-full">
            <div className="p-6 space-y-6">{children}</div>
        </ScrollArea>
    </TabsContent>
);

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export default function SettingsPage() {
    const {
        theme,
        setTheme,
        primaryColor,
        setPrimaryColor,
        terminalThemeId,
        setTerminalThemeId,
        terminalFontFamilyId,
        setTerminalFontFamilyId,
        terminalFontSize,
        setTerminalFontSize,
        terminalSettings,
        updateTerminalSetting,
        hotkeyScheme,
        setHotkeyScheme,
        keyBindings,
        updateKeyBinding,
        resetKeyBinding,
        resetAllKeyBindings,
        customCSS,
        setCustomCSS,
    } = useSettingsState();

    const {
        hosts,
        keys,
        snippets,
        exportData,
        importDataFromString,
    } = useVaultState();
    const { closeSettingsWindow } = useWindowControls();

    // Local state
    const [importText, setImportText] = useState("");
    const [recordingBindingId, setRecordingBindingId] = useState<string | null>(null);
    const [recordingScheme, setRecordingScheme] = useState<'mac' | 'pc' | null>(null);

    // Close window handler
    const handleClose = useCallback(() => {
        closeSettingsWindow();
    }, [closeSettingsWindow]);

    // Helper functions
    const getHslStyle = (hsl: string) => ({ backgroundColor: `hsl(${hsl})` });

    // Cancel recording when clicking outside
    const cancelRecording = useCallback(() => {
        setRecordingBindingId(null);
        setRecordingScheme(null);
    }, []);

    // Helper to detect special suffix in a key binding
    const getSpecialSuffix = useCallback((bindingId: string): string | null => {
        const binding = keyBindings.find(b => b.id === bindingId);
        if (!binding) return null;
        const currentKey = hotkeyScheme === 'mac' ? binding.mac : binding.pc;
        if (currentKey.includes('[1...9]')) return '[1...9]';
        if (currentKey.includes('arrows')) return 'arrows';
        return null;
    }, [keyBindings, hotkeyScheme]);

    // Keyboard recording for custom shortcuts
    useEffect(() => {
        if (!recordingBindingId || !recordingScheme) return;

        // Check if this is a special binding that needs suffix handling
        const specialSuffix = getSpecialSuffix(recordingBindingId);

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Cancel on Escape
            if (e.key === 'Escape') {
                cancelRecording();
                return;
            }

            if (specialSuffix) {
                // For special bindings, we only record modifier keys
                // Wait for a non-modifier key press to confirm the modifiers
                if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

                // Build modifiers string
                const parts: string[] = [];
                if (recordingScheme === 'mac') {
                    if (e.metaKey) parts.push('⌘');
                    if (e.ctrlKey) parts.push('⌃');
                    if (e.altKey) parts.push('⌥');
                    if (e.shiftKey) parts.push('Shift');
                } else {
                    if (e.ctrlKey) parts.push('Ctrl');
                    if (e.altKey) parts.push('Alt');
                    if (e.shiftKey) parts.push('Shift');
                    if (e.metaKey) parts.push('Win');
                }

                // Combine modifiers with the special suffix
                const modifierString = parts.length > 0 ? parts.join(' + ') + ' + ' : '';
                const fullKeyString = modifierString + specialSuffix;

                updateKeyBinding?.(recordingBindingId, recordingScheme, fullKeyString);
                cancelRecording();
            } else {
                // Regular binding: record the full key combo
                if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

                const keyString = keyEventToString(e, recordingScheme === 'mac');
                updateKeyBinding?.(recordingBindingId, recordingScheme, keyString);
                cancelRecording();
            }
        };

        // Cancel on click outside
        const handleClick = () => {
            cancelRecording();
        };

        // Add slight delay before adding click listener to avoid immediate cancellation
        const timer = setTimeout(() => {
            window.addEventListener('click', handleClick, true);
        }, 100);

        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('click', handleClick, true);
        };
    }, [recordingBindingId, recordingScheme, updateKeyBinding, cancelRecording, getSpecialSuffix]);

    // Cloud sync payload handlers
    const buildSyncPayload = useCallback((): SyncPayload => {
        return {
            hosts,
            keys,
            snippets,
            customGroups: [],
            syncedAt: Date.now(),
        };
    }, [hosts, keys, snippets]);

    const applySyncPayload = useCallback((payload: SyncPayload) => {
        importDataFromString(JSON.stringify({
            hosts: payload.hosts,
            keys: payload.keys,
            snippets: payload.snippets,
            customGroups: payload.customGroups,
        }));
    }, [importDataFromString]);

    return (
        <div className="h-screen flex flex-col bg-background text-foreground">
            {/* Common Header - spans full width */}
            <div className="shrink-0 border-b border-border app-drag">
                <div className="flex items-center justify-between px-4 pt-3">
                    {/* Mac: space for traffic lights */}
                    {isMac && <div className="h-6" />}
                </div>
                <div className="flex items-center justify-between px-4 py-2">
                    <h1 className="text-lg font-semibold">Settings</h1>
                    {/* Windows: close button */}
                    {!isMac && (
                        <button
                            onClick={handleClose}
                            className="app-no-drag w-8 h-8 flex items-center justify-center rounded-md hover:bg-destructive/20 hover:text-destructive transition-colors text-muted-foreground"
                            title="Close"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>
            </div>

            {/* Body - split into sidebar and content */}
            <Tabs
                defaultValue="appearance"
                orientation="vertical"
                className="flex-1 flex overflow-hidden"
            >
                {/* Sidebar */}
                <div className="w-56 border-r border-border flex flex-col shrink-0 px-3 py-3">
                    <TabsList className="flex flex-col h-auto bg-transparent gap-1 p-0 justify-start">
                        <TabsTrigger
                            value="appearance"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Palette size={14} /> Appearance
                        </TabsTrigger>
                        <TabsTrigger
                            value="terminal"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <TerminalSquare size={14} /> Terminal
                        </TabsTrigger>
                        <TabsTrigger
                            value="shortcuts"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Keyboard size={14} /> Shortcuts
                        </TabsTrigger>
                        <TabsTrigger
                            value="sync"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Cloud size={14} /> Sync & Cloud
                        </TabsTrigger>
                        <TabsTrigger
                            value="data"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Download size={14} /> Data
                        </TabsTrigger>
                    </TabsList>
                </div>

                {/* Content Area */}
                <div className="flex-1 h-full flex flex-col min-h-0 bg-muted/10">
                    {/* Appearance Tab */}
                    <SettingsTabContent value="appearance">
                        <SectionHeader title="UI Theme" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow
                                label="Dark Mode"
                                description="Toggle between light and dark theme"
                            >
                                <div className="flex items-center gap-2">
                                    <Sun size={14} className="text-muted-foreground" />
                                    <Toggle
                                        checked={theme === "dark"}
                                        onChange={(v) => setTheme(v ? "dark" : "light")}
                                    />
                                    <Moon size={14} className="text-muted-foreground" />
                                </div>
                            </SettingRow>
                        </div>

                        <SectionHeader title="Accent Color" />
                        <div className="flex flex-wrap gap-2">
                            {COLORS.map((c) => (
                                <button
                                    key={c.name}
                                    onClick={() => setPrimaryColor(c.value)}
                                    className={cn(
                                        "w-6 h-6 rounded-full flex items-center justify-center transition-all shadow-sm",
                                        primaryColor === c.value
                                            ? "ring-2 ring-offset-2 ring-foreground scale-110"
                                            : "hover:scale-105",
                                    )}
                                    style={getHslStyle(c.value)}
                                    title={c.name}
                                >
                                    {primaryColor === c.value && (
                                        <Check className="text-white drop-shadow-md" size={10} />
                                    )}
                                </button>
                            ))}
                            {/* Custom color picker */}
                            <label
                                className={cn(
                                    "w-6 h-6 rounded-full flex items-center justify-center transition-all shadow-sm cursor-pointer",
                                    "bg-gradient-to-br from-pink-500 via-purple-500 to-blue-500",
                                    !COLORS.some((c) => c.value === primaryColor)
                                        ? "ring-2 ring-offset-2 ring-foreground scale-110"
                                        : "hover:scale-105",
                                )}
                                title="Custom color"
                            >
                                <input
                                    type="color"
                                    className="sr-only"
                                    onChange={(e) => {
                                        const hex = e.target.value;
                                        const r = parseInt(hex.slice(1, 3), 16) / 255;
                                        const g = parseInt(hex.slice(3, 5), 16) / 255;
                                        const b = parseInt(hex.slice(5, 7), 16) / 255;
                                        const max = Math.max(r, g, b),
                                            min = Math.min(r, g, b);
                                        let h = 0,
                                            s = 0;
                                        const l = (max + min) / 2;
                                        if (max !== min) {
                                            const d = max - min;
                                            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                                            switch (max) {
                                                case r:
                                                    h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                                                    break;
                                                case g:
                                                    h = ((b - r) / d + 2) / 6;
                                                    break;
                                                case b:
                                                    h = ((r - g) / d + 4) / 6;
                                                    break;
                                            }
                                        }
                                        const hsl = `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
                                        setPrimaryColor(hsl);
                                    }}
                                />
                                {!COLORS.some((c) => c.value === primaryColor) ? (
                                    <Check className="text-white drop-shadow-md" size={10} />
                                ) : (
                                    <Palette size={12} className="text-white drop-shadow-md" />
                                )}
                            </label>
                        </div>

                        <SectionHeader title="Custom CSS" />
                        <div className="space-y-2">
                            <p className="text-xs text-muted-foreground">
                                Add custom CSS to personalize the app appearance. Changes apply
                                immediately.
                            </p>
                            <textarea
                                value={customCSS}
                                onChange={(e) => setCustomCSS(e.target.value)}
                                placeholder={`/* Example: */\n.terminal { background: #1a1a2e !important; }\n:root { --radius: 0.25rem; }`}
                                className="w-full h-32 px-3 py-2 text-xs font-mono bg-muted/50 border border-border rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-primary/50"
                                spellCheck={false}
                            />
                        </div>
                    </SettingsTabContent>

                    {/* Terminal Tab */}
                    <SettingsTabContent value="terminal">
                        <SectionHeader title="Terminal Theme" />
                        <div className="grid grid-cols-2 gap-3">
                            {TERMINAL_THEMES.map((t) => (
                                <TerminalThemeCard
                                    key={t.id}
                                    theme={t}
                                    active={terminalThemeId === t.id}
                                    onClick={() => setTerminalThemeId(t.id)}
                                />
                            ))}
                        </div>

                        <SectionHeader title="Font" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow label="Font" description="Terminal font family">
                                <Select
                                    value={terminalFontFamilyId}
                                    options={TERMINAL_FONTS.map((f) => ({
                                        value: f.id,
                                        label: f.name,
                                    }))}
                                    onChange={(id) => setTerminalFontFamilyId(id)}
                                    className="w-44"
                                />
                            </SettingRow>

                            <SettingRow label="Text Size">
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => {
                                            if (terminalFontSize > MIN_FONT_SIZE) {
                                                setTerminalFontSize(terminalFontSize - 1);
                                            }
                                        }}
                                        className="w-8 h-8 flex items-center justify-center rounded-md bg-muted hover:bg-muted/80 transition-colors"
                                        disabled={terminalFontSize <= MIN_FONT_SIZE}
                                    >
                                        <Minus size={14} />
                                    </button>
                                    <div className="w-10 h-8 flex items-center justify-center text-sm font-medium">
                                        {terminalFontSize}
                                    </div>
                                    <button
                                        onClick={() => {
                                            if (terminalFontSize < MAX_FONT_SIZE) {
                                                setTerminalFontSize(terminalFontSize + 1);
                                            }
                                        }}
                                        className="w-8 h-8 flex items-center justify-center rounded-md bg-muted hover:bg-muted/80 transition-colors"
                                        disabled={terminalFontSize >= MAX_FONT_SIZE}
                                    >
                                        <Plus size={14} />
                                    </button>
                                </div>
                            </SettingRow>

                            <SettingRow
                                label="Enable font ligatures"
                                description="Display programming ligatures like => and !="
                            >
                                <Toggle
                                    checked={terminalSettings.fontLigatures}
                                    onChange={(v) => updateTerminalSetting("fontLigatures", v)}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Use bright colours for bold text"
                            >
                                <Toggle
                                    checked={terminalSettings.drawBoldInBrightColors}
                                    onChange={(v) => updateTerminalSetting("drawBoldInBrightColors", v)}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Font weight"
                                description="Weight for normal text (100-900)"
                            >
                                <Select
                                    value={String(terminalSettings.fontWeight)}
                                    options={[
                                        { value: "100", label: "100 - Thin" },
                                        { value: "200", label: "200 - Extra Light" },
                                        { value: "300", label: "300 - Light" },
                                        { value: "400", label: "400 - Normal" },
                                        { value: "500", label: "500 - Medium" },
                                        { value: "600", label: "600 - Semi Bold" },
                                        { value: "700", label: "700 - Bold" },
                                        { value: "800", label: "800 - Extra Bold" },
                                        { value: "900", label: "900 - Black" },
                                    ]}
                                    onChange={(v) => updateTerminalSetting("fontWeight", parseInt(v))}
                                    className="w-40"
                                />
                            </SettingRow>

                            <SettingRow
                                label="Bold font weight"
                                description="Weight for bold text (100-900)"
                            >
                                <Select
                                    value={String(terminalSettings.fontWeightBold)}
                                    options={[
                                        { value: "100", label: "100 - Thin" },
                                        { value: "200", label: "200 - Extra Light" },
                                        { value: "300", label: "300 - Light" },
                                        { value: "400", label: "400 - Normal" },
                                        { value: "500", label: "500 - Medium" },
                                        { value: "600", label: "600 - Semi Bold" },
                                        { value: "700", label: "700 - Bold" },
                                        { value: "800", label: "800 - Extra Bold" },
                                        { value: "900", label: "900 - Black" },
                                    ]}
                                    onChange={(v) => updateTerminalSetting("fontWeightBold", parseInt(v))}
                                    className="w-40"
                                />
                            </SettingRow>

                            <SettingRow
                                label="Line padding"
                                description="Additional space between lines (0-10)"
                            >
                                <div className="flex items-center gap-2">
                                    <input
                                        type="range"
                                        min={0}
                                        max={10}
                                        step={1}
                                        value={terminalSettings.linePadding}
                                        onChange={(e) => updateTerminalSetting("linePadding", parseInt(e.target.value))}
                                        className="w-24 accent-primary"
                                    />
                                    <span className="text-sm text-muted-foreground w-6 text-center">
                                        {terminalSettings.linePadding}
                                    </span>
                                </div>
                            </SettingRow>

                            <SettingRow label="Terminal emulation type">
                                <Select
                                    value={terminalSettings.terminalEmulationType}
                                    options={[
                                        { value: "xterm-256color", label: "xterm-256color" },
                                        { value: "xterm-16color", label: "xterm-16color" },
                                        { value: "xterm", label: "xterm" },
                                    ]}
                                    onChange={(v) =>
                                        updateTerminalSetting("terminalEmulationType", v as TerminalEmulationType)
                                    }
                                    className="w-36"
                                />
                            </SettingRow>
                        </div>

                        <SectionHeader title="Cursor" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow label="Cursor style">
                                <Select
                                    value={terminalSettings.cursorShape}
                                    options={[
                                        { value: "block", label: "Block" },
                                        { value: "bar", label: "Bar" },
                                        { value: "underline", label: "Underline" },
                                    ]}
                                    onChange={(v) =>
                                        updateTerminalSetting("cursorShape", v as CursorShape)
                                    }
                                    className="w-32"
                                />
                            </SettingRow>

                            <SettingRow label="Cursor blink">
                                <Toggle
                                    checked={terminalSettings.cursorBlink}
                                    onChange={(v) => updateTerminalSetting("cursorBlink", v)}
                                />
                            </SettingRow>
                        </div>

                        <SectionHeader title="Keyboard" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow
                                label="Use Option as Meta key"
                                description="Use ⌥ Option (Alt) as the Meta key instead of for special characters"
                            >
                                <Toggle
                                    checked={terminalSettings.altAsMeta}
                                    onChange={(v) => updateTerminalSetting("altAsMeta", v)}
                                />
                            </SettingRow>
                        </div>

                        <SectionHeader title="Accessibility" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow
                                label="Minimum contrast ratio"
                                description="Adjust colors to meet contrast requirements (1 = disabled, 21 = max)"
                            >
                                <div className="flex items-center gap-2">
                                    <input
                                        type="range"
                                        min={1}
                                        max={21}
                                        step={1}
                                        value={terminalSettings.minimumContrastRatio}
                                        onChange={(e) => updateTerminalSetting("minimumContrastRatio", parseInt(e.target.value))}
                                        className="w-24 accent-primary"
                                    />
                                    <span className="text-sm text-muted-foreground w-6 text-center">
                                        {terminalSettings.minimumContrastRatio}
                                    </span>
                                </div>
                            </SettingRow>
                        </div>

                        <SectionHeader title="Behavior" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow
                                label="Right-click behavior"
                                description="Action when right-clicking in terminal"
                            >
                                <Select
                                    value={terminalSettings.rightClickBehavior}
                                    options={[
                                        { value: "context-menu", label: "Show Menu" },
                                        { value: "paste", label: "Paste" },
                                        { value: "select-word", label: "Select Word" },
                                    ]}
                                    onChange={(v) =>
                                        updateTerminalSetting(
                                            "rightClickBehavior",
                                            v as RightClickBehavior
                                        )
                                    }
                                    className="w-36"
                                />
                            </SettingRow>

                            <SettingRow
                                label="Copy on select"
                                description="Automatically copy selected text"
                            >
                                <Toggle
                                    checked={terminalSettings.copyOnSelect}
                                    onChange={(v) => updateTerminalSetting("copyOnSelect", v)}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Middle-click paste"
                                description="Paste clipboard content on middle-click"
                            >
                                <Toggle
                                    checked={terminalSettings.middleClickPaste}
                                    onChange={(v) => updateTerminalSetting("middleClickPaste", v)}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Scroll on input"
                                description="Scroll terminal to bottom when typing"
                            >
                                <Toggle
                                    checked={terminalSettings.scrollOnInput}
                                    onChange={(v) => updateTerminalSetting("scrollOnInput", v)}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Word separators"
                                description="Characters used to separate words for double-click selection"
                            >
                                <Input
                                    value={terminalSettings.wordSeparators}
                                    onChange={(e) => updateTerminalSetting("wordSeparators", e.target.value)}
                                    className="w-32 text-center font-mono"
                                    placeholder=" ()[]{}'&quot;"
                                />
                            </SettingRow>

                            <SettingRow
                                label="Link modifier key"
                                description="Hold this key to click on links in terminal"
                            >
                                <Select
                                    value={terminalSettings.linkModifier}
                                    options={[
                                        { value: "none", label: "None (click directly)" },
                                        { value: "ctrl", label: "Ctrl" },
                                        { value: "alt", label: "Alt / Option" },
                                        { value: "meta", label: "Cmd / Win" },
                                    ]}
                                    onChange={(v) => updateTerminalSetting("linkModifier", v as LinkModifier)}
                                    className="w-40"
                                />
                            </SettingRow>
                        </div>

                        <SectionHeader title="Scrollback" />
                        <div className="rounded-lg border bg-card p-4">
                            <p className="text-sm text-muted-foreground mb-3">
                                Limit number of terminal rows. Set to 0 to maximum limit size.
                            </p>
                            <div className="space-y-1">
                                <Label className="text-xs">Number of rows *</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    max={100000}
                                    value={terminalSettings.scrollback}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        if (!isNaN(val) && val >= 0 && val <= 100000) {
                                            updateTerminalSetting("scrollback", val);
                                        }
                                    }}
                                    className="w-full"
                                />
                            </div>
                        </div>

                        <SectionHeader title="Keyword highlighting" />
                        <div className="rounded-lg border bg-card p-4">
                            <div className="flex items-center justify-between mb-4">
                                <span className="text-sm font-medium">Keyword highlighting</span>
                                <Toggle
                                    checked={terminalSettings.keywordHighlightEnabled}
                                    onChange={(v) => updateTerminalSetting("keywordHighlightEnabled", v)}
                                />
                            </div>
                            {terminalSettings.keywordHighlightEnabled && (
                                <div className="space-y-2.5">
                                    {terminalSettings.keywordHighlightRules.map((rule) => (
                                        <div key={rule.id} className="flex items-center justify-between">
                                            <span className="text-sm" style={{ color: rule.color }}>
                                                {rule.label}
                                            </span>
                                            <label className="relative">
                                                <input
                                                    type="color"
                                                    value={rule.color}
                                                    onChange={(e) => {
                                                        const newRules = terminalSettings.keywordHighlightRules.map(r =>
                                                            r.id === rule.id ? { ...r, color: e.target.value } : r
                                                        );
                                                        updateTerminalSetting("keywordHighlightRules", newRules);
                                                    }}
                                                    className="sr-only"
                                                />
                                                <span
                                                    className="block w-10 h-6 rounded-md cursor-pointer border border-border/50 hover:border-border transition-colors"
                                                    style={{ backgroundColor: rule.color }}
                                                />
                                            </label>
                                        </div>
                                    ))}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="w-full mt-3 text-muted-foreground hover:text-foreground"
                                        onClick={() => {
                                            // Reset colors to default values
                                            const resetRules = terminalSettings.keywordHighlightRules.map(rule => {
                                                const defaultRule = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find(r => r.id === rule.id);
                                                return defaultRule ? { ...rule, color: defaultRule.color } : rule;
                                            });
                                            updateTerminalSetting("keywordHighlightRules", resetRules);
                                        }}
                                    >
                                        <RotateCcw size={14} className="mr-2" />
                                        Reset to default colors
                                    </Button>
                                </div>
                            )}
                        </div>
                    </SettingsTabContent>

                    {/* Shortcuts Tab */}
                    <SettingsTabContent value="shortcuts">
                        <SectionHeader title="Hotkey Scheme" />
                        <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
                            <SettingRow
                                label="Keyboard shortcuts"
                                description="Choose which keyboard layout to use for shortcuts"
                            >
                                <Select
                                    value={hotkeyScheme}
                                    options={[
                                        { value: "disabled", label: "Disabled" },
                                        { value: "mac", label: "Mac (⌘)" },
                                        { value: "pc", label: "PC (Ctrl)" },
                                    ]}
                                    onChange={(v) => setHotkeyScheme(v as HotkeyScheme)}
                                    className="w-32"
                                />
                            </SettingRow>
                        </div>

                        {hotkeyScheme !== "disabled" && (
                            <>
                                <div className="flex items-center justify-between">
                                    <SectionHeader title="Custom Shortcuts" className="mb-0" />
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={resetAllKeyBindings}
                                        className="text-xs gap-1"
                                    >
                                        <RotateCcw size={12} /> Reset All
                                    </Button>
                                </div>

                                {(["tabs", "terminal", "navigation", "app"] as const).map(
                                    (category) => {
                                        const categoryBindings = keyBindings.filter(
                                            (kb) => kb.category === category
                                        );
                                        if (categoryBindings.length === 0) return null;
                                        return (
                                            <div key={category}>
                                                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                                                    {category}
                                                </h4>
                                                <div className="space-y-0 divide-y divide-border rounded-lg border bg-card">
                                                    {categoryBindings.map((binding) => {
                                                        // Get the shortcut for the current scheme
                                                        const currentKey = hotkeyScheme === 'mac' ? binding.mac : binding.pc;
                                                        // Check if this is a special binding (with patterns like [1...9] or arrows)
                                                        const specialSuffix = currentKey.includes('[1...9]')
                                                            ? '[1...9]'
                                                            : currentKey.includes('arrows')
                                                                ? 'arrows'
                                                                : null;
                                                        const isSpecialBinding = !!specialSuffix;

                                                        // For special bindings, extract the modifier prefix
                                                        const modifierPrefix = isSpecialBinding
                                                            ? currentKey.replace(specialSuffix, '').trim().replace(/\+\s*$/, '').trim()
                                                            : null;

                                                        // Check if we're recording this special binding
                                                        const isRecordingThis = recordingBindingId === binding.id;

                                                        return (
                                                            <div
                                                                key={binding.id}
                                                                className="flex items-center justify-between px-4 py-2"
                                                            >
                                                                <span className="text-sm">{binding.label}</span>
                                                                <div className="flex items-center gap-2">
                                                                    {isSpecialBinding ? (
                                                                        // Special bindings: show editable modifier prefix + fixed suffix
                                                                        <div className="flex items-center gap-1">
                                                                            <button
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    setRecordingBindingId(binding.id);
                                                                                    setRecordingScheme(hotkeyScheme === 'mac' ? 'mac' : 'pc');
                                                                                }}
                                                                                className={cn(
                                                                                    "px-2 py-1 text-xs font-mono rounded border transition-colors min-w-[60px] text-center",
                                                                                    isRecordingThis
                                                                                        ? "border-primary bg-primary/10 animate-pulse"
                                                                                        : "border-border hover:border-primary/50"
                                                                                )}
                                                                            >
                                                                                {isRecordingThis
                                                                                    ? "Press Keys..."
                                                                                    : modifierPrefix || 'None'}
                                                                            </button>
                                                                            <span className="text-xs text-muted-foreground">+</span>
                                                                            <span className="px-2 py-1 text-xs font-mono rounded border border-border bg-muted/30 text-muted-foreground">
                                                                                {specialSuffix}
                                                                            </span>
                                                                        </div>
                                                                    ) : (
                                                                        // Regular bindings: show editable button
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                setRecordingBindingId(binding.id);
                                                                                setRecordingScheme(hotkeyScheme === 'mac' ? 'mac' : 'pc');
                                                                            }}
                                                                            className={cn(
                                                                                "px-2 py-1 text-xs font-mono rounded border transition-colors min-w-[80px] text-center",
                                                                                isRecordingThis
                                                                                    ? "border-primary bg-primary/10 animate-pulse"
                                                                                    : "border-border hover:border-primary/50"
                                                                            )}
                                                                        >
                                                                            {isRecordingThis
                                                                                ? "Press Keys..."
                                                                                : currentKey || 'Disabled'}
                                                                        </button>
                                                                    )}
                                                                    <button
                                                                        onClick={() =>
                                                                            resetKeyBinding?.(binding.id, hotkeyScheme === 'mac' ? 'mac' : 'pc')
                                                                        }
                                                                        className="p-1 hover:bg-muted rounded"
                                                                        title="Reset to default"
                                                                    >
                                                                        <RotateCcw size={12} />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    }
                                )}
                            </>
                        )}
                    </SettingsTabContent>

                    {/* Sync & Cloud Tab */}
                    <SettingsTabContent value="sync">
                        <CloudSyncSettings
                            onBuildPayload={buildSyncPayload}
                            onApplyPayload={applySyncPayload}
                        />
                    </SettingsTabContent>

                    {/* Data Tab */}
                    <SettingsTabContent value="data">
                        <SectionHeader title="Export Data" />
                        <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Export all your hosts, keys, and snippets as JSON.
                            </p>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    const data = exportData();
                                    const blob = new Blob([JSON.stringify(data, null, 2)], {
                                        type: "application/json",
                                    });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url;
                                    a.download = "netcatty-backup.json";
                                    a.click();
                                    URL.revokeObjectURL(url);
                                }}
                                className="gap-2"
                            >
                                <Download size={14} />
                                Export JSON
                            </Button>
                        </div>

                        <SectionHeader title="Import Data" />
                        <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Import hosts, keys, and snippets from JSON.
                            </p>
                            <Textarea
                                value={importText}
                                onChange={(e) => setImportText(e.target.value)}
                                placeholder='Paste JSON here or use "Choose File" below'
                                className="h-32 font-mono text-xs"
                            />
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        const input = document.createElement("input");
                                        input.type = "file";
                                        input.accept = ".json";
                                        input.onchange = (e) => {
                                            const file = (e.target as HTMLInputElement).files?.[0];
                                            if (file) {
                                                const reader = new FileReader();
                                                reader.onload = (ev) => {
                                                    setImportText(ev.target?.result as string);
                                                };
                                                reader.readAsText(file);
                                            }
                                        };
                                        input.click();
                                    }}
                                    className="gap-2"
                                >
                                    <Upload size={14} />
                                    Choose File
                                </Button>
                                <Button
                                    onClick={() => {
                                        if (!importText.trim()) return;
                                        try {
                                            importDataFromString(importText);
                                            setImportText("");
                                            toast.success("Import successful!");
                                        } catch (e) {
                                            toast.error(String(e), "Import failed");
                                        }
                                    }}
                                    disabled={!importText.trim()}
                                >
                                    Import
                                </Button>
                            </div>
                        </div>
                    </SettingsTabContent>
                </div>
            </Tabs>
        </div>
    );
}
