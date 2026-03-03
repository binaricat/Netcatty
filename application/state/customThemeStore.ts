import { useSyncExternalStore, useCallback } from 'react';
import { TerminalTheme } from '../../domain/models';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { STORAGE_KEY_CUSTOM_THEMES } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

// Access the Electron bridge for cross-window IPC
type NetcattyBridge = {
    notifySettingsChanged?(payload: { key: string; value: unknown }): void;
    onSettingsChanged?(cb: (payload: { key: string; value: unknown }) => void): () => void;
};
const getBridge = (): NetcattyBridge | undefined =>
    (window as unknown as { netcatty?: NetcattyBridge }).netcatty;

/**
 * Custom Theme Store - manages user-created terminal themes
 * Uses useSyncExternalStore pattern (same as fontStore)
 * Persists to localStorage + cross-window IPC sync
 */
type Listener = () => void;

class CustomThemeStore {
    private themes: TerminalTheme[] = [];
    private listeners = new Set<Listener>();
    private loaded = false;
    /** Cached merged array for stable useSyncExternalStore snapshots */
    private cachedAllThemes: TerminalTheme[] | null = null;

    constructor() {
        this.loadFromStorage();
        this.setupCrossWindowSync();
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
        this.cachedAllThemes = null; // invalidate cache
    };

    private saveToStorage = () => {
        try {
            localStorageAdapter.write(STORAGE_KEY_CUSTOM_THEMES, this.themes);
        } catch {
            // storage full or unavailable
        }
    };

    private notify = () => {
        this.cachedAllThemes = null; // invalidate cache on any mutation
        this.listeners.forEach(listener => listener());
    };

    /** Broadcast change to other Electron windows via IPC */
    private broadcastChange = () => {
        try {
            getBridge()?.notifySettingsChanged?.({
                key: STORAGE_KEY_CUSTOM_THEMES,
                value: this.themes,
            });
        } catch {
            // not in Electron or bridge unavailable
        }
    };

    /** Listen for changes from other windows and reload */
    private setupCrossWindowSync = () => {
        try {
            getBridge()?.onSettingsChanged?.((payload) => {
                if (payload.key === STORAGE_KEY_CUSTOM_THEMES) {
                    // Another window changed custom themes — reload from localStorage
                    this.loadFromStorage();
                    this.notify();
                }
            });
        } catch {
            // not in Electron or bridge unavailable
        }
    };

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    // ---- Getters (stable references for useSyncExternalStore) ----

    getCustomThemes = (): TerminalTheme[] => this.themes;

    /** Returns all themes: built-in + custom (cached for snapshot stability) */
    getAllThemes = (): TerminalTheme[] => {
        if (!this.cachedAllThemes) {
            this.cachedAllThemes = [...TERMINAL_THEMES, ...this.themes];
        }
        return this.cachedAllThemes;
    };

    /** Find a theme by ID across both built-in and custom */
    getThemeById = (id: string): TerminalTheme | undefined => {
        return TERMINAL_THEMES.find(t => t.id === id) || this.themes.find(t => t.id === id);
    };

    // ---- Mutations ----

    addTheme = (theme: TerminalTheme) => {
        this.themes = [...this.themes, { ...theme, isCustom: true }];
        this.saveToStorage();
        this.notify();
        this.broadcastChange();
    };

    updateTheme = (id: string, updates: Partial<TerminalTheme>) => {
        this.themes = this.themes.map(t =>
            t.id === id ? { ...t, ...updates, isCustom: true } : t
        );
        this.saveToStorage();
        this.notify();
        this.broadcastChange();
    };

    deleteTheme = (id: string) => {
        this.themes = this.themes.filter(t => t.id !== id);
        this.saveToStorage();
        this.notify();
        this.broadcastChange();
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
