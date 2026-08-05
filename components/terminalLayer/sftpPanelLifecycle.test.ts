import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { TransferTask } from "../../domain/models";
import {
  SFTP_TRANSFER_HISTORY_RETENTION_MS,
  countTransfersRetainingSftpOwner,
  isTransferRetainingSftpOwner,
  listInvalidSftpPanelTabIds,
  listTerminalTabIdsWithRetainingTransfers,
  resolveSftpActiveTransfersCount,
  shouldCloseSftpSidePanel,
  shouldClearSftpPanelAfterTransferChange,
  shouldKeepSftpMountedAfterClose,
  shouldScheduleSftpRetainedPanelCleanup,
  terminalSftpTransferOwnerId,
} from "./sftpPanelLifecycle.ts";

test("reopening focused SFTP does not close the other split panes", () => {
  assert.equal(shouldCloseSftpSidePanel({
    shouldKeepOpen: false,
    isOpen: true,
    isSameEndpoint: true,
    paneCount: 2,
  }), false);
  assert.equal(shouldCloseSftpSidePanel({
    shouldKeepOpen: false,
    isOpen: true,
    isSameEndpoint: true,
    paneCount: 1,
  }), true);
});

test("single-pane SFTP close uses the shared full-panel cleanup and stops opening work", () => {
  const layerSource = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");

  assert.match(
    layerSource,
    /if \(isClosing\) \{\s*closeTerminalSidePanelTab\(tabId\);\s*return;\s*\}/,
  );
  assert.match(layerSource, /const handleCloseSidePanel = useCallback[\s\S]*closeTerminalSidePanelTab\(activeTabId\)/);
  assert.match(layerSource, /closeTerminalSidePanelTab[\s\S]*setAiMountedTabIds[\s\S]*setNotesOpenNoteByTab/);
});

function task(
  partial: Partial<TransferTask> & Pick<TransferTask, "id" | "status">,
): Pick<TransferTask, "id" | "status" | "parentTaskId" | "ownerId"> {
  return {
    id: partial.id,
    status: partial.status,
    parentTaskId: partial.parentTaskId,
    ownerId: partial.ownerId,
  };
}

test("closing the panel keeps SFTP mounted while a transfer is active", () => {
  assert.equal(shouldKeepSftpMountedAfterClose({ activeTransfersCount: 1 }), true);
  assert.equal(shouldKeepSftpMountedAfterClose({ activeTransfersCount: 3 }), true);
});

test("closing the panel keeps SFTP mounted while an external editor temp is open", () => {
  assert.equal(shouldKeepSftpMountedAfterClose({
    activeTransfersCount: 0,
    activeExternalEditCount: 1,
  }), true);
  assert.equal(shouldKeepSftpMountedAfterClose({
    activeTransfersCount: 0,
    activeExternalEditCount: 0,
  }), false);
});

test("closing an idle panel still releases its SFTP state", () => {
  assert.equal(shouldKeepSftpMountedAfterClose({ activeTransfersCount: 0 }), false);
});

test("a transfer retained by close keeps its history after completion", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    activeExternalEditCount: 0,
    panelOpen: false,
    retainedAfterClose: true,
  }), false);
  assert.equal(shouldScheduleSftpRetainedPanelCleanup({
    activeTransfersCount: 0,
    activeExternalEditCount: 0,
    retainedAfterClose: true,
  }), true);
  assert.ok(SFTP_TRANSFER_HISTORY_RETENTION_MS > 0);
});

test("retained cleanup waits while an external editor temp is still open", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    activeExternalEditCount: 1,
    panelOpen: false,
    retainedAfterClose: false,
  }), false);
  assert.equal(shouldScheduleSftpRetainedPanelCleanup({
    activeTransfersCount: 0,
    activeExternalEditCount: 1,
    retainedAfterClose: true,
  }), false);
});

test("retained cleanup is scheduled even if close state has not committed yet", () => {
  assert.equal(shouldScheduleSftpRetainedPanelCleanup({
    activeTransfersCount: 0,
    retainedAfterClose: true,
  }), true);
});

test("closing a terminal tab finds every retained SFTP resource for cleanup", () => {
  assert.deepEqual(listInvalidSftpPanelTabIds({
    mountedTabIds: ["closed-tab", "open-tab"],
    activeTransferTabIds: [],
    retainedTabIds: ["closed-tab"],
    openingTabIds: [],
    cleanupTimerTabIds: ["closed-tab"],
    validTabIds: new Set(["open-tab"]),
  }), ["closed-tab"]);
});

test("closing a terminal tab keeps its hidden SFTP owner mounted until active transfers finish", () => {
  assert.deepEqual(listInvalidSftpPanelTabIds({
    mountedTabIds: ["closed-tab"],
    activeTransferTabIds: ["closed-tab"],
    retainedTabIds: [],
    openingTabIds: [],
    cleanupTimerTabIds: [],
    validTabIds: new Set(),
  }), []);
});

test("a reopening panel is not cleared before its open state commits", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    activeExternalEditCount: 0,
    panelOpen: true,
    retainedAfterClose: false,
  }), false);
});

