import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
const layerSupportSource = readFileSync(new URL("../terminalLayer/TerminalLayerSupport.tsx", import.meta.url), "utf8");
const layerBridgeSource = readFileSync(new URL("../terminalLayer/TerminalLayerTabBridge.tsx", import.meta.url), "utf8");
const layerViewSource = readFileSync(new URL("../terminalLayer/TerminalLayerView.tsx", import.meta.url), "utf8");

test("local terminals stay out of hibernate and hidden-renderer paths", () => {
  assert.match(
    terminalSource,
    /const hibernateEnabled = resolveTerminalHibernateEnabledForProtocol\(terminalSettings, host\.protocol\)/,
  );
  assert.match(terminalSource, /hibernateEnabledRef\.current = hibernateEnabled/);
  assert.match(terminalSource, /hibernateEnabled: hibernateEnabled/);
  assert.match(effectsSource, /resolveTerminalHibernateEnabledForProtocol\(terminalSettings, host\.protocol\)/);
  assert.match(layerSupportSource, /resolveTerminalHibernateEnabledForProtocol\(terminalSettings, host\.protocol\)/);
  assert.match(layerBridgeSource, /const localWorkspaceIds = useMemo\(\(\) => new Set\(/);
  assert.match(layerBridgeSource, /!hibernateHiddenTabs \|\| localWorkspaceIds\.has\(workspace\.id\)/);
  assert.match(layerViewSource, /ctx\.hibernateHiddenTabs/);
});
