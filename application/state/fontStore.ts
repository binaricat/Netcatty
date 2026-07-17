import { useSyncExternalStore } from 'react';
import { TERMINAL_FONTS, type TerminalFont } from '../../infrastructure/config/fonts';
import {
  clearLocalFontsCache,
  getAllSystemFontFamilyNames,
  getMonospaceFonts,
} from '../../lib/localFonts';
import {
  clearFontAvailabilityCache,
  setSystemFamilies,
} from '../../lib/fontAvailability';

/**
 * Global font store - singleton pattern using useSyncExternalStore
 * Ensures fonts are loaded only once and shared across all components
 */
type Listener = () => void;

interface FontStoreState {
  availableFonts: TerminalFont[];
  installedFontFamilies: string[] | null;
  isLoading: boolean;
  isLoaded: boolean;
  error: string | null;
}

class FontStore {
  private state: FontStoreState = {
    availableFonts: TERMINAL_FONTS,
    installedFontFamilies: null,
    isLoading: false,
    isLoaded: false,
    error: null,
  };
  private listeners = new Set<Listener>();

  // Getters for individual state slices
  getAvailableFonts = (): TerminalFont[] => this.state.availableFonts;
  getInstalledFontFamilies = (): string[] | null => this.state.installedFontFamilies;
  getIsLoading = (): boolean => this.state.isLoading;
  getIsLoaded = (): boolean => this.state.isLoaded;
  getError = (): string | null => this.state.error;

  private notify = () => {
    // Defer listener notification to avoid "setState during render"
    Promise.resolve().then(() => {
      this.listeners.forEach(listener => listener());
    });
  };

  private setState = (partial: Partial<FontStoreState>) => {
    this.state = { ...this.state, ...partial };
    this.notify();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Initialize font loading - safe to call multiple times,
   * will only load once
   */
  initialize = async (): Promise<void> => {
    // Already loaded or currently loading
    if (this.state.isLoaded || this.state.isLoading) {
      return;
    }

    this.setState({ isLoading: true, error: null });

    try {
      // Populate the authoritative installed-family set used by
      // fontAvailability.isFontInstalled. Runs in parallel with the
      // monospace-only query (both share an underlying cache).
      const [localFonts, installedFontFamilies] = await Promise.all([
        getMonospaceFonts(),
        getAllSystemFontFamilyNames(),
      ]);
      setSystemFamilies(
        installedFontFamilies
          ? new Set(installedFontFamilies.map((family) => family.toLowerCase()))
          : null,
      );

      // Combine default fonts with local fonts, deduplicate by id
      const fontMap = new Map<string, TerminalFont>();

      // Add default fonts first
      TERMINAL_FONTS.forEach(font => fontMap.set(font.id, font));

      // Build a set of built-in font family names for dedup (case-insensitive)
      const builtinFamilyNames = new Set(
        TERMINAL_FONTS.map(f => f.name.toLowerCase())
      );

      // Add local fonts, skipping those already covered by built-in fonts
      localFonts.forEach(font => {
        if (builtinFamilyNames.has(font.name.toLowerCase())) return;
        const localId = font.id.startsWith('local-') ? font.id : `local-${font.id}`;
        fontMap.set(localId, { ...font, id: localId });
      });

      this.setState({
        availableFonts: Array.from(fontMap.values()),
        installedFontFamilies,
        isLoading: false,
        isLoaded: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load local fonts';
      console.warn('Failed to fetch local fonts, using defaults:', error);
      this.setState({
        availableFonts: TERMINAL_FONTS,
        installedFontFamilies: null,
        isLoading: false,
        isLoaded: true,
        error: errorMessage,
      });
    }
  };

  refresh = async (): Promise<void> => {
    if (this.state.isLoading) return;
    clearLocalFontsCache();
    clearFontAvailabilityCache();
    this.setState({ isLoaded: false });
    await this.initialize();
  };

  /**
   * Find a font by ID with fallback
   */
  getFontById = (fontId: string): TerminalFont => {
    const fonts = this.state.availableFonts;
    return fonts.find(f => f.id === fontId) || fonts[0] || TERMINAL_FONTS[0];
  };
}

// Singleton instance
export const fontStore = new FontStore();

// ============== Hooks ==============

/**
 * Get available fonts - triggers initialization on first use
 */
export const useAvailableFonts = (): TerminalFont[] => {
  // Trigger initialization on first use
  if (!fontStore.getIsLoaded() && !fontStore.getIsLoading()) {
    fontStore.initialize();
  }
  
  return useSyncExternalStore(
    fontStore.subscribe,
    fontStore.getAvailableFonts
  );
};

export const useInstalledFontFamilies = (): string[] | null => {
  if (!fontStore.getIsLoaded() && !fontStore.getIsLoading()) {
    fontStore.initialize();
  }
  return useSyncExternalStore(
    fontStore.subscribe,
    fontStore.getInstalledFontFamilies,
  );
};

export const useFontsLoading = (): boolean => useSyncExternalStore(
  fontStore.subscribe,
  fontStore.getIsLoading,
);

export const refreshFonts = (): Promise<void> => fontStore.refresh();

/**
 * Initialize fonts eagerly (call at app startup)
 */
export const initializeFonts = (): void => {
  fontStore.initialize();
};
