import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("server stats retry can restart polling after give-up", () => {
  const source = readFileSync(new URL("./hooks/useServerStats.ts", import.meta.url), "utf8");
  const reconcileStart = source.indexOf("function reconcileSharedServerStatsSession");
  const shouldRestartCheck = source.indexOf("const shouldRestartPolling", reconcileStart);
  const givenUpCheck = source.indexOf("if (session.givenUp) return;", shouldRestartCheck);
  const markPollingActive = source.indexOf("session.pollingActive = true", shouldRestartCheck);

  assert.notEqual(reconcileStart, -1);
  assert.notEqual(shouldRestartCheck, -1);
  assert.notEqual(givenUpCheck, -1);
  assert.notEqual(markPollingActive, -1);
  assert.ok(givenUpCheck < markPollingActive);
});

test("server stats stale requests do not block a fresh visible fetch", () => {
  const source = readFileSync(new URL("./hooks/useServerStats.ts", import.meta.url), "utf8");

  assert.match(source, /inflightGeneration: number \| null/);
  assert.match(source, /session\.inflight && session\.inflightGeneration === session\.fetchGeneration/);
  assert.match(source, /session\.inflightGeneration = generation/);
});

test("server stats polling does not stop when its terminal is in the background", () => {
  const source = readFileSync(new URL("./hooks/useServerStats.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /isVisible/);
  assert.doesNotMatch(source, /getVisibleServerStatsClients/);
  assert.doesNotMatch(source, /resuming from hidden/);
});
