import test from 'node:test';
import assert from 'node:assert/strict';
import { EncryptionService } from '../EncryptionService';
import { unlockImpl } from './stateAndSecurityMethods';

for (const scenario of ['rotated-valid-password', 'rotated-invalid-old-password', 'locked-during-unlock'] as const) {
  test(`unlock rejects a superseded request instead of reporting a bad password: ${scenario}`, async () => {
    const oldConfig = await EncryptionService.createMasterKeyConfig('old-fixture-password');
    const newConfig = await EncryptionService.createMasterKeyConfig('new-fixture-password');
    let generation = 0;
    const manager = {
      state: { masterKeyConfig: oldConfig, securityState: 'LOCKED', unlockedKey: null },
      getSyncSecurityGeneration: () => generation,
    };
    const pending = unlockImpl.call(manager,
      scenario === 'rotated-invalid-old-password' ? 'new-fixture-password' : 'old-fixture-password');
    if (scenario !== 'locked-during-unlock') manager.state.masterKeyConfig = newConfig;
    generation += 1;
    await assert.rejects(pending, /changed while unlocking/i);
    assert.equal(manager.state.securityState, 'LOCKED');
    assert.equal(manager.state.unlockedKey, null);
  });
}

test('a wrong password for the current configuration remains an ordinary verification failure', async () => {
  const config = await EncryptionService.createMasterKeyConfig('correct-fixture-password');
  const manager = { state: { masterKeyConfig: config, securityState: 'LOCKED', unlockedKey: null } };
  assert.equal(await unlockImpl.call(manager, 'wrong-fixture-password'), false);
  assert.equal(manager.state.unlockedKey, null);
});
