import assert from 'node:assert/strict';
import test from 'node:test';

import { hasMarkdownCodeFence } from './hasMarkdownCodeFence';

test('detects common markdown fences', () => {
  assert.equal(hasMarkdownCodeFence('hello'), false);
  assert.equal(hasMarkdownCodeFence('use `code` inline'), false);
  assert.equal(hasMarkdownCodeFence('```ts\nconst a = 1\n```'), true);
  assert.equal(hasMarkdownCodeFence('prefix\n```\nplain\n```'), true);
  assert.equal(hasMarkdownCodeFence('~~~\nbash\n~~~'), true);
  assert.equal(hasMarkdownCodeFence('   ```json\n{}\n```'), true);
});
