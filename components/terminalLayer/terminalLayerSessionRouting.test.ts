import assert from "node:assert/strict";
import test from "node:test";

import {
  canUseDirectSessionWriteFallback,
  resolveFallbackSessionProtocol,
} from "./terminalLayerSessionRouting";

test("resolveFallbackSessionProtocol defaults missing orphan protocol to ssh", () => {
  assert.equal(resolveFallbackSessionProtocol({}), "ssh");
});

test("resolveFallbackSessionProtocol preserves explicit local protocol", () => {
  assert.equal(resolveFallbackSessionProtocol({ protocol: "local" }), "local");
});

test("canUseDirectSessionWriteFallback blocks restored disconnected sessions", () => {
  assert.equal(
    canUseDirectSessionWriteFallback({
      status: "disconnected",
      restoreState: "restored-disconnected",
    }),
    false,
  );
});

test("canUseDirectSessionWriteFallback allows connected sessions", () => {
  assert.equal(canUseDirectSessionWriteFallback({ status: "connected" }), true);
});

test("canUseDirectSessionWriteFallback preserves existing connecting fallback writes", () => {
  assert.equal(canUseDirectSessionWriteFallback({ status: "connecting" }), true);
});
