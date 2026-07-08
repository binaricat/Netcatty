import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWindowOpacityRecord,
  serializeWindowOpacityRecord,
  shouldApplyWindowOpacityRecord,
  shouldBroadcastWindowOpacityChange,
  type WindowOpacityMutationSource,
  type WindowOpacityRecord,
} from './windowOpacitySync.ts';

/**
 * Minimal model of the settings ↔ main opacity sync loop that caused #2018.
 * Models both IPC rebroadcast and stale localStorage overwrites.
 */
function simulateOpacityDrag(options: {
  shouldBroadcast: (
    source: WindowOpacityMutationSource,
    persistMounted: boolean,
  ) => { shouldBroadcast: boolean; nextSource: WindowOpacityMutationSource };
  shouldApply: (current: WindowOpacityRecord, incoming: WindowOpacityRecord) => boolean;
  versioned: boolean;
}): { settingsValues: number[]; mainValues: number[]; storageWrites: string[] } {
  let settings: WindowOpacityRecord = { opacity: 1, version: 0 };
  let main: WindowOpacityRecord = { opacity: 1, version: 0 };
  let settingsSource: WindowOpacityMutationSource = 'local';
  let mainSource: WindowOpacityMutationSource = 'local';
  let storage = serializeWindowOpacityRecord(settings);
  const settingsValues: number[] = [];
  const mainValues: number[] = [];
  const storageWrites: string[] = [];

  const pendingIpc: Array<{ to: 'settings' | 'main'; record: WindowOpacityRecord }> = [];

  const writeStorage = (record: WindowOpacityRecord) => {
    const next = options.versioned
      ? serializeWindowOpacityRecord(record)
      : String(record.opacity);
    if (next === storage) return;
    storage = next;
    storageWrites.push(next);
    // Cross-window StorageEvent: deliver to the other window.
  };

  const applyLocal = (window: 'settings' | 'main', opacity: number) => {
    const bump = (prev: WindowOpacityRecord): WindowOpacityRecord => (
      options.versioned
        ? { opacity, version: prev.version + 1 }
        : { opacity, version: 0 }
    );

    if (window === 'settings') {
      settingsSource = 'local';
      settings = bump(settings);
      settingsValues.push(settings.opacity);
      writeStorage(settings);
      const decision = options.shouldBroadcast(settingsSource, true);
      settingsSource = decision.nextSource;
      if (decision.shouldBroadcast) pendingIpc.push({ to: 'main', record: { ...settings } });
      return;
    }

    mainSource = 'local';
    main = bump(main);
    mainValues.push(main.opacity);
    writeStorage(main);
    const decision = options.shouldBroadcast(mainSource, true);
    mainSource = decision.nextSource;
    if (decision.shouldBroadcast) pendingIpc.push({ to: 'settings', record: { ...main } });
  };

  const applyIncoming = (window: 'settings' | 'main', record: WindowOpacityRecord) => {
    if (window === 'settings') {
      if (!options.shouldApply(settings, record)) return;
      settingsSource = 'incoming';
      settings = { ...record };
      settingsValues.push(settings.opacity);
      writeStorage(settings);
      const decision = options.shouldBroadcast(settingsSource, true);
      settingsSource = decision.nextSource;
      if (decision.shouldBroadcast) pendingIpc.push({ to: 'main', record: { ...settings } });
      return;
    }

    if (!options.shouldApply(main, record)) return;
    mainSource = 'incoming';
    main = { ...record };
    mainValues.push(main.opacity);
    writeStorage(main);
    const decision = options.shouldBroadcast(mainSource, true);
    mainSource = decision.nextSource;
    if (decision.shouldBroadcast) pendingIpc.push({ to: 'settings', record: { ...main } });
  };

  const flushIpc = () => {
    while (pendingIpc.length > 0) {
      const next = pendingIpc.shift()!;
      applyIncoming(next.to, next.record);
      if (settingsValues.length > 40) break;
    }
  };

  // Replay storage writes onto the peer after each local burst, matching
  // Electron's cross-window StorageEvent delivery.
  const deliverStorageTo = (window: 'settings' | 'main') => {
    const record = options.versioned
      ? parseWindowOpacityRecord(JSON.parse(storage))
      : parseWindowOpacityRecord(storage);
    applyIncoming(window, record);
  };

  applyLocal('settings', 0.5);
  deliverStorageTo('main');
  applyLocal('settings', 0.65);
  // Delayed IPC for the older 0.5 update arrives after 0.65 was already local.
  const delayed = pendingIpc.shift();
  flushIpc();
  if (delayed) applyIncoming(delayed.to, delayed.record);
  deliverStorageTo('settings');
  flushIpc();

  return { settingsValues, mainValues, storageWrites };
}

