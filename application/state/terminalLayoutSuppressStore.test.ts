import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalLayoutSuppressStore } from './terminalLayoutSuppressStore';

test('terminalLayoutSuppressStore tracks nested begin/end', () => {
  assert.equal(terminalLayoutSuppressStore.getActive(), false);
  terminalLayoutSuppressStore.begin();
  assert.equal(terminalLayoutSuppressStore.getActive(), true);
  terminalLayoutSuppressStore.begin();
  assert.equal(terminalLayoutSuppressStore.getActive(), true);
  terminalLayoutSuppressStore.end();
  assert.equal(terminalLayoutSuppressStore.getActive(), true);
  terminalLayoutSuppressStore.end();
  assert.equal(terminalLayoutSuppressStore.getActive(), false);
});

test('terminalLayoutSuppressStore defers subscriber notifications', async () => {
  let notifyCount = 0;
  const unsubscribe = terminalLayoutSuppressStore.subscribe(() => {
    notifyCount += 1;
  });

  terminalLayoutSuppressStore.begin();
  assert.equal(notifyCount, 0, 'begin should not notify synchronously');
  assert.equal(terminalLayoutSuppressStore.getActive(), true);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(notifyCount, 1, 'begin should notify after the current turn');

  terminalLayoutSuppressStore.end();
  assert.equal(notifyCount, 1, 'end should not notify synchronously');
  assert.equal(terminalLayoutSuppressStore.getActive(), false);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(notifyCount, 2, 'end should notify after the current turn');

  unsubscribe();
});
