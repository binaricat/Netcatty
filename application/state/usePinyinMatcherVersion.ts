import { useSyncExternalStore } from 'react';
import {
  getPinyinMatcherVersion,
  subscribePinyinMatcherReady,
} from '../../domain/searchMatcher';

/**
 * Subscribes a React component to lazy `pinyin-pro` dictionary load completion
 * so active CJK search memos re-evaluate immediately once ready.
 */
export function usePinyinMatcherVersion(): number {
  return useSyncExternalStore(
    subscribePinyinMatcherReady,
    getPinyinMatcherVersion,
    getPinyinMatcherVersion,
  );
}
