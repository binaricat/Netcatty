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

test("renders active transfer cancel action with an item-specific label", () => {
  const markup = renderTransferItem({
    ...baseTask,
    status: "transferring",
    error: undefined,
    speed: 128,
  });

  assert.match(markup, /aria-label="Cancel: archive\.tar\.gz"/);
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
