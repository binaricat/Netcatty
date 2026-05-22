import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type MediaQueryListLike,
  watchDevicePixelRatio,
} from "./rendererDprWatch";

class FakeMediaQueryList implements MediaQueryListLike {
  readonly query: string;
  modernListeners: Array<() => void> = [];
  legacyListeners: Array<() => void> = [];
  private readonly supportsModern: boolean;

  constructor(query: string, supportsModern = true) {
    this.query = query;
    this.supportsModern = supportsModern;
    if (!supportsModern) {
      // Strip the modern API to emulate legacy environments.
      this.addEventListener = undefined;
      this.removeEventListener = undefined;
    }
  }

  addEventListener? = (_type: "change", listener: () => void) => {
    this.modernListeners.push(listener);
  };

  removeEventListener? = (_type: "change", listener: () => void) => {
    this.modernListeners = this.modernListeners.filter((l) => l !== listener);
  };

  addListener = (listener: () => void) => {
    this.legacyListeners.push(listener);
  };

  removeListener = (listener: () => void) => {
    this.legacyListeners = this.legacyListeners.filter((l) => l !== listener);
  };

  trigger() {
    for (const l of [...this.modernListeners, ...this.legacyListeners]) l();
  }

  get listenerCount() {
    return this.modernListeners.length + this.legacyListeners.length;
  }
}

function makeEnv(initialDpr: number, supportsModern = true) {
  let dpr = initialDpr;
  const created: FakeMediaQueryList[] = [];
  return {
    created,
    getDevicePixelRatio: () => dpr,
    matchMedia: (query: string) => {
      const mql = new FakeMediaQueryList(query, supportsModern);
      created.push(mql);
      return mql;
    },
    setDpr: (value: number) => {
      dpr = value;
    },
  };
}

test("registers a change listener for the current devicePixelRatio", () => {
  const env = makeEnv(1);
  watchDevicePixelRatio({
    getDevicePixelRatio: env.getDevicePixelRatio,
    matchMedia: env.matchMedia,
    onChange: () => {},
  });

  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].query, "(resolution: 1dppx)");
  assert.equal(env.created[0].listenerCount, 1);
});

test("invokes onChange when the media query reports a change", () => {
  const env = makeEnv(1);
  let calls = 0;
  watchDevicePixelRatio({
    getDevicePixelRatio: env.getDevicePixelRatio,
    matchMedia: env.matchMedia,
    onChange: () => {
      calls += 1;
    },
  });

  env.setDpr(2);
  env.created[0].trigger();

  assert.equal(calls, 1);
});

test("re-registers for the new ratio so subsequent changes still fire", () => {
  const env = makeEnv(1);
  let calls = 0;
  watchDevicePixelRatio({
    getDevicePixelRatio: env.getDevicePixelRatio,
    matchMedia: env.matchMedia,
    onChange: () => {
      calls += 1;
    },
  });

  env.setDpr(2);
  env.created[0].trigger();

  assert.equal(env.created.length, 2);
  assert.equal(env.created[1].query, "(resolution: 2dppx)");
  // The stale listener must be detached so it cannot double-fire.
  assert.equal(env.created[0].listenerCount, 0);

  env.setDpr(3);
  env.created[1].trigger();

  assert.equal(calls, 2);
});

test("cleanup stops further onChange callbacks", () => {
  const env = makeEnv(1);
  let calls = 0;
  const stop = watchDevicePixelRatio({
    getDevicePixelRatio: env.getDevicePixelRatio,
    matchMedia: env.matchMedia,
    onChange: () => {
      calls += 1;
    },
  });

  stop();

  assert.equal(env.created[0].listenerCount, 0);
  env.created[0].trigger();
  assert.equal(calls, 0);
});

test("falls back to addListener/removeListener when addEventListener is unavailable", () => {
  const env = makeEnv(1, /* supportsModern */ false);
  let calls = 0;
  const stop = watchDevicePixelRatio({
    getDevicePixelRatio: env.getDevicePixelRatio,
    matchMedia: env.matchMedia,
    onChange: () => {
      calls += 1;
    },
  });

  assert.equal(env.created[0].legacyListeners.length, 1);
  env.created[0].trigger();
  assert.equal(calls, 1);

  stop();
  // After cleanup the most recently registered query has no listeners.
  const latest = env.created[env.created.length - 1];
  assert.equal(latest.listenerCount, 0);
});
