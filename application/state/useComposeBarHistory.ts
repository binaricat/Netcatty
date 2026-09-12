import { useCallback, useLayoutEffect, useRef } from 'react';
import { navigateComposeBarHistory, type ComposeBarHistoryDirection } from '../../domain/composeBarHistory';
import { getComposeBarHistory, createComposeBarHistoryRecorder } from './composeBarHistoryStore';

export function useComposeBarHistory(sessionId: string, restoreDraft?: (draft: string) => void) {
  const cursor = useRef<{ index: number; draft: string; entries?: readonly string[] }>({ index: Infinity, draft: '' });

  const reset = useCallback(() => {
    cursor.current = { index: Infinity, draft: '' };
  }, []);

  // Keep the existing textarea draft when workspace focus changes, but begin
  // a fresh history walk in the newly focused session.
  useLayoutEffect(() => {
    if (cursor.current.entries) restoreDraft?.(cursor.current.draft);
    reset();
  }, [reset, restoreDraft, sessionId]);

  const prepareRecord = useCallback(() => createComposeBarHistoryRecorder(sessionId), [sessionId]);

  const navigate = useCallback((currentValue: string, direction: ComposeBarHistoryDirection) => {
    // A late send can evict old entries. Keep one walk stable until the user
    // returns to the draft or edits, then pick up the latest history.
    const entries = cursor.current.entries ?? getComposeBarHistory(sessionId);
    const result = navigateComposeBarHistory({
      ...cursor.current,
      entries,
      currentValue,
    }, direction);
    if (result) {
      cursor.current = {
        index: result.index === entries.length ? Infinity : result.index,
        draft: result.draft,
        entries: result.index === entries.length ? undefined : entries,
      };
    }
    return result?.value;
  }, [sessionId]);

  return { prepareRecord, navigate, reset };
}
