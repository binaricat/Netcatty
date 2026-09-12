import test from 'node:test';
import assert from 'node:assert/strict';

import { isAutoLaunchResultTrustworthy } from './systemSettingsEffects.ts';

test('isAutoLaunchResultTrustworthy trusts a successful read/write result', () => {
  assert.equal(isAutoLaunchResultTrustworthy({ success: true }), true);
});

test('isAutoLaunchResultTrustworthy rejects a transient failure result', () => {
  assert.equal(
    isAutoLaunchResultTrustworthy({ success: false }),
    false,
    'success:false means the OS state is unknown, not confirmed disabled',
  );
});

test('isAutoLaunchResultTrustworthy defaults to trusting a result with no success field', () => {
  // Defensive default for any future/alternate caller that omits the field
  // entirely — only an explicit false should withhold trust.
  assert.equal(isAutoLaunchResultTrustworthy({}), true);
});

/**
 * Minimal model of the hydration effect's decision: given a getAutoLaunch()
 * result, should it overwrite the cached autoLaunchEnabled value? This is
 * the exact regression scenario from the review — a transient read failure
 * must not overwrite a cached `true` with a "successful-looking" `false`,
 * which would otherwise cascade into an unwanted disable write via the
 * adjacent push effect.
 */
function simulateHydration(cachedEnabled: boolean, result: { success: boolean; enabled: boolean }): boolean {
  if (!isAutoLaunchResultTrustworthy(result)) return cachedEnabled;
  return result.enabled;
}

test('a transient read failure during hydration keeps the cached enabled value', () => {
  const next = simulateHydration(true, { success: false, enabled: false });
  assert.equal(next, true, 'must not silently flip a cached true to false on an unrelated read failure');
});

test('a successful read during hydration applies the real OS state, even when it flips the cache', () => {
  const next = simulateHydration(true, { success: true, enabled: false });
  assert.equal(next, false, 'a confirmed read must still win over a stale cache');
});

/**
 * Model of the actual hook: a mount-time hydration request and a
 * user-triggered write can race. This mirrors the real ordering the review
 * flagged — hydration starts, the user toggles before it resolves (which
 * starts a real write), then the stale hydration response arrives.
 */
function simulateMountToggleRace(
  initialCachedEnabled: boolean,
  userToggleTo: boolean,
  staleHydrationResult: { success: boolean; enabled: boolean },
): boolean {
  let state = initialCachedEnabled;
  let writeStarted = false;

  // Hydration request is issued here (pending) — resolution happens later.

  // The user toggles before hydration resolves; this is what the real push
  // effect does: apply optimistically and flag that a real write started.
  state = userToggleTo;
  writeStarted = true;

  // The stale hydration response now arrives.
  if (!writeStarted && isAutoLaunchResultTrustworthy(staleHydrationResult)) {
    state = staleHydrationResult.enabled;
  }

  return state;
}

test('a user toggle during in-flight hydration is not clobbered by the stale hydration response', () => {
  const result = simulateMountToggleRace(false, true, { success: true, enabled: false });

  assert.equal(
    result,
    true,
    'the stale response (enabled:false, read before the user toggled) must not overwrite the user\'s fresh true — ' +
      'otherwise the adjacent push effect reacts to the overwrite and disables an item the user just enabled',
  );
});

test('a user toggle to false during in-flight hydration is not clobbered by a stale enabled:true response', () => {
  const result = simulateMountToggleRace(true, false, { success: true, enabled: true });

  assert.equal(result, false, 'symmetric case: disabling must also win over a stale hydration response');
});

test('hydration still applies normally when it resolves before any write starts', () => {
  // No race: writeStarted stays false throughout, so trustworthy hydration
  // results must still be applied — the guard must not disable hydration
  // unconditionally, only once a real write has actually begun.
  let state = false;
  let writeStarted = false;
  const result = { success: true, enabled: true };

  if (!writeStarted && isAutoLaunchResultTrustworthy(result)) {
    state = result.enabled;
  }

  assert.equal(state, true);
  void writeStarted;
});

/**
 * Model of the push effect's own overlap guard: rapid double (or triple)
 * toggles start multiple bridge.setAutoLaunch(...) calls that can resolve
 * out of order. Each response is only reconciled into state if no newer
 * request has started since — this is the exact scenario the review
 * flagged: "each callback closes over its render's autoLaunchEnabled value
 * ... without checking whether a newer request exists".
 */
class AutoLaunchWriteSimulator {
  state: boolean;
  private generation = 0;

  constructor(initial: boolean) {
    this.state = initial;
  }

  /** Simulates the user toggling the switch, starting a new write. */
  startWrite(requestedValue: boolean): { requestGeneration: number; requestedValue: boolean } {
    this.state = requestedValue;
    this.generation += 1;
    return { requestGeneration: this.generation, requestedValue };
  }

  /** Simulates that write's bridge.setAutoLaunch(...) response arriving. */
  resolveWrite(request: { requestGeneration: number; requestedValue: boolean }, result: { success: boolean; enabled: boolean }) {
    if (this.generation !== request.requestGeneration) return; // superseded — ignore
    if (!isAutoLaunchResultTrustworthy(result)) return;
    if (result.enabled !== request.requestedValue) this.state = result.enabled;
  }
}

test('a stale write response is ignored once a newer request has started', () => {
  const sim = new AutoLaunchWriteSimulator(false);

  const first = sim.startWrite(true); // user enables
  const second = sim.startWrite(false); // user immediately disables again, before `first` resolves
  assert.equal(sim.state, false, 'the latest toggle is reflected optimistically right away');

  // `first`'s response arrives late, reporting a mismatch against ITS OWN
  // request (e.g. macOS pending approval reported enabled:false for a
  // requested true) — without the generation guard this would incorrectly
  // "correct" state to false right as `second` is still in flight, and
  // with a mismatch reported the OTHER way it could just as easily stomp
  // a subsequent true.
  sim.resolveWrite(first, { success: true, enabled: false });
  assert.equal(sim.state, false, 'the stale response for the superseded first request must not touch state');

  // `second`'s own (current) response arrives and is applied normally.
  sim.resolveWrite(second, { success: true, enabled: false });
  assert.equal(sim.state, false);
});

test('a stale write response would have incorrectly overridden a later successful write, without the guard', () => {
  const sim = new AutoLaunchWriteSimulator(false);

  const first = sim.startWrite(true); // request enable — this one will report a mismatch
  const second = sim.startWrite(true); // user toggles off and back on again quickly; also requests true
  assert.equal(sim.state, true);

  // second's response arrives first (network/OS timing is not ordered) and
  // confirms the real, current state.
  sim.resolveWrite(second, { success: true, enabled: true });
  assert.equal(sim.state, true);

  // first's stale response finally arrives, reporting a mismatch (its own
  // request was true but the OS said false at the time) — must not undo
  // the now-confirmed true state from the newer request.
  sim.resolveWrite(first, { success: true, enabled: false });
  assert.equal(
    sim.state,
    true,
    'a delayed response from a superseded request must not overwrite the newer, already-confirmed state',
  );
});

test('the only in-flight write still reconciles a genuine mismatch normally', () => {
  const sim = new AutoLaunchWriteSimulator(false);

  const only = sim.startWrite(true);
  sim.resolveWrite(only, { success: true, enabled: false }); // e.g. blocked by Windows Startup Apps

  assert.equal(sim.state, false, 'with no overlap, a real mismatch must still correct the optimistic toggle');
});
