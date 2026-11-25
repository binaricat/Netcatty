import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransferTask } from './models';
import { getGlobalTransferBatchEligibility, listGloballyPausableTransferIds } from './sftpTransferActions';

test('a partially failed folder pause can be retried or explicitly resumed', () => {
  const task = { id: 'folder', status: 'pausing', isDirectory: true, resumable: true,
    pauseUnavailableReason: 'This transfer cannot be paused yet' } as TransferTask;
  assert.equal(getGlobalTransferBatchEligibility([task]).pausableCount, 1);
  assert.equal(getGlobalTransferBatchEligibility([task]).resumableCount, 1);
  assert.deepEqual(listGloballyPausableTransferIds([task]), ['folder']);
  assert.equal(getGlobalTransferBatchEligibility([{ ...task, pauseUnavailableReason: undefined }]).pausableCount, 0);
});