test("an unretained hidden idle panel can be released", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    activeExternalEditCount: 0,
    panelOpen: false,
    retainedAfterClose: false,
  }), true);
});

test("terminal owner id is stable for retain lookups", () => {
  assert.equal(terminalSftpTransferOwnerId("tab-1"), "terminal:tab-1");
});

test("store unfinished tasks retain the owner even when the panel report is still zero", () => {
  const ownerId = terminalSftpTransferOwnerId("tab-a");
  const storeTasks = [
    task({ id: "t1", status: "transferring", ownerId }),
    task({ id: "t2", status: "completed", ownerId }),
    task({ id: "child", status: "transferring", ownerId, parentTaskId: "t1" }),
  ];
  assert.equal(isTransferRetainingSftpOwner(storeTasks[0]!), true);
  assert.equal(isTransferRetainingSftpOwner(storeTasks[1]!), false);
  assert.equal(isTransferRetainingSftpOwner(storeTasks[2]!), false);
  assert.equal(countTransfersRetainingSftpOwner(storeTasks, ownerId), 1);
  assert.equal(resolveSftpActiveTransfersCount({
    reportedCount: 0,
    storeTasks,
    ownerId,
  }), 1);
  assert.equal(shouldKeepSftpMountedAfterClose({
    activeTransfersCount: resolveSftpActiveTransfersCount({
      reportedCount: 0,
      storeTasks,
      ownerId,
    }),
  }), true);
});

test("paused and failed top-level tasks still retain the hidden SFTP owner", () => {
  const ownerId = terminalSftpTransferOwnerId("tab-b");
  const storeTasks = [
    task({ id: "paused", status: "paused", ownerId }),
    task({ id: "failed", status: "failed", ownerId }),
  ];
  assert.equal(countTransfersRetainingSftpOwner(storeTasks, ownerId), 2);
});

test("listTerminalTabIdsWithRetainingTransfers only returns terminal owners with unfinished work", () => {
  assert.deepEqual(listTerminalTabIdsWithRetainingTransfers([
    task({ id: "a", status: "transferring", ownerId: "terminal:tab-1" }),
    task({ id: "b", status: "completed", ownerId: "terminal:tab-2" }),
    task({ id: "c", status: "queued", ownerId: "main-sftp-view" }),
    task({ id: "d", status: "paused", ownerId: "terminal:tab-3" }),
  ]).sort(), ["tab-1", "tab-3"]);
});

test("terminal side panel reports transfer activity and uses store-backed retain on close", () => {
  const layerSource = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");
  const transferLifecycleSource = readFileSync(
    new URL("../../application/state/sftp/useSftpTransferLifecycle.ts", import.meta.url),
    "utf8",
  );
  const slotsSource = readFileSync(new URL("./terminalLayerSidePanelSlots.tsx", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../../application/state/useSftpState.ts", import.meta.url), "utf8");

  assert.match(panelSource, /useReportSftpTransferOwnerActivity\(\{/);
  // Unmount reports store-backed unfinished count — never force-zero while work lives.
  assert.match(transferLifecycleSource, /sftpTransferCenterStore\.getSnapshot\(\)\.tasks/);
  assert.match(transferLifecycleSource, /onChangeRef\.current\?\.\(unfinished\)/);
  assert.doesNotMatch(panelSource, /useEffect\(\(\) => \(\) => \{\s*onActiveTransfersChange\?\.\(0\);\s*\}, \[onActiveTransfersChange\]\)/);
  assert.match(panelSource, /interactive:\s*isBrowseSessionInteractive\(\{/);
  assert.match(panelSource, /surfaceVisible:\s*isVisible/);
  assert.match(panelSource, /useEditorTabPresenceRevision\(\)/);
  assert.match(panelSource, /hasOwnedEditorTab/);
  assert.match(panelSource, /hasActiveExternalEdit/);
  assert.match(slotsSource, /onActiveTransfersChange=\{handleActiveTransfersChange\}/);
  assert.match(slotsSource, /onActiveExternalEditsChange=\{handleActiveExternalEditsChange\}/);
  assert.match(panelSource, /onActiveExternalEditsChange/);
  assert.match(layerSource, /resolveTabActiveTransfersCount/);
  assert.match(layerSource, /terminalSftpTransferOwnerId/);
  assert.match(layerSource, /listTerminalTabIdsWithRetainingTransfers/);
  assert.match(layerSource, /shouldKeepSftpMountedAfterClose\(\{/);
  assert.match(layerSource, /activeExternalEditCount/);
  assert.match(layerSource, /sftpActiveExternalEditsByTabRef/);
  assert.match(layerSource, /sftpRetainedAfterCloseTabIdsRef/);
  assert.match(layerSource, /sftpRetainedCleanupTimersRef/);
  // Hidden UI parks browse channels; transfers keep pool / leased sessions.
  // External editor temps must also block park (closeSftp deletes those files).
  assert.match(stateSource, /shouldParkBrowseSessions/);
  assert.match(stateSource, /activeExternalEditCount/);
  assert.match(stateSource, /takeBrowseSessionsForClose/);
  assert.match(stateSource, /shouldRestoreBrowseSessions/);
});
