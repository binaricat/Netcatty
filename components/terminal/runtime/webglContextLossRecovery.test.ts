import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");

test("WebGL context loss schedules a coalesced rebuild and viewport repaint", () => {
  const handlerStart = source.indexOf("nextWebglAddon.onContextLoss");
  const handlerEnd = source.indexOf("term.loadAddon(nextWebglAddon)", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /nextWebglAddon\?\.dispose\(\)/);
  assert.match(handler, /webglLoaded = false/);
  assert.match(handler, /cancelWebglRecovery\(\)/);
  assert.match(handler, /webglRecoveryTimer = setTimeout/);
  assert.match(handler, /loadWebglRenderer\(\);[\s\S]*repaintTerminal\(\)/);
});

test("WebGL recovery has a circuit breaker and lifecycle cleanup", () => {
  assert.match(source, /WEBGL_MAX_RECOVERIES_PER_WINDOW = 2/);
  assert.match(source, /let webglCircuitBroken = false/);
  assert.match(
    source,
    /webglCircuitBroken = true;\s*cancelWebglRecovery\(\);\s*logger\.warn\("\[XTerm\] Repeated WebGL context loss, staying on DOM renderer"\);\s*return;/,
  );
  assert.match(source, /Repeated WebGL context loss, staying on DOM renderer/);
  assert.match(source, /const suspendWebglRenderer = \(\) => \{\s*cancelWebglRecovery\(\)/);
  assert.match(source, /dispose: \(\) => \{\s*runtimeDisposed = true;\s*cancelWebglRecovery\(\)/);
});

test("disabled WebGL remains a no-op", () => {
  assert.match(
    source,
    /const loadWebglRenderer = \(\) => \{\s*if \(webglLoaded \|\| webglCircuitBroken \|\| !performanceConfig\.useWebGLAddon\) return;/,
  );
});

test("ensureWebglRenderer remains a no-op after the circuit breaker trips", () => {
  const loadStart = source.indexOf("const loadWebglRenderer = () => {");
  const loadGuard = source.indexOf("webglCircuitBroken", loadStart);
  const addonConstruction = source.indexOf("new WebglAddon()", loadStart);

  assert.ok(loadStart >= 0);
  assert.ok(loadGuard > loadStart && loadGuard < addonConstruction);
  assert.match(source, /ensureWebglRenderer: loadWebglRenderer/);
});
