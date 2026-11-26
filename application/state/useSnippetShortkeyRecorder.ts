import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { I18nContextValue } from '../i18n/I18nProvider';
import { findActiveSystemShortcutConflict } from '../../domain/activeKeyBindings';
import {
  type HotkeyScheme,
  type KeyBinding,
  type Snippet,
  keyEventToString,
  keyStringToKeyboardEvent,
  matchesKeyBinding,
} from '../../domain/models';
import { isAppLockOverlayActive } from '../../infrastructure/appLockOverlayDom';
import { isMacPlatform } from '../../lib/utils';

const normalizeKeyString = (value: string): string => (
  value.toLowerCase().replace(/\s+/g, '')
);

export interface UseSnippetShortkeyRecorderOptions {
  snippets: Snippet[];
  editingSnippetId?: string;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  t: I18nContextValue['t'];
  onCapture: (shortkey: string) => void;
}

export function useSnippetShortkeyRecorder({
  snippets,
  editingSnippetId,
  hotkeyScheme,
  keyBindings,
  t,
  onCapture,
}: UseSnippetShortkeyRecorderOptions) {
  const [isRecordingShortkey, setIsRecordingShortkey] = useState(false);
  const [shortkeyError, setShortkeyError] = useState<string | null>(null);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  const isMac = useMemo(() => (
    hotkeyScheme === 'mac' || (hotkeyScheme === 'disabled' && isMacPlatform())
  ), [hotkeyScheme]);

  const existingShortkeys = useMemo(() => (
    snippets.filter((snippet) => Boolean(snippet.shortkey) && snippet.id !== editingSnippetId)
  ), [snippets, editingSnippetId]);

  const validateShortkey = useCallback((key: string): string | null => {
    if (!key) return null;

    const systemConflict = findActiveSystemShortcutConflict(key, hotkeyScheme, keyBindings);
    if (systemConflict) {
      const nameKey = `settings.shortcuts.binding.${systemConflict.id}`;
      const name = t(nameKey) !== nameKey ? t(nameKey) : systemConflict.label;
      return t('snippets.shortkey.error.systemConflict', { name });
    }

    const syntheticEvent = keyStringToKeyboardEvent(key);
    if (syntheticEvent) {
      for (const snippet of existingShortkeys) {
        if (snippet.shortkey && matchesKeyBinding(syntheticEvent, snippet.shortkey, isMac)) {
          return t('snippets.shortkey.error.snippetConflict', { name: snippet.label });
        }
      }
    } else {
      const normalizedKey = normalizeKeyString(key);
      const conflictingSnippet = existingShortkeys.find((snippet) => (
        snippet.shortkey && normalizeKeyString(snippet.shortkey) === normalizedKey
      ));
      if (conflictingSnippet) {
        return t('snippets.shortkey.error.snippetConflict', { name: conflictingSnippet.label });
      }
    }

    return null;
  }, [existingShortkeys, hotkeyScheme, isMac, keyBindings, t]);

  useEffect(() => {
    if (!isRecordingShortkey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // App lock overlay installs later; skip while locked so password keys
      // never mutate shortkeys (Codex P2).
      if (isAppLockOverlayActive()) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setIsRecordingShortkey(false);
        setShortkeyError(null);
        return;
      }

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      const keyString = keyEventToString(e, isMac);
      const error = validateShortkey(keyString);
      if (error) {
        setShortkeyError(error);
        return;
      }

      setShortkeyError(null);
      onCaptureRef.current(keyString);
      setIsRecordingShortkey(false);
    };

    const handleClick = () => {
      setIsRecordingShortkey(false);
      setShortkeyError(null);
    };

    const timer = setTimeout(() => {
      window.addEventListener('click', handleClick, true);
    }, 100);

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, [isRecordingShortkey, isMac, validateShortkey]);

  return {
    isRecordingShortkey,
    setIsRecordingShortkey,
    shortkeyError,
    setShortkeyError,
    validateShortkey,
  };
}
