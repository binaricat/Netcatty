import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { TransferTask } from "../types.ts";
import { SftpTransferItem } from "./sftp/SftpTransferItem.tsx";

const baseTask: TransferTask = {
  id: "transfer-1",
  fileName: "archive.tar.gz",
  sourcePath: "/local/archive.tar.gz",
  targetPath: "/remote/archive.tar.gz",
  sourceConnectionId: "local",
  targetConnectionId: "remote",
  direction: "upload",
  status: "failed",
  totalBytes: 1024,
  transferredBytes: 512,
  speed: 0,
  error: "Network error",
  startTime: 1,
  isDirectory: false,
};

const renderTransferItem = (
  task: TransferTask,
  props: Partial<React.ComponentProps<typeof SftpTransferItem>> = {},
) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(SftpTransferItem, {
        task,
        onCancel: () => {},
        onPause: () => {},
        onResume: () => {},
        onRetry: () => {},
        onDismiss: () => {},
        ...props,
      }),
    ),
  );

test("renders failed transfer actions with custom tooltips and readable labels", () => {
  const markup = renderTransferItem(baseTask);

  assert.match(markup, /aria-label="Retry: archive\.tar\.gz"/);
  assert.match(markup, /aria-label="Dismiss: archive\.tar\.gz"/);
  assert.match(markup, /focus-visible:ring-1/);
});

