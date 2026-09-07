import assert from "node:assert/strict";
import test from "node:test";
import {
  canCopyToOtherPane,
  requireCopyToOtherPaneTarget,
  resolveSamePanePasteAction,
  type SftpPaneSide,
} from "./copyToOtherPane";

test("copy to other pane is unavailable when the destination pane is missing", () => {
  assert.equal(canCopyToOtherPane({ getActivePane: () => null }, "right"), false);
  assert.equal(canCopyToOtherPane({ getActivePane: () => ({}) }, "right"), false);
});

test("copy to other pane is unavailable until the destination connection is ready", () => {
  for (const status of ["connecting", "disconnected", "error"] as const) {
    assert.equal(
      canCopyToOtherPane({ getActivePane: () => ({ connection: { status } }) }, "right"),
      false,
    );
  }
});

test("copy to other pane is unavailable while the destination is reconnecting", () => {
  assert.equal(
    canCopyToOtherPane({
      getActivePane: () => ({
        connection: { status: "connected" },
        reconnecting: true,
      }),
    }, "right"),
    false,
  );
});

test("copy to other pane is available when the requested destination is connected", () => {
  const requestedSides: SftpPaneSide[] = [];
  const state = {
    getActivePane: (side: SftpPaneSide) => {
      requestedSides.push(side);
      return { connection: { status: "connected" as const } };
    },
  };

  assert.equal(canCopyToOtherPane(state, "left"), true);
  assert.deepEqual(requestedSides, ["left"]);
});

test("copy to other pane reports why it cannot start instead of silently returning", () => {
  let unavailableCount = 0;
  const disconnectedState = { getActivePane: () => ({}) };
  const connectedState = { getActivePane: () => ({ connection: { status: "connected" as const } }) };

  assert.equal(
    requireCopyToOtherPaneTarget(disconnectedState, "right", () => { unavailableCount += 1; }),
    false,
  );
  assert.equal(unavailableCount, 1);

  assert.equal(
    requireCopyToOtherPaneTarget(connectedState, "right", () => { unavailableCount += 1; }),
    true,
  );
  assert.equal(unavailableCount, 1);
});

test("same-pane copy of files into their own source folder is allowed", () => {
  const files = [
    { name: "report.txt", isDirectory: false },
    { name: "notes.txt", isDirectory: false },
  ];
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/home/user", targetPath: "/home/user", files }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/home/user", targetPath: "/home/user/docs", files }),
    "allow",
  );
});

test("same-pane copy of a directory into itself or a descendant is blocked", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a", targetPath: "/a/docs", files }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a", targetPath: "/a/docs/sub", files }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a", targetPath: "/a/docs/sub/deep", files }),
    "block-into-source",
  );
});

test("same-pane copy of a directory into a sibling is allowed", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a/docs", targetPath: "/a/sub", files }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a/docs", targetPath: "/a/docsx", files }),
    "allow",
  );
});

test("same-pane cut into the source folder is blocked", () => {
  const files = [{ name: "report.txt", isDirectory: false }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user", files }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/", files }),
    "block-same-folder",
  );
});

test("same-pane cut of files into a child of the source folder is allowed", () => {
  const files = [
    { name: "report.txt", isDirectory: false },
    { name: "photos", isDirectory: false },
  ];
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs", files }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub", files }),
    "allow",
  );
});

test("same-pane cut of a directory into itself or a descendant is blocked", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs", files }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub", files }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub/deep", files }),
    "block-into-source",
  );
});

test("same-pane cut into a sibling folder is allowed", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/other", files }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user2", files }),
    "allow",
  );
});

test("same-pane paste guard understands Windows paths", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:/Users/me",
      files,
    }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\docs",
      files,
    }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "copy",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\docs",
      files: [{ name: "report.txt", isDirectory: false }],
    }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\other",
      files,
    }),
    "allow",
  );
});

test("same-pane guards canonicalize equivalent path spellings", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/.", files }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home//user", files }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/../user", files }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "/home/user",
      targetPath: "/home/./user/docs",
      files,
    }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/userx", files }),
    "allow",
  );
});

test("same-pane guards collapse a leading double slash for POSIX comparisons", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "//home/user", files }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "/home/user",
      targetPath: "//home/user/docs",
      files,
    }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "//home/user", targetPath: "/home/user", files }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/other", files }),
    "allow",
  );
});

test("same-pane guards canonicalize equivalent Windows path spellings", () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\.",
      files,
    }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\\\me",
      files,
    }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\docs\\sub\\..\\docs",
      files,
    }),
    "block-into-source",
  );
});
