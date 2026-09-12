import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rememberComposerRecentModel,
  subscribeComposerModelPrefs,
} from './composerModelPrefs';

test('subscribeComposerModelPrefs notifies every listener after a write', () => {
  let hits = 0;
  const unsubscribe = subscribeComposerModelPrefs(() => {
    hits += 1;
  });
  rememberComposerRecentModel('catty', { modelId: 'gpt-5.5' });
  assert.equal(hits, 1);
  unsubscribe();
  rememberComposerRecentModel('catty', { modelId: 'gpt-5.4' });
  assert.equal(hits, 1);
});
