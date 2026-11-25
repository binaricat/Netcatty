import { useCallback } from 'react';
import { STORAGE_KEY_COMPOSE_BAR_HEIGHT } from '../../infrastructure/config/storageKeys';
import { useStoredNumber } from './useStoredNumber';

export const COMPOSE_BAR_HEIGHT_DEFAULT = 120;
export const COMPOSE_BAR_HEIGHT_MIN = 72;
export const COMPOSE_BAR_HEIGHT_MAX = 360;

const HEIGHT_CLAMP = { min: COMPOSE_BAR_HEIGHT_MIN, max: COMPOSE_BAR_HEIGHT_MAX };

function clampHeight(height: number): number {
  return Math.max(HEIGHT_CLAMP.min, Math.min(HEIGHT_CLAMP.max, height));
}

/** Persisted compose bar height; call `persist` on mouseup after a drag. */
export function useComposeBarHeight() {
  const [height, setHeight, persist] = useStoredNumber(
    STORAGE_KEY_COMPOSE_BAR_HEIGHT,
    COMPOSE_BAR_HEIGHT_DEFAULT,
    HEIGHT_CLAMP,
  );

  const setClampedHeight = useCallback(
    (next: number | ((prev: number) => number)) => {
      setHeight((prev) => {
        const raw = typeof next === 'function' ? next(prev) : next;
        return clampHeight(raw);
      });
    },
    [setHeight],
  );

  return [height, setClampedHeight, persist] as const;
}
