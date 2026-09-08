import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPortForwardingAutoReconnectEnabled } from "./portForwardingReconnect";

describe("isPortForwardingAutoReconnectEnabled", () => {
  it("returns true when autoReconnect is enabled", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoReconnect: true }), true);
  });

  it("returns true for auto-start rules (pre-existing behavior)", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoStart: true }), true);
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoStart: true, autoReconnect: false }), true);
  });

  it("returns false when neither flag opts in", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({}), false);
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoStart: false }), false);
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoReconnect: false }), false);
  });
});