test('parseWindowOpacityRecord accepts legacy plain numbers and versioned JSON', () => {
  assert.deepEqual(parseWindowOpacityRecord('0.85'), { opacity: 0.85, version: 0 });
  assert.deepEqual(parseWindowOpacityRecord(0.7), { opacity: 0.7, version: 0 });
  assert.deepEqual(
    parseWindowOpacityRecord({ opacity: 0.5, version: 3 }),
    { opacity: 0.5, version: 3 },
  );
  assert.deepEqual(
    parseWindowOpacityRecord('{"opacity":0.55,"version":9}'),
    { opacity: 0.55, version: 9 },
  );
  assert.equal(parseWindowOpacityRecord('bad').opacity, 1);
});

test('shouldApplyWindowOpacityRecord ignores stale revisions', () => {
  const current = { opacity: 0.65, version: 2 };
  assert.equal(shouldApplyWindowOpacityRecord(current, { opacity: 0.5, version: 1 }), false);
  assert.equal(shouldApplyWindowOpacityRecord(current, { opacity: 0.7, version: 3 }), true);
  assert.equal(shouldApplyWindowOpacityRecord(current, { opacity: 0.65, version: 2 }), false);
});

test('shouldBroadcastWindowOpacityChange suppresses incoming rebroadcasts', () => {
  assert.deepEqual(
    shouldBroadcastWindowOpacityChange('incoming', true),
    { shouldBroadcast: false, nextSource: 'local' },
  );
  assert.deepEqual(
    shouldBroadcastWindowOpacityChange('local', true),
    { shouldBroadcast: true, nextSource: 'local' },
  );
  assert.deepEqual(
    shouldBroadcastWindowOpacityChange('local', false),
    { shouldBroadcast: false, nextSource: 'local' },
  );
});

test('legacy unversioned always-broadcast opacity sync oscillates during a fast drag', () => {
  const alwaysBroadcast = (
    _source: WindowOpacityMutationSource,
    persistMounted: boolean,
  ) => ({
    shouldBroadcast: persistMounted,
    nextSource: 'local' as const,
  });
  const alwaysApply = () => true;

  const { settingsValues } = simulateOpacityDrag({
    shouldBroadcast: alwaysBroadcast,
    shouldApply: alwaysApply,
    versioned: false,
  });
  const unique = new Set(settingsValues);
  assert.ok(
    unique.has(0.5) && unique.has(0.65) && settingsValues.length > 2,
    `expected oscillation between 0.5 and 0.65, got ${settingsValues.join(',')}`,
  );
});

test('versioned opacity sync ignores stale peer echoes during a fast drag', () => {
  const { settingsValues, mainValues } = simulateOpacityDrag({
    shouldBroadcast: shouldBroadcastWindowOpacityChange,
    shouldApply: shouldApplyWindowOpacityRecord,
    versioned: true,
  });

  assert.deepEqual(settingsValues, [0.5, 0.65]);
  assert.ok(mainValues.includes(0.65));
  assert.equal(mainValues.includes(0.5) && mainValues[mainValues.length - 1] === 0.5, false);
});

test('serializeWindowOpacityRecord round-trips through parse', () => {
  const raw = serializeWindowOpacityRecord({ opacity: 0.55, version: 9 });
  assert.deepEqual(parseWindowOpacityRecord(JSON.parse(raw)), { opacity: 0.55, version: 9 });
});
