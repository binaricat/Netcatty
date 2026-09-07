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

test("same-pane copy is always allowed", () => {
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/home/user", targetPath: "/home/user" }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "copy", sourcePath: "/home/user", targetPath: "/home/user/docs" }),
    "allow",
  );
});

test("same-pane cut into the source folder is blocked", () => {
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user" }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/" }),
    "block-same-folder",
  );
});

test("same-pane cut into a descendant of the source folder is blocked", () => {
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs" }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub" }),
    "block-into-source",
  );
});

test("same-pane cut into a sibling folder is allowed", () => {
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/other" }),
    "allow",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user2" }),
    "allow",
  );
});

test("same-pane cut guard understands Windows paths", () => {
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "C:\\Users\\me", targetPath: "C:/Users/me" }),
    "block-same-folder",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "C:\\Users\\me", targetPath: "C:\\Users\\me\\docs" }),
    "block-into-source",
  );
  assert.equal(
    resolveSamePanePasteAction({ operation: "cut", sourcePath: "C:\\Users\\me", targetPath: "C:\\Users\\other" }),
    "allow",
  );
});
