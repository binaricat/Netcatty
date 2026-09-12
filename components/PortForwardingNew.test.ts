import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PortForwardingNew.tsx", import.meta.url), "utf8");

test("port forwarding toolbar exposes start-all and stop-all actions", () => {
  assert.match(source, /pf\.action\.startAll/);
  assert.match(source, /pf\.action\.stopAll/);
  assert.match(source, /handleStartAll/);
  assert.match(source, /handleStopAll/);
  assert.match(source, /startAllTunnels/);
  assert.match(source, /stopAllTunnels/);
  assert.match(source, /startableRules\.length === 0/);
  assert.match(source, /stoppableRules\.length === 0/);
  assert.match(source, /<Play size=\{14\} \/>/);
  assert.match(source, /<Square size=\{14\} \/>/);
});

test("port forwarding bulk actions stay on start/stop all without selection checkboxes", () => {
  assert.match(source, /startAllTunnels\(/);
  assert.match(source, /stopAllTunnels\(/);
  assert.doesNotMatch(source, /selectedRuleIds|bulkDelete|type="checkbox"/);
});
