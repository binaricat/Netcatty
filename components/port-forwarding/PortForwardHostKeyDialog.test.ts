import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogSource = readFileSync(
  new URL("./PortForwardHostKeyDialog.tsx", import.meta.url),
  "utf8",
);

const trayPanelSource = readFileSync(
  new URL("../TrayPanel.tsx", import.meta.url),
  "utf8",
);

const trayPromptSource = readFileSync(
  new URL("./PortForwardHostKeyTrayPrompt.tsx", import.meta.url),
  "utf8",
);

test("port-forward host-key dialog is marked so tray outside-click handling ignores it", () => {
  assert.match(dialogSource, /data-port-forward-host-key-dialog="true"/);
  assert.match(dialogSource, /overlayClassName="port-forward-host-key-dialog-layer"/);
  assert.match(dialogSource, /w-\[calc\(100vw-1\.5rem\)\]/);
  assert.match(dialogSource, /rounded-lg/);
  assert.match(trayPanelSource, /data-port-forward-host-key-dialog/);
  assert.match(trayPanelSource, /port-forward-host-key-dialog-layer/);
});

test("tray uses the lightweight host-key prompt instead of the main dialog", () => {
  assert.match(trayPromptSource, /data-port-forward-host-key-tray-prompt="true"/);
  assert.match(trayPromptSource, /px-3 py-2/);
  assert.match(trayPromptSource, /grid-cols-\[auto_auto_1fr\] gap-1/);
  assert.match(trayPromptSource, /h-6 px-1\.5 text-\[10px\]/);
  assert.doesNotMatch(trayPromptSource, /border-b/);
  assert.doesNotMatch(trayPromptSource, /rounded-md border p-2\.5 shadow-sm/);
  assert.doesNotMatch(trayPromptSource, /lucide-react/);
  assert.match(trayPanelSource, /<PortForwardHostKeyTrayPrompt onAddKnownHost=\{handleAddKnownHost\} \/>/);
  assert.doesNotMatch(trayPanelSource, /<PortForwardHostKeyDialog/);
  assert.match(trayPanelSource, /data-port-forward-host-key-dialog/);
  assert.match(trayPanelSource, /data-port-forward-host-key-tray-prompt/);
});
