import { useSyncExternalStore, useCallback } from 'react';
import { TerminalTheme } from '../../domain/models';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { STORAGE_KEY_CUSTOM_THEMES } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

/**
 * Custom Theme Store - manages user-created terminal themes
 * Uses useSyncExternalStore pattern (same as fontStore)
 * Persists to localStorage
 */
type Listener = () => void;

class CustomThemeStore {
    private themes: TerminalTheme[] = [];
    private listeners = new Set<Listener>();
    private loaded = false;

    constructor() {
        this.loadFromStorage();
    }

    private loadFromStorage = () => {
        try {
            const parsed = localStorageAdapter.read<TerminalTheme[]>(STORAGE_KEY_CUSTOM_THEMES);
            if (Array.isArray(parsed)) {
                this.themes = parsed.map((t: TerminalTheme) => ({ ...t, isCustom: true }));
            }
        } catch {
            // ignore corrupt data
        }
        this.loaded = true;
    };

    private saveToStorage = () => {
        try {
            localStorageAdapter.write(STORAGE_KEY_CUSTOM_THEMES, this.themes);
        } catch {
            // storage full or unavailable
        }
    };

    private notify = () => {
        this.listeners.forEach(listener => listener());
    };

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    // ---- Getters ----

    getCustomThemes = (): TerminalTheme[] => this.themes;

    /** Returns all themes: built-in + custom */
    getAllThemes = (): TerminalTheme[] => [...TERMINAL_THEMES, ...this.themes];

    /** Find a theme by ID across both built-in and custom */
    getThemeById = (id: string): TerminalTheme | undefined => {
        return TERMINAL_THEMES.find(t => t.id === id) || this.themes.find(t => t.id === id);
    };

    // ---- Mutations ----

    addTheme = (theme: TerminalTheme) => {
        this.themes = [...this.themes, { ...theme, isCustom: true }];
        this.saveToStorage();
        this.notify();
    };

    updateTheme = (id: string, updates: Partial<TerminalTheme>) => {
        this.themes = this.themes.map(t =>
            t.id === id ? { ...t, ...updates, isCustom: true } : t
        );
        this.saveToStorage();
        this.notify();
    };

    deleteTheme = (id: string) => {
        this.themes = this.themes.filter(t => t.id !== id);
        this.saveToStorage();
        this.notify();
    };
}

// Singleton
export const customThemeStore = new CustomThemeStore();

// ============== Hooks ==============

/** Get all themes (built-in + custom) */
export const useAllThemes = (): TerminalTheme[] => {
    return useSyncExternalStore(
        customThemeStore.subscribe,
        customThemeStore.getAllThemes
    );
};

/** Get custom themes only */
export const useCustomThemes = (): TerminalTheme[] => {
    return useSyncExternalStore(
        customThemeStore.subscribe,
        customThemeStore.getCustomThemes
    );
};

/** Get theme by ID (built-in or custom) with fallback */
export const useThemeById = (id: string): TerminalTheme => {
    const allThemes = useAllThemes();
    return allThemes.find(t => t.id === id) || TERMINAL_THEMES[0];
};

/** Theme mutation actions */
export const useCustomThemeActions = () => {
    const addTheme = useCallback((theme: TerminalTheme) => {
        customThemeStore.addTheme(theme);
    }, []);

    const updateTheme = useCallback((id: string, updates: Partial<TerminalTheme>) => {
        customThemeStore.updateTheme(id, updates);
    }, []);

    const deleteTheme = useCallback((id: string) => {
        customThemeStore.deleteTheme(id);
    }, []);

    return { addTheme, updateTheme, deleteTheme };
};
