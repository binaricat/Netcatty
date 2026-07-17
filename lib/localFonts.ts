import { TerminalFont } from "../infrastructure/config/fonts"

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

// Cached unfiltered system family list so we don't hit the Local Font
// Access API more than once per session. Populated as a side effect of
// queryAllSystemFontsOnce(), which both getMonospaceFonts() and
// fontAvailability.ts read.
let allSystemFamiliesCache: Set<string> | null = null;
let allSystemFamilyNamesCache: string[] | null = null;

// In-flight promise dedup: when fontStore.initialize() runs
// getMonospaceFonts() and getAllSystemFontFamilies() in parallel, both
// would otherwise hit queryLocalFonts() before the cache is populated,
// causing two redundant Local Font Access API calls and potential
// permission-handling races. Caching the promise itself means
// concurrent callers await the same single invocation.
let queryPromise: Promise<LocalFontData[]> | null = null;

/** Clears the cached font query so a user-initiated refresh sees changes. */
export function clearLocalFontsCache(): void {
    queryPromise = null;
    allSystemFamiliesCache = null;
    allSystemFamilyNamesCache = null;
}

/** Test alias kept explicit so existing tests communicate their intent. */
export const __resetLocalFontsCacheForTesting = clearLocalFontsCache;

function queryAllSystemFontsOnce(): Promise<LocalFontData[]> {
    if (queryPromise) return queryPromise;
    queryPromise = (async () => {
        if (typeof window === "undefined" || !("queryLocalFonts" in window)) {
            return [];
        }
        try {
            const queryLocalFonts = (window as unknown as {
                queryLocalFonts: () => Promise<LocalFontData[]>;
            }).queryLocalFonts;
            const fonts = await queryLocalFonts();
            // A desktop OS always has fonts. Chromium can still resolve the
            // API with an empty list when access is temporarily unavailable;
            // do not treat that as authoritative or cache it for the session.
            if (fonts.length === 0) {
                queryPromise = null;
                return [];
            }
            const familyNamesByLower = new Map<string, string>();
            for (const font of fonts) {
                const family = font.family.trim();
                if (!family) continue;
                const normalized = family.toLowerCase();
                if (!familyNamesByLower.has(normalized)) {
                    familyNamesByLower.set(normalized, family);
                }
            }
            allSystemFamilyNamesCache = [...familyNamesByLower.values()].sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: 'base' }),
            );
            allSystemFamiliesCache = new Set(familyNamesByLower.keys());
            return fonts;
        } catch (error) {
            // Don't sticky-cache a transient failure (e.g. LFA permission
            // not ready yet at app boot, AbortError, etc.). Clearing the
            // module-level promise lets the very next caller retry the
            // API. Successful calls keep their cached promise as before,
            // so this only retries when something actually went wrong.
            console.warn('Failed to query local fonts:', error);
            queryPromise = null;
            return [];
        }
    })();
    return queryPromise;
}

/**
 * Returns the case-insensitive set of every font family installed on the
 * system, as reported by the Local Font Access API. Used by
 * fontAvailability.ts to decide which built-in font choices to show in
 * the dropdown.
 *
 * Returns null when the API is unavailable or permission has been
 * denied — callers should treat that as "no authoritative data" and
 * fall back to canvas-width detection.
 */
export async function getAllSystemFontFamilies(): Promise<Set<string> | null> {
    if (allSystemFamiliesCache) return allSystemFamiliesCache;
    await queryAllSystemFontsOnce();
    return allSystemFamiliesCache;
}

/**
 * Returns installed font family names with display casing preserved.
 * Families are trimmed, deduplicated case-insensitively, and sorted for
 * stable searchable pickers.
 */
export async function getAllSystemFontFamilyNames(): Promise<string[] | null> {
    if (allSystemFamilyNamesCache) return allSystemFamilyNamesCache;
    await queryAllSystemFontsOnce();
    return allSystemFamilyNamesCache;
}

/**
 * Queries local monospace fonts from the system using the Font Access API.
 * Returns an empty array if the API is not available or permission is denied.
 */
export async function getMonospaceFonts(): Promise<TerminalFont[]> {
    const fonts = await queryAllSystemFontsOnce();
    if (fonts.length === 0) return [];

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

    // Raw Latin family only; CJK fallback is composed at runtime by
    // composeFontFamilyStack() in cjkFonts.ts.
    return dedupedFonts.map(f => {
        const quoted = /\s/.test(f.family) ? `"${f.family}"` : f.family;
        return {
            id: f.family,
            name: f.family,
            family: `${quoted}, monospace`,
            description: `Local font: ${f.family}`,
            category: 'monospace' as const,
        };
    });
}
