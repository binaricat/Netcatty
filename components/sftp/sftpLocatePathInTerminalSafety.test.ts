import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidePanelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");
const slotSource = readFileSync(
  new URL("../terminalLayer/terminalLayerSidePanelSlots.tsx", import.meta.url),
  "utf8",
);

test("locate-path write skips sessions waiting on sensitive/password prompts", () => {
  assert.match(
    sidePanelSource,
    /isTerminalSensitiveInputActive\(action\.sessionId\)[\s\S]*?writeToSession\(action\.sessionId, action\.data/,
  );
  assert.match(
    sidePanelSource,
    /if \(isTerminalSensitiveInputActive\(action\.sessionId\)\) return;/,
  );
});

test("locate-path write requires an idle shell prompt before PTY injection", () => {
  assert.match(
    sidePanelSource,
    /isTerminalReadyForCommandInjection\(action\.sessionId\)[\s\S]*?writeToSession\(action\.sessionId, action\.data/,
  );
  assert.match(
    sidePanelSource,
    /if \(!isTerminalReadyForCommandInjection\(action\.sessionId\)\) return;/,
  );
});

test("locate-path uses the confirmed toolbar path rather than an optimistic navigate target", () => {
  assert.match(sidePanelSource, /getNextSftpToolbarDisplayPath\(/);
  assert.match(
    sidePanelSource,
    /path: confirmedLocatePathRef\.current \|\| connection\?\.currentPath/,
  );
});

test("locate-path uses focused session fallback when SFTP cannot reuse the terminal", () => {
  assert.match(sidePanelSource, /resolveLocateSftpPathSessionId\(\{\s*activeSessionId,\s*focusedSessionId,/);
  assert.match(
    slotSource,
    /focusedSessionId=\{isVisible \? live\.focusedSessionId : null\}/,
  );
});
