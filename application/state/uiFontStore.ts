import { useSyncExternalStore } from 'react';
import { UI_FONTS, withUiCjkFallback, type UIFont } from '../../infrastructure/config/uiFonts';

/**
 * UI Font Store - singleton pattern using useSyncExternalStore
 * Fetches system fonts and combines with bundled fonts
 */
type Listener = () => void;

interface UIFontStoreState {
  availableFonts: UIFont[];
  isLoading: boolean;
  isLoaded: boolean;
  error: string | null;
}

/**
 * Type definition for Local Font Access API
 */
interface LocalFontData {
  family: string;
}

class UIFontStore {
  private state: UIFontStoreState = {
    availableFonts: UI_FONTS,
    isLoading: false,
    isLoaded: false,
    error: null,
  };
  private listeners = new Set<Listener>();

  getAvailableFonts = (): UIFont[] => this.state.availableFonts;
  getIsLoading = (): boolean => this.state.isLoading;
  getIsLoaded = (): boolean => this.state.isLoaded;

  private notify = () => {
    Promise.resolve().then(() => {
      this.listeners.forEach(listener => listener());
    });
  };

  private setState = (partial: Partial<UIFontStoreState>) => {
    this.state = { ...this.state, ...partial };
    this.notify();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize = async (): Promise<void> => {
    if (this.state.isLoaded || this.state.isLoading) {
      return;
    }

    this.setState({ isLoading: true, error: null });

    try {
      const localFonts = await this.getLocalFonts();

      // Use a Map to deduplicate by normalized font name
      const fontMap = new Map<string, UIFont>();

      // Add bundled fonts first (they have priority)
      UI_FONTS.forEach(font => fontMap.set(font.id, font));

      // Add local fonts with a distinct ID namespace
      localFonts.forEach(font => {
        const localId = `local-${font.id}`;
        // Skip if a bundled font with similar name exists
        if (!fontMap.has(font.id)) {
          fontMap.set(localId, { ...font, id: localId });
        }
      });

      this.setState({
        availableFonts: Array.from(fontMap.values()),
        isLoading: false,
        isLoaded: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load local fonts';
      console.warn('Failed to fetch local UI fonts, using defaults:', error);
      this.setState({
        availableFonts: UI_FONTS,
        isLoading: false,
        isLoaded: true,
        error: errorMessage,
      });
    }
  };

  private async getLocalFonts(): Promise<UIFont[]> {
    if (typeof window === 'undefined' || !('queryLocalFonts' in window)) {
      return [];
    }

    try {
      const queryLocalFonts = (window as unknown as { queryLocalFonts: () => Promise<LocalFontData[]> }).queryLocalFonts;
      const fonts = await queryLocalFonts();

      // Deduplicate by family name
      const uniqueFamilies = new Set<string>();
      const dedupedFonts = fonts.filter(f => {
        if (uniqueFamilies.has(f.family)) return false;
        uniqueFamilies.add(f.family);
        return true;
      });

      // Map to UIFont structure
      return dedupedFonts.map(f => ({
        id: f.family.toLowerCase().replace(/\s+/g, '-'),
        name: f.family,
        family: withUiCjkFallback(`"${f.family}", system-ui`),
      }));
    } catch (error) {
      console.warn('Failed to query local fonts:', error);
      return [];
    }
  }

  getFontById = (fontId: string): UIFont => {
    const fonts = this.state.availableFonts;
    const found = fonts.find(f => f.id === fontId);
    if (found) return found;

    // For local fonts that haven't been loaded yet, construct a fallback
    // This handles the case when main window receives a local font ID before fonts are loaded
    if (fontId.startsWith('local-')) {
      const fontName = fontId
        .replace(/^local-/, '')
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      return {
        id: fontId,
        name: fontName,
        family: withUiCjkFallback(`"${fontName}", system-ui`),
      };
    }

    return fonts[0] || UI_FONTS[0];
  };
}

// Singleton instance
export const uiFontStore = new UIFontStore();

/**
 * Get available UI fonts - triggers initialization on first use
 */
export const useAvailableUIFonts = (): UIFont[] => {
  if (!uiFontStore.getIsLoaded() && !uiFontStore.getIsLoading()) {
    uiFontStore.initialize();
  }

  return useSyncExternalStore(
    uiFontStore.subscribe,
    uiFontStore.getAvailableFonts
  );
};

/**
 * Get UI font loaded state
 */
export const useUIFontsLoaded = (): boolean => {
  return useSyncExternalStore(
    uiFontStore.subscribe,
    uiFontStore.getIsLoaded
  );
};

/**
 * Check if a font ID is valid
 */
export const isValidUiFontId = (fontId: string): boolean => {
  // Local fonts are always considered valid (they start with 'local-')
  if (fontId.startsWith('local-')) return true;
  return uiFontStore.getAvailableFonts().some(f => f.id === fontId);
};

/**
 * Initialize UI fonts eagerly
 */
export const initializeUIFonts = (): void => {
  uiFontStore.initialize();
};
