import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("./runtime/createXTermRuntime.ts", import.meta.url), "utf8");
const layerSupportSource = readFileSync(new URL("../terminalLayer/TerminalLayerSupport.tsx", import.meta.url), "utf8");
const layerBridgeSource = readFileSync(new URL("../terminalLayer/TerminalLayerTabBridge.tsx", import.meta.url), "utf8");
const layerViewSource = readFileSync(new URL("../terminalLayer/TerminalLayerView.tsx", import.meta.url), "utf8");

test("local terminals stay out of hibernate and hidden-renderer paths", () => {
  assert.match(
    terminalSource,
    /const effectiveTerminalProtocol = resolveEffectiveTerminalProtocol\(host\);[\s\S]*const hibernateEnabled =\s+resolveTerminalHibernateEnabledForProtocol\([\s\S]*effectiveTerminalProtocol/,
  );
  assert.match(
    terminalSource,
    /kittyKeyboardProtocolEnabledForSessionRef = useRef\([\s\S]*const kittyKeyboardProtocolEnabledForSession =[\s\S]*kittyKeyboardProtocolEnabledForSessionRef\.current/,
  );
  assert.match(terminalSource, /!kittyKeyboardProtocolEnabledForSession &&\s+!isBroadcastEnabled/);
  assert.match(terminalSource, /hibernateEnabledRef\.current = hibernateEnabled/);
  assert.match(terminalSource, /hibernateEnabled: hibernateEnabled/);
  assert.match(
    effectsSource,
    /const effectiveTerminalProtocol = resolveEffectiveTerminalProtocol\(host\);[\s\S]*resolveTerminalHibernateEnabledForProtocol\([\s\S]*effectiveTerminalProtocol[\s\S]*&& !kittyKeyboardProtocolEnabledForSession/,
  );
  assert.match(layerSupportSource, /resolveTerminalHibernateEnabledForProtocol\(terminalSettings, host\.protocol\)/);
  assert.match(layerBridgeSource, /const localWorkspaceIds = useMemo\(\(\) => new Set\(/);
  assert.match(layerBridgeSource, /!hibernateHiddenTabs \|\| localWorkspaceIds\.has\(workspace\.id\)/);
  assert.match(layerViewSource, /ctx\.hibernateHiddenTabs/);
});

test("reconnect clears keyboard pairing before resetting protocol state", () => {
  assert.match(
    terminalSource,
    /startNewSession = \(\) => \{[\s\S]*resetKittyConnectionInputState\(\);[\s\S]*resetKittyKeyboardModeStateForSession/,
  );
  assert.match(
    runtimeSource,
    /clearKittyKeyboardBroadcastPairingState\([\s\S]*broadcastEncodedKeys,[\s\S]*broadcastLegacySuppressedKeys/,
  );
  assert.match(
    runtimeSource,
    /resetKittyConnectionInputState: clearKittyConnectionInputState/,
  );
  assert.match(
    runtimeSource,
    /kittyKeyboardLockState\.capsLock = event\.getModifierState\("CapsLock"\);[\s\S]*kittyKeyboardLockState\.numLock = event\.getModifierState\("NumLock"\);/,
  );
  assert.match(
    runtimeSource,
    /flushKittyKeyboardBroadcastReleases\([\s\S]*broadcastForwardedKeys,[\s\S]*broadcastKittyInput,[\s\S]*kittyKeyboardLockState/,
  );
  assert.doesNotMatch(
    runtimeSource.match(/const clearKittyConnectionInputState = \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? "",
    /broadcastForwardedKeys\.clear\(\)/,
  );
});

test("session cleanup flushes owed Kitty releases before dropping the backend id", () => {
  assert.match(
    terminalSource,
    /const closingSessionId = sessionRef\.current;\s+xtermRuntimeRef\.current\?\.flushKittyKeyboardReleases\(\);\s+sessionRef\.current = null;/,
  );
  assert.match(
    runtimeSource,
    /flushKittyKeyboardReleases: clearKittyTransientInputState/,
  );
});
