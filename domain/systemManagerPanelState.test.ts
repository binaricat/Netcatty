import assert from "node:assert/strict";
import test from "node:test";

import { resolveCapabilityPanelState } from "./systemManagerPanelState.ts";

test("keeps unavailable state visible while a known-missing capability is refreshed", () => {
  assert.equal(
    resolveCapabilityPanelState({
      isActive: true,
      ready: false,
      capabilitiesKnown: true,
    }),
    "unavailable",
  );
});

test("shows checking only before capabilities are known", () => {
  assert.equal(
    resolveCapabilityPanelState({
      isActive: true,
      ready: false,
      capabilitiesKnown: false,
    }),
    "checking",
  );
});

test("hides inactive capability panels", () => {
  assert.equal(
    resolveCapabilityPanelState({
      isActive: false,
      ready: false,
      capabilitiesKnown: true,
    }),
    "hidden",
  );
});
