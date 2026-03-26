import { useCallback, useState } from "react";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

/**
 * Hook for reading a number from localStorage with lazy persistence.
 * Unlike useStoredString/useStoredBoolean, this hook does NOT auto-persist
 * on every state change — call `persist()` explicitly when ready (e.g. on
 * mouseup after a drag). This avoids flooding localStorage during
 * high-frequency updates like resize drags.
 */
export const useStoredNumber = (
    storageKey: string,
    fallback: number,
    clamp?: { min: number; max: number },
) => {
    const [value, setValue] = useState<number>(() => {
        const stored = localStorageAdapter.readNumber(storageKey);
        if (stored === null) return fallback;
        if (clamp) return Math.max(clamp.min, Math.min(clamp.max, stored));
        return stored;
    });

    const persist = useCallback(
        (v: number) => localStorageAdapter.writeNumber(storageKey, v),
        [storageKey],
    );

    return [value, setValue, persist] as const;
};
