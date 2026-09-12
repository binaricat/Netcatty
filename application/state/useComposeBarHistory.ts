import { useCallback, useLayoutEffect, useRef } from 'react';
import { navigateComposeBarHistory, type ComposeBarHistoryDirection } from '../../domain/composeBarHistory';
import { getComposeBarHistory, createComposeBarHistoryRecorder } from './composeBarHistoryStore';

export function useComposeBarHistory(sessionId: string) {
  const cursor = useRef({ index: Infinity, draft: '' });

  const reset = useCallback(() => {
    cursor.current = { index: Infinity, draft: '' };
  }, []);

  // Keep the existing textarea draft when workspace focus changes, but begin
  // a fresh history walk in the newly focused session.
  useLayoutEffect(reset, [reset, sessionId]);

  const prepareRecord = useCallback(() => createComposeBarHistoryRecorder(sessionId), [sessionId]);

  const navigate = useCallback((currentValue: string, direction: ComposeBarHistoryDirection) => {
    const result = navigateComposeBarHistory({
      entries: getComposeBarHistory(sessionId),
      ...cursor.current,
      currentValue,
    }, direction);
    if (result) cursor.current = result;
    return result?.value;
  }, [sessionId]);

  return { prepareRecord, navigate, reset };
}