for (const isChild of [false, true]) {
  test(`completed ${isChild ? "child" : "file"} shows the cleanup path without a retry action`, () => {
    const warning = "Upload completed; remove backup /remote/.netcatty-backup-archive.tar.gz manually.";
    const markup = renderTransferItem({
      ...baseTask, status: "completed", error: undefined, warning, transferredBytes: 1024,
    }, { isChild });
    assert.match(markup, /data-transfer-status="completed"/);
    assert.match(markup, /data-section="sftp-transfer-warning"/);
    assert.ok(markup.includes(warning));
    assert.doesNotMatch(markup, /aria-label="Retry:/);
    assert.doesNotMatch(markup, /text-destructive/);
  });
}

test("folder rows disclose retained child cleanup warnings", () => {
  const markup = renderTransferItem({ ...baseTask, status: "completed", error: undefined, isDirectory: true }, {
    childWarningCount: 2, canToggleChildren: true, onToggleChildren: () => {},
  });
  assert.match(markup, /Backup cleanup warnings: 2/);
});

test("renders active transfer cancel action with an item-specific label", () => {
  const markup = renderTransferItem({
    ...baseTask,
    status: "transferring",
    error: undefined,
    speed: 128,
  });

  assert.match(markup, /aria-label="Cancel: archive\.tar\.gz"/);
  assert.match(markup, /aria-label="Pause: archive\.tar\.gz"/);
});

test("directory parents show transfer-center done/found progress instead of Waiting", () => {
  const markup = renderTransferItem({
    ...baseTask,
    id: "folder-1",
    fileName: "big-tree",
    isDirectory: true,
    progressMode: "files",
    status: "pending",
    phase: "transferring",
    transferredBytes: 65,
    totalBytes: 108202,
    error: undefined,
    speed: 0,
  });

  assert.match(markup, /65 done · 108202 found/);
  assert.doesNotMatch(markup, />Waiting\.\.\.</);
});

test("scanning directory parents keep scanning label with live discovery counts", () => {
  const markup = renderTransferItem({
    ...baseTask,
    id: "folder-scan",
    fileName: "docs",
    isDirectory: true,
    progressMode: "files",
    status: "pending",
    phase: "scanning",
    transferredBytes: 0,
    totalBytes: 1284,
    error: undefined,
    speed: 0,
  });

  assert.match(markup, /Scanning/);
  assert.match(markup, /0 done · 1284 found/);
});

test("child rows reserve an action column wide enough for pause and cancel", () => {
  const markup = renderTransferItem(
    {
      ...baseTask,
      id: "child-transfer-actions",
      parentTaskId: "transfer-1",
      status: "transferring",
      error: undefined,
      transferredBytes: 256,
      totalBytes: 1024,
      speed: 128,
      resumable: true,
    },
    {
      isChild: true,
      childNameColumnWidth: 260,
      onResizeNameColumn: () => {},
      onSetNameColumnWidth: () => {},
    },
  );

  assert.match(markup, /grid-template-columns:24px 260px 10px minmax\(0, 1fr\) 56px/);
  assert.match(markup, /aria-label="Pause: archive\.tar\.gz"/);
  assert.match(markup, /aria-label="Cancel: archive\.tar\.gz"/);
});

test("renders paused transfer resume action", () => {
  const markup = renderTransferItem({
    ...baseTask,
    status: "paused",
    error: undefined,
    resumable: true,
  });

  assert.match(markup, /aria-label="Resume: archive\.tar\.gz"/);
  // Paused rows keep the checkpoint progress bar (amber, no shimmer).
  assert.match(markup, /bg-amber-500\/80/);
  assert.doesNotMatch(markup, /progress-shimmer/);
});

test("renders resume spinner while reconnecting", () => {
  const markup = renderTransferItem({
    ...baseTask,
    status: "pending",
    error: undefined,
    reconnectRequired: true,
    resumable: true,
  });

  assert.match(markup, /aria-label="Reconnecting and resuming…: archive\.tar\.gz"/);
  assert.match(markup, /aria-busy="true"/);
  assert.doesNotMatch(markup, /aria-label="Resume: archive\.tar\.gz"/);
  assert.match(markup, /animate-spin/);
});

test("renders pausing state feedback instead of a dead pause button", () => {
  const markup = renderTransferItem({
    ...baseTask,
    status: "pausing",
    error: undefined,
    speed: 0,
    resumable: true,
  });

  // Soft-drain is short; status copy is "Pausing" (not "finishing current step").
  assert.match(markup, /aria-label="Pausing: archive\.tar\.gz"/);
  assert.match(markup, /aria-busy="true"/);
  assert.doesNotMatch(markup, /aria-label="Pause: archive\.tar\.gz"/);
  assert.match(markup, />Pausing</);
});

test("surfaces pause unavailable reason on a transferring row", () => {
  const markup = renderTransferItem({
    ...baseTask,
    status: "transferring",
    error: undefined,
    speed: 128,
    pauseUnavailableReason: "This transfer cannot be paused yet",
  });

  assert.match(markup, /This transfer cannot be paused yet/);
});

test("shows a settled folder pause failure with retry and resume instead of a spinner", () => {
  const markup = renderTransferItem({
    ...baseTask,
    isDirectory: true,
    status: "pausing",
    error: undefined,
    speed: 0,
    resumable: true,
    pauseUnavailableReason: "This transfer cannot be paused yet",
  }, { onPause: () => {}, onResume: () => {} });

  assert.match(markup, /This transfer cannot be paused yet/);
  assert.match(markup, /aria-label="Pause: archive\.tar\.gz"/);
  assert.match(markup, /aria-label="Resume: archive\.tar\.gz"/);
  assert.doesNotMatch(markup, /aria-busy="true"|aria-label="Pausing:/);
});

test("renders child resize handle as a keyboard-reachable separator", () => {
  const markup = renderTransferItem(
    {
      ...baseTask,
      id: "child-transfer-1",
      parentTaskId: "transfer-1",
      status: "transferring",
      error: undefined,
      transferredBytes: 256,
      speed: 128,
    },
    {
      isChild: true,
      childNameColumnWidth: 260,
      onResizeNameColumn: () => {},
      onSetNameColumnWidth: () => {},
    },
  );

  assert.match(markup, /role="separator"/);
  assert.match(markup, /aria-label="Resize file name column"/);
  assert.match(markup, /aria-orientation="vertical"/);
  assert.match(markup, /tabindex="0"/);
});

test("can remove duplicate child resize handles from the tab order", () => {
  const markup = renderTransferItem(
    {
      ...baseTask,
      id: "child-transfer-2",
      parentTaskId: "transfer-1",
      status: "pending",
      error: undefined,
    },
    {
      isChild: true,
      onResizeNameColumn: () => {},
      onSetNameColumnWidth: () => {},
      resizeHandleTabIndex: -1,
    },
  );

  assert.match(markup, /role="separator"/);
  assert.match(markup, /tabindex="-1"/);
});

test("keeps reveal target and child toggle as separate buttons", () => {
  const markup = renderTransferItem(
    {
      ...baseTask,
      status: "completed",
      error: undefined,
      isDirectory: true,
    },
    {
      canRevealTarget: true,
      onRevealTarget: () => {},
      canToggleChildren: true,
      isExpanded: false,
      childListId: "children-transfer-1",
      onToggleChildren: () => {},
    },
  );

  const revealStart = markup.indexOf('<button type="button" class="flex min-w-0 flex-1');
  assert.notEqual(revealStart, -1);

  const revealEnd = markup.indexOf("</button>", revealStart);
  const toggleStart = markup.indexOf('aria-label="Show detail"');

  assert.notEqual(toggleStart, -1);
  assert.ok(toggleStart > revealEnd);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-controls="children-transfer-1"/);
});

test("renders explicit target actions for completed local downloads", () => {
  const markup = renderTransferItem(
    {
      ...baseTask,
      id: "download-1",
      fileName: "report.pdf",
      sourcePath: "/remote/report.pdf",
      targetPath: "/Users/alice/Downloads/report.pdf",
      targetConnectionId: "local",
      direction: "download",
      status: "completed",
      error: undefined,
      transferredBytes: 1024,
    },
    {
      canRevealTarget: true,
      onRevealTarget: () => {},
      canCopyTargetPath: true,
      onCopyTargetPath: () => {},
    },
  );

  assert.match(markup, /aria-label="Open target folder: report\.pdf"/);
  assert.match(markup, /aria-label="Copy target path: report\.pdf"/);
  assert.match(markup, /lucide-folder-open/);
  assert.match(markup, /lucide-clipboard-copy/);
});
