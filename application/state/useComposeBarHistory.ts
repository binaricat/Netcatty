import { useCallback, useRef } from 'react';
import { navigateComposeBarHistory, type ComposeBarHistoryDirection } from '../../domain/composeBarHistory';
import { getComposeBarHistory, recordComposeBarHistory } from './composeBarHistoryStore';

export function useComposeBarHistory(sessionId: string) {
  const cursor = useRef({ index: Infinity, draft: '' });

  const reset = useCallback(() => {
    cursor.current = { index: Infinity, draft: '' };
  }, []);

  const record = useCallback((text: string) => {
    recordComposeBarHistory(sessionId, text);
    reset();
  }, [reset, sessionId]);

  const navigate = useCallback((currentValue: string, direction: ComposeBarHistoryDirection) => {
    const result = navigateComposeBarHistory({
      entries: getComposeBarHistory(sessionId),
      ...cursor.current,
      currentValue,
    }, direction);
    if (result) cursor.current = result;
    return result?.value;
  }, [sessionId]);

  return { record, navigate, reset };
}
