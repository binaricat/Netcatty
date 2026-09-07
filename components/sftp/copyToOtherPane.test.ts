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

test("same-pane copy of files into their own source folder is allowed", async () => {
  const files = [
    { name: "report.txt", isDirectory: false },
    { name: "notes.txt", isDirectory: false },
  ];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/home/user", targetPath: "/home/user", files }),
    "allow",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/home/user", targetPath: "/home/user/docs", files }),
    "allow",
  );
});

test("same-pane copy of a directory into itself or a descendant is blocked", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a", targetPath: "/a/docs", files }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a", targetPath: "/a/docs/sub", files }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a", targetPath: "/a/docs/sub/deep", files }),
    "block-into-source",
  );
});

test("same-pane copy of a directory into a sibling is allowed", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a/docs", targetPath: "/a/sub", files }),
    "allow",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "copy", sourcePath: "/a/docs", targetPath: "/a/docsx", files }),
    "allow",
  );
});

test("same-pane cut into the source folder is blocked", async () => {
  const files = [{ name: "report.txt", isDirectory: false }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user", files }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/", files }),
    "block-same-folder",
  );
});

test("same-pane cut of files into a child of the source folder is allowed", async () => {
  const files = [
    { name: "report.txt", isDirectory: false },
    { name: "photos", isDirectory: false },
  ];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs", files }),
    "allow",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub", files }),
    "allow",
  );
});

test("same-pane cut of a directory into itself or a descendant is blocked", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs", files }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub", files }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/docs/sub/deep", files }),
    "block-into-source",
  );
});

test("same-pane cut into a sibling folder is allowed", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/other", files }),
    "allow",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user2", files }),
    "allow",
  );
});

test("same-pane paste guard understands Windows paths", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:/Users/me",
      files,
    }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\docs",
      files,
    }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "copy",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\docs",
      files: [{ name: "report.txt", isDirectory: false }],
    }),
    "allow",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\other",
      files,
    }),
    "allow",
  );
});

test("same-pane guards canonicalize equivalent path spellings", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/.", files }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home//user", files }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/user/../user", files }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "/home/user",
      targetPath: "/home/./user/docs",
      files,
    }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/userx", files }),
    "allow",
  );
});

test("same-pane guards collapse a leading double slash for POSIX comparisons", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "//home/user", files }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "/home/user",
      targetPath: "//home/user/docs",
      files,
    }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "//home/user", targetPath: "/home/user", files }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({ operation: "cut", sourcePath: "/home/user", targetPath: "/home/other", files }),
    "allow",
  );
});

test("same-pane guards canonicalize equivalent Windows path spellings", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\.",
      files,
    }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\\\me",
      files,
    }),
    "block-same-folder",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "C:\\Users\\me",
      targetPath: "C:\\Users\\me\\docs\\sub\\..\\docs",
      files,
    }),
    "block-into-source",
  );
});

test("same-pane guards resolve filesystem aliases before comparing", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  // /a/link -> /a/docs/sub: pasting /a/docs from /a/link must be blocked even
  // though the lexical paths look unrelated.
  const aliasedResolver = (path: string) => {
    const aliases: Record<string, string> = {
      "/a/link": "/a/docs/sub",
      "/a/docs": "/a/docs",
      "/a": "/a",
    };
    return Promise.resolve(aliases[path] ?? path);
  };
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "copy",
      sourcePath: "/a",
      targetPath: "/a/link",
      files,
      resolvePath: aliasedResolver,
    }),
    "block-into-source",
  );
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "cut",
      sourcePath: "/a",
      targetPath: "/a/link",
      files,
      resolvePath: aliasedResolver,
    }),
    "block-into-source",
  );
});

test("same-pane guards still allow unrelated real paths when resolving", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  const resolver = (path: string) => {
    const resolved: Record<string, string> = {
      "/a/docs": "/data/docs",
      "/a/other": "/data/other",
      "/a/docs/docs": "/data/docs/docs",
    };
    return Promise.resolve(resolved[path] ?? path);
  };
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "copy",
      sourcePath: "/a/docs",
      targetPath: "/a/other",
      files,
      resolvePath: resolver,
    }),
    "allow",
  );
});

test("same-pane guards fail closed when filesystem resolution fails", async () => {
  const files = [{ name: "docs", isDirectory: true }];
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "copy",
      sourcePath: "/a/docs",
      targetPath: "/a/other",
      files,
      resolvePath: () => Promise.reject(new Error("realpath unavailable")),
    }),
    "block-into-source",
  );
});

test("files-only copy still passes when path resolution is unavailable", async () => {
  const files = [{ name: "report.txt", isDirectory: false }];
  assert.equal(
    await resolveSamePanePasteAction({
      operation: "copy",
      sourcePath: "/a",
      targetPath: "/b",
      files,
      resolvePath: () => Promise.reject(new Error("realpath unavailable")),
    }),
    "allow",
  );
});
