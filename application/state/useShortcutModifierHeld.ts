import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { parseKeyCombo, type HotkeyScheme } from '../../domain/models/keyBindings';

export type ShortcutModifierEvent = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

export type ShortcutModifierRequirements = Readonly<ShortcutModifierEvent>;

const MODIFIER_TOKENS = {
  mac: {
    '⌘': 'metaKey',
    '⌃': 'ctrlKey',
    '⌥': 'altKey',
    Shift: 'shiftKey',
  },
  pc: {
    Ctrl: 'ctrlKey',
    Alt: 'altKey',
    Shift: 'shiftKey',
    Win: 'metaKey',
  },
} as const;

/**
 * Resolve the modifier combination for the effective [1...9] binding.
 * A non-range or disabled binding cannot reveal tab numbers because the
 * dispatcher does not use it for the number-switch action.
 */
export function getShortcutModifierRequirements(
  keyBinding: string | null,
  scheme: HotkeyScheme,
): ShortcutModifierRequirements | null {
  if (scheme === 'disabled' || !keyBinding || !keyBinding.includes('[1...9]')) return null;
  const parsed = parseKeyCombo(keyBinding);
  if (!parsed || parsed.modifiers.length === 0) return null;

  const requirements: Record<keyof ShortcutModifierEvent, boolean> = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  const tokenMap = MODIFIER_TOKENS[scheme];
  for (const modifier of parsed.modifiers) {
    const flag = tokenMap[modifier as keyof typeof tokenMap];
    if (!flag) return null;
    requirements[flag] = true;
  }

  return requirements;
}

/** Whether a keyboard event has exactly the modifiers required by the binding. */
export function isShortcutModifierHeld(
  event: ShortcutModifierEvent,
  requirements: ShortcutModifierRequirements | null,
): boolean {
  if (!requirements) return false;
  return event.metaKey === requirements.metaKey
    && event.ctrlKey === requirements.ctrlKey
    && event.altKey === requirements.altKey
    && event.shiftKey === requirements.shiftKey;
}

/** Whether a keyup event means the required modifier combination is no longer held. */
export function shouldReleaseShortcutModifier(
  event: ShortcutModifierEvent,
  requirements: ShortcutModifierRequirements | null,
): boolean {
  return !isShortcutModifierHeld(event, requirements);
}

// The held flag lives in a tiny store so only the tab icon slots re-render when
// it flips. It used to be TopTabs state, which re-rendered the whole tab bar
// twice for every Ctrl/⌘ shortcut typed in a terminal (Ctrl+C, ⌘V, ...).
let modifierHeld = false;
const modifierHeldListeners = new Set<() => void>();

function publishModifierHeld(next: boolean): void {
  if (modifierHeld === next) return;
  modifierHeld = next;
  for (const listener of modifierHeldListeners) listener();
}

function subscribeModifierHeld(listener: () => void): () => void {
  modifierHeldListeners.add(listener);
  return () => {
    modifierHeldListeners.delete(listener);
  };
}

const getModifierHeld = () => modifierHeld;

/** Whether the tab-switch modifier combination is currently held. */
export function useShortcutModifierHeldValue(): boolean {
  return useSyncExternalStore(subscribeModifierHeld, getModifierHeld, getModifierHeld);
}

/**
 * Track the modifiers of the effective [1...9] tab-switch binding and publish
 * whether they are held. Pass a null binding to stop tracking.
 */
export function useTrackShortcutModifierHeld(
  keyBinding: string | null,
  scheme: HotkeyScheme,
): void {
  const requirements = useMemo(
    () => getShortcutModifierRequirements(keyBinding, scheme),
    [keyBinding, scheme],
  );

  useEffect(() => {
    publishModifierHeld(false);
    if (!requirements) return;

    // Sync on every modifier transition so extras clear the preview and
    // releasing an extra modifier can re-arm when the exact combo remains.
    const syncHeldState = (event: KeyboardEvent) => {
      publishModifierHeld(isShortcutModifierHeld(event, requirements));
    };
    const clearHeldState = () => publishModifierHeld(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearHeldState();
      }
    };

    window.addEventListener('keydown', syncHeldState, true);
    window.addEventListener('keyup', syncHeldState, true);
    window.addEventListener('blur', clearHeldState);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', syncHeldState, true);
      window.removeEventListener('keyup', syncHeldState, true);
      window.removeEventListener('blur', clearHeldState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      publishModifierHeld(false);
    };
  }, [requirements]);
}
