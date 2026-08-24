import {
  type HotkeyScheme,
  type KeyBinding,
  keyStringToKeyboardEvent,
  matchesKeyBinding,
} from './models/keyBindings.ts';

export type ActiveSystemBinding = {
  binding: KeyBinding;
  key: string;
  isMac: boolean;
};

/** App shortcuts that can actually fire for the current scheme. */
export const listActiveSystemBindings = (
  hotkeyScheme: HotkeyScheme,
  keyBindings: readonly KeyBinding[],
): ActiveSystemBinding[] => {
  if (hotkeyScheme === 'disabled') return [];

  return keyBindings.flatMap((binding) => {
    if (hotkeyScheme === 'mac') {
      return binding.mac && binding.mac !== 'Disabled'
        ? [{ binding, key: binding.mac, isMac: true }]
        : [];
    }

    if (hotkeyScheme === 'pc') {
      return binding.pc && binding.pc !== 'Disabled'
        ? [{ binding, key: binding.pc, isMac: false }]
        : [];
    }

    return [];
  });
};

export const findActiveSystemShortcutConflict = (
  key: string,
  hotkeyScheme: HotkeyScheme,
  keyBindings: readonly KeyBinding[],
): KeyBinding | null => {
  if (!key) return null;

  const event = keyStringToKeyboardEvent(key);
  if (!event) return null;

  const conflict = listActiveSystemBindings(hotkeyScheme, keyBindings).find((entry) => (
    matchesKeyBinding(event, entry.key, entry.isMac)
  ));
  return conflict?.binding ?? null;
};
