import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SFTP_TRANSFER_HISTORY_RETENTION_MS,
  shouldClearSftpPanelAfterTransferChange,
  shouldKeepSftpMountedAfterClose,
  shouldScheduleSftpRetainedPanelCleanup,
} from "./sftpPanelLifecycle.ts";

test("closing the panel keeps SFTP mounted while a transfer is active", () => {
  assert.equal(shouldKeepSftpMountedAfterClose(1), true);
  assert.equal(shouldKeepSftpMountedAfterClose(3), true);
});

test("closing an idle panel still releases its SFTP state", () => {
  assert.equal(shouldKeepSftpMountedAfterClose(0), false);
});

test("a transfer retained by close keeps its history after completion", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    panelOpen: false,
    retainedAfterClose: true,
  }), false);
  assert.equal(shouldScheduleSftpRetainedPanelCleanup({
    activeTransfersCount: 0,
    panelOpen: false,
    retainedAfterClose: true,
  }), true);
  assert.ok(SFTP_TRANSFER_HISTORY_RETENTION_MS > 0);
});

test("an unretained hidden idle panel can be released", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    panelOpen: false,
    retainedAfterClose: false,
  }), true);
});

test("terminal side panel reports transfer activity and uses it during close", () => {
  const layerSource = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");
  const slotsSource = readFileSync(new URL("./terminalLayerSidePanelSlots.tsx", import.meta.url), "utf8");

  assert.match(panelSource, /onActiveTransfersChange\?\.\(sftp\.activeTransfersCount\)/);
  assert.match(slotsSource, /onActiveTransfersChange=\{handleActiveTransfersChange\}/);
  assert.match(layerSource, /shouldKeepSftpMountedAfterClose\(activeTransfersCount\)/);
  assert.match(layerSource, /sftpRetainedAfterCloseTabIdsRef/);
  assert.match(layerSource, /sftpRetainedCleanupTimersRef/);
});
