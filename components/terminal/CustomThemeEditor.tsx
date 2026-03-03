/**
 * Custom Theme Editor Panel
 * Inline color editor for creating/editing custom terminal themes.
 * Uses native <input type="color"> for zero-dependency color picking.
 */

import React, { useCallback, memo } from 'react';
import { TerminalTheme } from '../../domain/models';
import { useI18n } from '../../application/i18n/I18nProvider';


interface ColorFieldDef {
    key: keyof TerminalTheme['colors'];
    labelKey: string;
}

const GENERAL_COLORS: ColorFieldDef[] = [
    { key: 'background', labelKey: 'terminal.customTheme.color.background' },
    { key: 'foreground', labelKey: 'terminal.customTheme.color.foreground' },
    { key: 'cursor', labelKey: 'terminal.customTheme.color.cursor' },
    { key: 'selection', labelKey: 'terminal.customTheme.color.selection' },
];

const NORMAL_COLORS: ColorFieldDef[] = [
    { key: 'black', labelKey: 'terminal.customTheme.color.black' },
    { key: 'red', labelKey: 'terminal.customTheme.color.red' },
    { key: 'green', labelKey: 'terminal.customTheme.color.green' },
    { key: 'yellow', labelKey: 'terminal.customTheme.color.yellow' },
    { key: 'blue', labelKey: 'terminal.customTheme.color.blue' },
    { key: 'magenta', labelKey: 'terminal.customTheme.color.magenta' },
    { key: 'cyan', labelKey: 'terminal.customTheme.color.cyan' },
    { key: 'white', labelKey: 'terminal.customTheme.color.white' },
];

const BRIGHT_COLORS: ColorFieldDef[] = [
    { key: 'brightBlack', labelKey: 'terminal.customTheme.color.brightBlack' },
    { key: 'brightRed', labelKey: 'terminal.customTheme.color.brightRed' },
    { key: 'brightGreen', labelKey: 'terminal.customTheme.color.brightGreen' },
    { key: 'brightYellow', labelKey: 'terminal.customTheme.color.brightYellow' },
    { key: 'brightBlue', labelKey: 'terminal.customTheme.color.brightBlue' },
    { key: 'brightMagenta', labelKey: 'terminal.customTheme.color.brightMagenta' },
    { key: 'brightCyan', labelKey: 'terminal.customTheme.color.brightCyan' },
    { key: 'brightWhite', labelKey: 'terminal.customTheme.color.brightWhite' },
];

const ColorInput = memo(({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
}) => {
    // Local state for text input — allows partial hex while typing
    const [textValue, setTextValue] = React.useState(value);
    // Sync external value changes into local state
    React.useEffect(() => { setTextValue(value); }, [value]);

    const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        if (!/^#[0-9a-fA-F]{0,6}$/.test(v)) return;
        setTextValue(v);
        // Only commit complete hex values (#rgb or #rrggbb)
        if (/^#[0-9a-fA-F]{3}$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v)) {
            // Normalize #rgb to #rrggbb
            const normalized = v.length === 4
                ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
                : v;
            onChange(normalized);
        }
    };

    // On blur, revert to the last committed value if incomplete
    const handleBlur = () => { setTextValue(value); };

    return (
        <div className="flex items-center gap-2">
            <div className="relative">
                <input
                    type="color"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border border-border/50 p-0"
                    style={{ appearance: 'none', WebkitAppearance: 'none', background: value }}
                />
            </div>
            <span className="text-[10px] text-muted-foreground flex-1 truncate">{label}</span>
            <input
                type="text"
                value={textValue}
                onChange={handleTextChange}
                onBlur={handleBlur}
                className="w-[68px] text-[10px] font-mono px-1.5 py-0.5 rounded border border-border bg-background text-foreground uppercase"
                spellCheck={false}
            />
        </div>
    );
});
ColorInput.displayName = 'ColorInput';

interface CustomThemeEditorProps {
    theme: TerminalTheme;
    onChange: (theme: TerminalTheme) => void;
    onBack?: () => void;  // kept for API compat but no longer rendered
    isNew?: boolean;
}

export const CustomThemeEditor: React.FC<CustomThemeEditorProps> = ({
    theme,
    onChange,
    onBack: _onBack,
    isNew: _isNew,
}) => {
    const { t } = useI18n();

    const updateColor = useCallback((key: keyof TerminalTheme['colors'], value: string) => {
        onChange({
            ...theme,
            colors: { ...theme.colors, [key]: value },
        });
    }, [theme, onChange]);

    const updateName = useCallback((name: string) => {
        onChange({ ...theme, name });
    }, [theme, onChange]);

    const toggleType = useCallback(() => {
        onChange({ ...theme, type: theme.type === 'dark' ? 'light' : 'dark' });
    }, [theme, onChange]);

    const renderColorGroup = (title: string, fields: ColorFieldDef[]) => (
        <div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                {title}
            </div>
            <div className="space-y-1">
                {fields.map(({ key, labelKey }) => (
                    <ColorInput
                        key={key}
                        label={t(labelKey)}
                        value={theme.colors[key]}
                        onChange={(v) => updateColor(key, v)}
                    />
                ))}
            </div>
        </div>
    );

    return (
        <div className="flex flex-col h-full">
            {/* Name + Type */}
            <div className="p-2 space-y-2 border-b border-border shrink-0">
                <div>
                    <label className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
                        {t('terminal.customTheme.name')}
                    </label>
                    <input
                        type="text"
                        value={theme.name}
                        onChange={(e) => updateName(e.target.value)}
                        className="w-full mt-1 text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground"
                        placeholder={t('terminal.customTheme.namePlaceholder')}
                    />
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold flex-1">
                        {t('terminal.customTheme.type')}
                    </label>
                    <button
                        onClick={toggleType}
                        className="text-[10px] px-2 py-0.5 rounded border border-border bg-muted/30 text-foreground hover:bg-muted transition-colors capitalize"
                    >
                        {theme.type}
                    </button>
                </div>
            </div>

            {/* Color Groups */}
            <div className="flex-1 overflow-y-auto p-2 space-y-3">
                {renderColorGroup(t('terminal.customTheme.group.general'), GENERAL_COLORS)}
                {renderColorGroup(t('terminal.customTheme.group.normal'), NORMAL_COLORS)}
                {renderColorGroup(t('terminal.customTheme.group.bright'), BRIGHT_COLORS)}
            </div>
        </div>
    );
};
