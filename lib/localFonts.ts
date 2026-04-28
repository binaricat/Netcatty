import { TerminalFont, withCjkFallback } from "../infrastructure/config/fonts"

/**
 * Type definition for Local Font Access API
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API
 */
interface LocalFontData {
    family: string;
}

/**
 * Known monospace font families that don't follow naming conventions.
 * These are popular programming/terminal fonts that should be included.
 */
const KNOWN_MONOSPACE_FONTS = new Set([
    // Popular programming fonts
    'iosevka',
    'hack',
    'consolas',
    'menlo',
    'monaco',
    'inconsolata',
    'mononoki',
    'fantasque sans mono',
    'anonymous pro',
    'liberation mono',
    'dejavu sans mono',
    'droid sans mono',
    'ubuntu mono',
    'roboto mono',
    'source code pro',
    'fira code',
    'fira mono',
    'jetbrains mono',
    'cascadia code',
    'cascadia mono',
    'victor mono',
    'ibm plex mono',
    'sf mono',
    'operator mono',
    'input mono',
    'pragmata pro',
    'berkeley mono',
    'monaspace',
    'geist mono',
    'comic mono',
    'courier',
    'courier new',
    'lucida console',
    'pt mono',
    'overpass mono',
    'space mono',
    'go mono',
    'noto sans mono',
    'sarasa mono',
    'maple mono',
    'meslolgs nf',
    'symbols nerd font mono',
    'symbols nerd font',
]);

/**
 * Suffix indicators that suggest a font is monospace
 */
const MONO_SUFFIX_INDICATORS = ['mono', 'monospace', 'code', 'terminal', 'console'];

/**
 * Checks if a font family name indicates a monospace font.
 * Uses both known font list and suffix matching for comprehensive detection.
 */
function isMonospaceFont(familyName: string): boolean {
    const familyLower = familyName.toLowerCase().trim();
    
    // Check against known monospace fonts (exact or partial match)
    for (const knownFont of KNOWN_MONOSPACE_FONTS) {
        if (familyLower === knownFont || familyLower.startsWith(knownFont + ' ')) {
            return true;
        }
    }
    
    // Check suffix indicators with word boundary
    return MONO_SUFFIX_INDICATORS.some(indicator => {
        return (
            familyLower === indicator ||
            familyLower.endsWith(' ' + indicator) ||
            familyLower.endsWith('-' + indicator) ||
            familyLower.includes(' ' + indicator + ' ')
        );
    });
}

/**
 * Queries local monospace fonts from the system using the Font Access API.
 * Returns an empty array if the API is not available or permission is denied.
 */
export async function getMonospaceFonts(): Promise<TerminalFont[]> {
    // Check if the Font Access API is available
    if (typeof window === "undefined" || !("queryLocalFonts" in window)) {
        return [];
    }

    try {
        const queryLocalFonts = (window as unknown as { queryLocalFonts: () => Promise<LocalFontData[]> }).queryLocalFonts;
        const fonts = await queryLocalFonts();

        // Filter monospace fonts using robust word boundary matching
        const monoFonts = fonts.filter(f => isMonospaceFont(f.family));

        // Deduplicate by family name, case-insensitive (API may return multiple entries per family)
        const uniqueFamilies = new Set<string>();
        const dedupedFonts = monoFonts.filter(f => {
            const key = f.family.toLowerCase();
            if (uniqueFamilies.has(key)) return false;
            uniqueFamilies.add(key);
            return true;
        });

        // Map to TerminalFont structure with CJK fallback applied
        return dedupedFonts.map(f => ({
            id: f.family,
            name: f.family,
            family: withCjkFallback(f.family + ', monospace'),
            description: `Local font: ${f.family}`,
            category: 'monospace' as const,
        }));
    } catch (error) {
        // Handle permission denied or other errors gracefully
        console.warn('Failed to query local fonts:', error);
        return [];
    }
}
