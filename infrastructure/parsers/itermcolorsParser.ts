import { TerminalTheme } from '../../domain/models';

/**
 * Parse an .itermcolors XML plist file into a TerminalTheme.
 *
 * .itermcolors is Apple Plist XML with color keys like:
 *   "Ansi 0 Color", "Background Color", "Foreground Color", etc.
 * Each color is a <dict> with "Red Component", "Green Component", "Blue Component" as <real> floats (0.0–1.0).
 */

/** Map .itermcolors key names to TerminalTheme color fields */
const COLOR_KEY_MAP: Record<string, keyof TerminalTheme['colors']> = {
    'Ansi 0 Color': 'black',
    'Ansi 1 Color': 'red',
    'Ansi 2 Color': 'green',
    'Ansi 3 Color': 'yellow',
    'Ansi 4 Color': 'blue',
    'Ansi 5 Color': 'magenta',
    'Ansi 6 Color': 'cyan',
    'Ansi 7 Color': 'white',
    'Ansi 8 Color': 'brightBlack',
    'Ansi 9 Color': 'brightRed',
    'Ansi 10 Color': 'brightGreen',
    'Ansi 11 Color': 'brightYellow',
    'Ansi 12 Color': 'brightBlue',
    'Ansi 13 Color': 'brightMagenta',
    'Ansi 14 Color': 'brightCyan',
    'Ansi 15 Color': 'brightWhite',
    'Background Color': 'background',
    'Foreground Color': 'foreground',
    'Cursor Color': 'cursor',
    'Selection Color': 'selection',
};

/**
 * Convert a float (0.0–1.0) to a two-digit hex string.
 */
function floatToHex(value: number): string {
    const clamped = Math.max(0, Math.min(1, value));
    const byte = Math.round(clamped * 255);
    return byte.toString(16).padStart(2, '0');
}

/**
 * Detect if a background color is dark or light based on relative luminance.
 */
function isDarkBackground(hex: string): boolean {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    // Relative luminance formula (ITU-R BT.709)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 0.5;
}

/**
 * Parse a single color <dict> element from the plist XML.
 * Returns a hex color string like '#rrggbb'.
 */
function parseColorDict(dictElement: Element): string | null {
    const children = dictElement.children;
    let r = 0, g = 0, b = 0;
    let found = 0;

    for (let i = 0; i < children.length - 1; i++) {
        const child = children[i];
        if (child.tagName !== 'key') continue;

        const key = child.textContent?.trim();
        const valueEl = children[i + 1];
        if (!key || !valueEl) continue;

        // Accept <real> (float 0.0–1.0) and <integer> (0–255) plist types
        const tag = valueEl.tagName;
        if (tag !== 'real' && tag !== 'integer') continue;

        const raw = parseFloat(valueEl.textContent || '0');
        if (isNaN(raw)) continue; // reject non-numeric content

        // Normalize: <integer> values are 0-255, <real> values are 0.0-1.0
        const value = tag === 'integer' ? raw / 255 : raw;

        if (key === 'Red Component') { r = value; found++; }
        else if (key === 'Green Component') { g = value; found++; }
        else if (key === 'Blue Component') { b = value; found++; }
    }

    if (found < 3) return null;
    return `#${floatToHex(r)}${floatToHex(g)}${floatToHex(b)}`;
}

/**
 * Parse an .itermcolors XML string into a TerminalTheme.
 *
 * @param xml    - The raw XML string from the .itermcolors file
 * @param name   - The theme name (usually derived from the filename)
 * @returns      - A TerminalTheme, or null if parsing fails
 */
export function parseItermcolors(xml: string, name: string): TerminalTheme | null {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'text/xml');

        // Check for parse errors
        const parseError = doc.querySelector('parsererror');
        if (parseError) return null;

        // Get the root <dict> inside <plist>
        const rootDict = doc.querySelector('plist > dict');
        if (!rootDict) return null;

        // Parse key-value pairs from the root dict
        const colors: Partial<TerminalTheme['colors']> = {};
        const children = rootDict.children;

        for (let i = 0; i < children.length - 1; i++) {
            const child = children[i];
            if (child.tagName !== 'key') continue;

            const keyName = child.textContent?.trim() || '';
            const colorField = COLOR_KEY_MAP[keyName];
            if (!colorField) continue;

            // The next sibling should be a <dict> with color components
            const nextSibling = children[i + 1];
            if (!nextSibling || nextSibling.tagName !== 'dict') continue;

            const hex = parseColorDict(nextSibling);
            if (hex) {
                colors[colorField] = hex;
            }
        }

        // Validate we have at least the essential colors
        if (!colors.background || !colors.foreground) return null;

        // Fill any missing ANSI colors with sensible defaults
        const defaults: TerminalTheme['colors'] = {
            background: colors.background,
            foreground: colors.foreground,
            cursor: colors.cursor || colors.foreground,
            selection: colors.selection || (isDarkBackground(colors.background) ? '#264f78' : '#add6ff'),
            black: colors.black || '#000000',
            red: colors.red || '#cc0000',
            green: colors.green || '#00cc00',
            yellow: colors.yellow || '#cccc00',
            blue: colors.blue || '#0000cc',
            magenta: colors.magenta || '#cc00cc',
            cyan: colors.cyan || '#00cccc',
            white: colors.white || '#cccccc',
            brightBlack: colors.brightBlack || '#666666',
            brightRed: colors.brightRed || '#ff0000',
            brightGreen: colors.brightGreen || '#00ff00',
            brightYellow: colors.brightYellow || '#ffff00',
            brightBlue: colors.brightBlue || '#0000ff',
            brightMagenta: colors.brightMagenta || '#ff00ff',
            brightCyan: colors.brightCyan || '#00ffff',
            brightWhite: colors.brightWhite || '#ffffff',
        };

        const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;

        return {
            id,
            name,
            type: isDarkBackground(defaults.background) ? 'dark' : 'light',
            isCustom: true,
            colors: defaults,
        };
    } catch {
        return null;
    }
}
