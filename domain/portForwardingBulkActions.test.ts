import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PortForwardingRule } from "./models";
import {
  isPortForwardingRuleStartable,
  isPortForwardingRuleStoppable,
  isPortForwardingRuntimeBusy,
  selectStartablePortForwardingRules,
  selectStoppablePortForwardingRules,
} from "./portForwardingBulkActions";

const rule = (overrides: Partial<PortForwardingRule>): PortForwardingRule => ({
  id: "rule-1",
  label: "Rule",
  type: "local",
  localPort: 18080,
  bindAddress: "127.0.0.1",
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  status: "inactive",
  createdAt: 1,
  ...overrides,
});

describe("portForwardingBulkActions", () => {
  it("treats tracked active, connecting, and error runtimes as busy", () => {
    assert.equal(isPortForwardingRuntimeBusy({ status: "active" }), true);
    assert.equal(isPortForwardingRuntimeBusy({ status: "connecting" }), true);
    assert.equal(isPortForwardingRuntimeBusy({ status: "error" }), true);
    assert.equal(isPortForwardingRuntimeBusy({ status: "inactive" }), false);
    assert.equal(isPortForwardingRuntimeBusy(undefined), false);
  });

  it("starts inactive and error rules that are not already running", () => {
    assert.equal(isPortForwardingRuleStartable(rule({ status: "inactive" }), false), true);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "error" }), false), true);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "unknown" }), false), false);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "inactive" }), true), false);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "error" }), true), false);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "inactive" }), true), false);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "active" }), false), false);
    assert.equal(isPortForwardingRuleStartable(rule({ status: "connecting" }), false), false);
  });

  it("stops rules that are active, connecting, or have a busy runtime", () => {
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "active" }), false), true);
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "connecting" }), false), true);
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "inactive" }), true), true);
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "error" }), true), true);
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "error" }), false), false);
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "inactive" }), false), false);
    assert.equal(isPortForwardingRuleStoppable(rule({ status: "unknown" }), false), false);
  });

  it("selects startable vs already-running rules for bulk actions", () => {
    const rules = [
      rule({ id: "inactive", status: "inactive" }),
      rule({ id: "error", status: "error" }),
      rule({ id: "active", status: "active" }),
      rule({ id: "connecting", status: "connecting" }),
      rule({ id: "busy-inactive", status: "inactive" }),
      rule({ id: "error-runtime", status: "error" }),
      rule({ id: "unknown", status: "unknown" }),
    ];
    const busy = new Set(["busy-inactive", "active", "connecting", "error-runtime"]);

    assert.deepEqual(
      selectStartablePortForwardingRules(rules, (id) => busy.has(id)).map((item) => item.id),
      ["inactive", "error"],
    );
    assert.deepEqual(
      selectStoppablePortForwardingRules(rules, (id) => busy.has(id)).map((item) => item.id),
      ["active", "connecting", "busy-inactive", "error-runtime"],
    );
  });
});
