import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { shouldBroadcastDuringSensitivePrompt } from "../../../domain/terminalBroadcast.ts";

import { shouldBroadcastTerminalUserInput } from "./terminalUserPaste.ts";

test("toolbar broadcast still fans terminal keystrokes out to peers", () => {
  const term = {};
  assert.equal(
    shouldBroadcastTerminalUserInput(term, "ls", {
      isBroadcastEnabled: true,
      hasBroadcastInputHandler: true,
    }),
    true,
  );
  assert.equal(
    shouldBroadcastTerminalUserInput(term, "ls", {
      isBroadcastEnabled: false,
      hasBroadcastInputHandler: true,
    }),
    false,
  );
});

test("keystroke fan-out stays on the toolbar gate and ignores the compose-bar target", () => {
  const runtime = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(runtime, /isBroadcastEnabled: ctx\.isBroadcastEnabledRef\.current/);
  assert.match(
    runtime,
    /onBroadcastInput\?\.\(broadcastData, ctx\.sessionId, sensitive \? \{ sourceSensitive: true \} : undefined\)/,
  );
  assert.doesNotMatch(runtime, /composeSendToAll|composePeerFanOut/);

  const layer = readFileSync(new URL("../../TerminalLayer.tsx", import.meta.url), "utf8");
  assert.match(layer, /includeGlobalPeersWithoutToolbar: options\?\.composePeerFanOut === true/);
  const keystrokeCall = layer.slice(
    layer.indexOf("const handleBroadcastInput"),
    layer.indexOf("const handleCommandSubmitted"),
  );
  assert.doesNotMatch(keystrokeCall, /isComposeSendToAll/);
});

const runtimeSource = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const gateStart = runtimeSource.indexOf("    const canBroadcastInput =");
const gateEnd = runtimeSource.indexOf("    const willBroadcastInput =", gateStart);
assert.ok(gateStart > 0 && gateEnd > gateStart);
const gateCode = runtimeSource.slice(gateStart, gateEnd) + "\ncanBroadcastInput;";

const kittyStart = runtimeSource.indexOf("    isSensitiveInput: () => !shouldBroadcastDuringSensitivePrompt(");
const kittyEnd = runtimeSource.indexOf("    // Dispatching from an active prompt", kittyStart);
assert.ok(kittyStart > 0 && kittyEnd > kittyStart);
const kittyCode = "({" + runtimeSource.slice(kittyStart, kittyEnd) + "}).isSensitiveInput()";

for (const alternateScreen of [false, true]) {
  for (const source of ['heuristic', 'explicit'] as const) {
    test(`raw and Kitty broadcast respect ${source} sensitivity on ${alternateScreen ? 'alternate' : 'primary'} screen`, () => {
      const context = {
        ctx: {
          passwordPromptActiveRef: { current: true, source },
          broadcastPasswordBypassRef: { current: false },
          isBroadcastEnabledRef: { current: true },
        },
        term: { buffer: { active: { type: alternateScreen ? 'alternate' : 'normal' } } },
        sensitive: true, carriedSensitive: false,
        options: undefined, inputSource: 'terminal', handlingKittyBroadcast: false,
        suppressTerminalBroadcast: false, id: 'session', broadcastDataBeforeSudo: 'password',
        onBroadcastInput: () => {},
        shouldBroadcastDuringSensitivePrompt, shouldBroadcastTerminalUserInput,
      };
      assert.equal(runInNewContext(gateCode, context), false);
      assert.equal(runInNewContext(kittyCode, context), true);
      const pendingParseContext = {
        ...context,
        term: { buffer: { active: { type: 'normal' } } },
        ctx: { ...context.ctx, isPromptSecurityAlternateScreenActive: () => true },
      };
      assert.equal(runInNewContext(gateCode, pendingParseContext), false);
      assert.equal(runInNewContext(kittyCode, pendingParseContext), true);
      const bypassContext = {
        ...context,
        ctx: { ...context.ctx, broadcastPasswordBypassRef: { current: true } },
      };
      assert.equal(runInNewContext(gateCode, bypassContext), true);
      assert.equal(runInNewContext(kittyCode, bypassContext), false);
      assert.equal(runInNewContext(gateCode, { ...context, carriedSensitive: true }), false,
        'a carried sensitive paste stays closed even on the alternate screen');
    });
  }
}
