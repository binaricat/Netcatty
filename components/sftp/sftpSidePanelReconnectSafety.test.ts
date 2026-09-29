import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidePanelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");
const tabBridgeSource = readFileSync(
  new URL("../terminalLayer/TerminalLayerTabBridge.tsx", import.meta.url),
  "utf8",
);

test("SFTP side panel rebinds after same-tab SSH start-over", () => {
  assert.match(sidePanelSource, /shouldRebindSftpSidePanelSourceSession\(/);
  assert.match(sidePanelSource, /shouldDeferSftpSidePanelAutoConnectForSession\(/);
  assert.match(sidePanelSource, /lastSourceSessionStatusRef/);
  assert.match(
    sidePanelSource,
    /previousStatus:\s*lastSourceSessionStatusRef\.current/,
  );
  // Reuse the terminal transport only after SSH is connected. A linked id can
  // arrive while reconnecting. Single-channel bastions dial a separate login.
  assert.match(
    sidePanelSource,
    /const reuseTerminalTransport = !dedicatedSftpLogin && \(\s*Boolean\(pendingStrictSourceSessionId\) \|\| activeSessionStatus === "connected"\s*\);/,
  );
  assert.match(
    sidePanelSource,
    /sourceSessionId: reuseTerminalTransport\s*\?\s*\(pendingStrictSourceSessionId \?\? \(activeSessionId \?\? undefined\)\)\s*: undefined/,
  );
  assert.match(
    sidePanelSource,
    /requireSourceSessionReuse: reuseTerminalTransport && Boolean\(pendingStrictSourceSessionId\)/,
  );
  assert.match(sidePanelSource, /resolveSftpSidePanelTrackedSourceStatusUpdate\(/);
  assert.match(
    sidePanelSource,
    /trackedSessionId = lastSourceSessionIdRef\.current/,
  );
  assert.match(sidePanelSource, /if \(activeSessionId\) return;/);
});

test("terminal layer keeps the linked SFTP session id while SSH reconnects", () => {
  assert.match(tabBridgeSource, /isTerminalSessionEligibleForSftpReuse\(session\)/);
  assert.doesNotMatch(
    tabBridgeSource,
    /activeTerminalSessionIdForSftp[\s\S]*canReuseTerminalConnection\(session\)/,
  );
});
