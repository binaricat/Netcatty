import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const appSideEffectsSource = readFileSync(
  new URL('./AppSideEffects.tsx', import.meta.url),
  'utf8',
);
const indexSource = readFileSync(new URL('../../index.tsx', import.meta.url), 'utf8');
const startupEffectsSource = readFileSync(
  new URL('./useAppStartupEffects.ts', import.meta.url),
  'utf8',
);
const updateCheckSource = readFileSync(
  new URL('../state/useUpdateCheck.ts', import.meta.url),
  'utf8',
);
const portForwardingAutoStartSource = readFileSync(
  new URL('../state/usePortForwardingAutoStart.ts', import.meta.url),
  'utf8',
);
const appLockBridgeSource = readFileSync(
  new URL('../state/useAppLockBridge.ts', import.meta.url),
  'utf8',
);

test('every renderer root mounts under StrictMode', () => {
  assert.match(indexSource, /import \{ StrictMode, Suspense, lazy \} from 'react'/);

  const renderCalls = indexSource.match(/root\.render\(/g) ?? [];
  assert.equal(renderCalls.length, 4, 'main, settings, tray and terminal-popup roots');

  let cursor = 0;
  for (let index = 0; index < renderCalls.length; index += 1) {
    const renderAt = indexSource.indexOf('root.render(', cursor);
    assert.notEqual(renderAt, -1);
    const opener = indexSource.slice(renderAt, renderAt + 60);
    assert.match(opener, /root\.render\(\s*<StrictMode>/, `root.render #${index + 1} lacks StrictMode`);
    cursor = renderAt + 'root.render('.length;
  }
});

test('clone-session payload is consumed once even if the effect re-runs', () => {
  const effectStart = appSideEffectsSource.indexOf('consumedNewWindowSessionRef');
  assert.notEqual(effectStart, -1, 'clone-session effect must latch on payload identity');
  const effectEnd = appSideEffectsSource.indexOf(
    '}, [createSessionFromCloneSource, isVaultInitialized, pendingNewWindowSession]);',
    effectStart,
  );
  assert.notEqual(effectEnd, -1);
  const body = appSideEffectsSource.slice(effectStart, effectEnd);

  // A ref comparison is required: clearing the state only lands on the next
  // render, so a re-invoked effect still closes over the same payload.
  assert.match(body, /if \(consumedNewWindowSessionRef\.current === pendingNewWindowSession\) return;/);
  assert.ok(
    body.indexOf('consumedNewWindowSessionRef.current = pending')
      < body.indexOf('createSessionFromCloneSource(pending.sourceSession'),
    'payload must be marked consumed before the clone is created',
  );
});

test('rendererReady is notified once per renderer process', () => {
  assert.match(appLockBridgeSource, /^let rendererReadySent = false;$/m);
  const guardAt = appLockBridgeSource.indexOf('if (rendererReadySent) return;');
  assert.notEqual(guardAt, -1);
  const guarded = appLockBridgeSource.slice(guardAt, guardAt + 200);
  assert.match(guarded, /rendererReadySent = true;/);
  assert.match(guarded, /netcattyBridge\.get\(\)\?\.rendererReady\?\.\(\)/);
  assert.ok(
    guarded.indexOf('rendererReadySent = true;')
      < guarded.indexOf('netcattyBridge.get()?.rendererReady?.()'),
    'the latch must be set before the IPC call so a re-entrant effect is blocked',
  );
});

test('update-available toast latches on the release version', () => {
  const latchAt = startupEffectsSource.indexOf('toastedUpdateVersionRef');
  assert.notEqual(latchAt, -1);
  assert.match(startupEffectsSource, /const toastedUpdateVersionRef = useRef<string \| null>\(null\)/);
  assert.match(startupEffectsSource, /if \(toastedUpdateVersionRef\.current === version\) return;/);

  const guardAt = startupEffectsSource.indexOf('if (toastedUpdateVersionRef.current === version) return;');
  const toastAt = startupEffectsSource.indexOf('toast.info(', guardAt);
  assert.notEqual(toastAt, -1);
  assert.ok(guardAt < toastAt, 'the version latch must gate the toast call');
});

test('port-forward auto-start runs once across a StrictMode double effect', () => {
  assert.match(
    portForwardingAutoStartSource,
    /const autoStartExecutedRef = useRef\(false\);/,
    'the launch auto-start needs a module-render latch, not just an effect dep list',
  );

  const effectStart = portForwardingAutoStartSource.indexOf('if (autoStartExecutedRef.current) return;');
  assert.notEqual(effectStart, -1, 'the effect must bail out when the latch is already set');
  const effectEnd = portForwardingAutoStartSource.indexOf(
    '}, [\n    enabled,\n    isVaultInitialized,\n    runAutoStart,\n  ]);',
    effectStart,
  );
  assert.notEqual(effectEnd, -1, 'auto-start effect dep list moved; update this contract');
  const body = portForwardingAutoStartSource.slice(effectStart, effectEnd);

  // StrictMode invokes the effect twice with the same render's closure, so the
  // latch has to be written before the async run is kicked off — awaiting or
  // deferring the write would let the second invoke start a duplicate tunnel.
  const latchAt = body.indexOf('autoStartExecutedRef.current = true;');
  const runAt = body.indexOf('void runAutoStart();');
  assert.notEqual(latchAt, -1);
  assert.notEqual(runAt, -1);
  assert.ok(latchAt < runAt, 'the latch must be set before runAutoStart() is called');

  // The vault gate must also sit before the latch: latching on a pre-hydration
  // invoke would permanently suppress the real auto-start.
  assert.ok(
    body.indexOf('if (!isVaultInitialized) return;') < latchAt,
    'the vault gate must precede the latch write',
  );
});

test('cancelled startup update check resets its latch instead of skipping forever', () => {
  const scheduleAt = updateCheckSource.indexOf('let checkArmed = true;');
  assert.notEqual(scheduleAt, -1);
  const tail = updateCheckSource.slice(scheduleAt);

  // The latch is only meaningful once the timer actually fires; a cleanup that
  // cancels it beforehand must let the next effect schedule again.
  assert.match(tail, /startupCheckTimeoutRef\.current = setTimeout\(async \(\) => \{\s*\n\s*checkArmed = false;/);
  assert.match(tail, /if \(checkArmed\) \{\s*\n\s*hasCheckedOnStartupRef\.current = false;\s*\n\s*\}/);
});

test('terminal popup config survives StrictMode unsubscribe/resubscribe', () => {
  const preloadSource = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
  const apiSource = readFileSync(new URL('../../electron/preload/api.cjs', import.meta.url), 'utf8');

  assert.match(preloadSource, /lastPayload:\s*null/);
  assert.match(
    preloadSource,
    /terminalPopupConfigState\.lastPayload = payload/,
    'incoming popup config must be retained beyond the one-shot pending slot',
  );

  const subscribeAt = apiSource.indexOf('onTerminalPopupConfig:');
  assert.notEqual(subscribeAt, -1);
  const subscribe = apiSource.slice(subscribeAt, subscribeAt + 700);
  assert.match(
    subscribe,
    /terminalPopupConfigState\.pending \?\? terminalPopupConfigState\.lastPayload/,
    'resubscribe must replay lastPayload after pending was drained',
  );
  assert.match(subscribe, /terminalPopupConfigState\.pending = null/);
  assert.doesNotMatch(
    subscribe,
    /terminalPopupConfigState\.lastPayload = null/,
    'StrictMode remount must not clear lastPayload on subscribe',
  );
});

test('vault init cancels the superseded StrictMode effect before publishing ready', () => {
  const vaultSource = readFileSync(
    new URL('../state/useVaultState.ts', import.meta.url),
    'utf8',
  );
  const initAt = vaultSource.indexOf('let cancelled = false;');
  assert.notEqual(initAt, -1, 'vault init must track cancellation');
  const initSlice = vaultSource.slice(initAt, initAt + 12000);
  assert.match(initSlice, /return \(\) => \{\s*\n\s*cancelled = true;\s*\n\s*\};/);
  assert.match(
    initSlice,
    /if \(!cancelled\) \{\s*\n\s*setIsInitialized\(true\);\s*\n\s*setVaultInitialized\(true\);\s*\n\s*\}/,
    'only the surviving init may mark the vault ready',
  );
  assert.match(initSlice, /if \(cancelled\) return;/);
});

test('global hotkey registration cleans up across StrictMode remount', () => {
  const systemEffectsSource = readFileSync(
    new URL('../state/systemSettingsEffects.ts', import.meta.url),
    'utf8',
  );
  const hotkeyAt = systemEffectsSource.indexOf('Persist and sync toggle window hotkey setting');
  assert.notEqual(hotkeyAt, -1);
  const hotkeyEffect = systemEffectsSource.slice(hotkeyAt, hotkeyAt + 2200);
  assert.match(hotkeyEffect, /let cancelled = false;/);
  assert.match(hotkeyEffect, /if \(cancelled\) return;/);
  assert.match(
    hotkeyEffect,
    /if \(didRegister\) \{\s*\n\s*bridge\?\.unregisterGlobalHotkey/,
    'cleanup must unregister a registration started by this effect',
  );
  // Early return before notify must not skip returning the cleanup function.
  assert.doesNotMatch(
    hotkeyEffect,
    /if \(!persistMountedRef\.current\) return;\s*\n\s*notifySettingsChanged/,
  );
});

test('settings persistMountedRef resets on StrictMode cleanup', () => {
  const settingsSource = readFileSync(
    new URL('../state/useSettingsState.ts', import.meta.url),
    'utf8',
  );
  const markAt = settingsSource.indexOf('Mark persist effects mounted AFTER all persist useEffects');
  assert.notEqual(markAt, -1);
  const markEffect = settingsSource.slice(markAt, markAt + 500);
  assert.match(markEffect, /persistMountedRef\.current = true;/);
  assert.match(
    markEffect,
    /return \(\) => \{\s*\n\s*persistMountedRef\.current = false;\s*\n\s*\};/,
    'remount must treat boot as a fresh mount, not a settings change',
  );
});

test('tray panel connect flush latches against StrictMode double invoke', () => {
  const sideEffectsSource = readFileSync(
    new URL('./AppSideEffects.tsx', import.meta.url),
    'utf8',
  );
  assert.match(sideEffectsSource, /pendingTrayConnectFlushKeyRef/);
  assert.match(
    sideEffectsSource,
    /if \(pendingTrayConnectFlushKeyRef\.current === flushKey\) return;/,
  );
});

test('ssh transport idle TTL notify latches against StrictMode double invoke', () => {
  const settingsSource = readFileSync(
    new URL('../state/useSettingsState.ts', import.meta.url),
    'utf8',
  );
  assert.match(settingsSource, /lastPushedSshTransportIdleTtlRef/);
  assert.match(
    settingsSource,
    /if \(lastPushedSshTransportIdleTtlRef\.current === sshTransportIdleTtlMs\) return;/,
  );
  assert.match(
    settingsSource,
    /lastPushedSshTransportIdleTtlRef\.current = sshTransportIdleTtlMs;/,
  );
});

test('terminal selection Ask-AI payload is consumed once under StrictMode', () => {
  const hostSource = readFileSync(
    new URL('../../components/terminalLayer/TerminalLayerSupport.tsx', import.meta.url),
    'utf8',
  );
  assert.match(hostSource, /consumedTerminalSelectionRequestIds/);
  assert.doesNotMatch(
    hostSource,
    /consumedTerminalSelectionRequestIdRef/,
    'component refs reset on StrictMode remount; use a module Set',
  );
  assert.match(
    hostSource,
    /if \(consumedTerminalSelectionRequestIds\.has\(pendingTerminalSelection\.requestId\)\)/,
  );
  const latchAt = hostSource.indexOf('markTerminalSelectionRequestConsumed(pendingTerminalSelection.requestId)');
  const draftAt = hostSource.indexOf('updateDraft(scopeKey, defaultAgentId');
  assert.ok(latchAt > 0 && draftAt > latchAt, 'must latch before mutating the draft');
});

test('Codex App Server interaction bridge is app-singleton like MCP approvals', () => {
  assert.match(appSource, /setupCodexAppServerInteractionBridge/);
  const panelSource = readFileSync(
    new URL('../../components/AIChatSidePanel.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    panelSource,
    /setupCodexAppServerInteractionBridge/,
    'per-panel Codex IPC listeners fan out approvals under retained multi-tab mounts',
  );
});
