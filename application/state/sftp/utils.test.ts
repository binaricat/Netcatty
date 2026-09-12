import test from "node:test";
import assert from "node:assert/strict";

import {
  getParentPath,
  getFileName,
  getSftpBreadcrumbSegments,
  getSftpFilterAfterPathChange,
  getSftpFilterAfterPathChangeError,
  getSftpPathRoot,
  isConcreteTransferTargetPath,
  isSftpDescendantPath,
  isWindowsRoot,
  joinTransferTargetPath,
  normalizeSftpNavigationPath,
  normalizeSftpPaneNavigationPath,
  resolveSftpWindowsPathOptions,
  shouldClearSftpFilterForPathChange,
} from "./utils";

test("directory targets cannot escape the selected local root", () => {
  const windowsRoot = "C:\\Users\\alice\\Downloads\\folder";
  for (const relativePath of [
    "..\\outside.txt",
    "../outside.txt",
    "C:\\outside.txt",
    "C:/outside.txt",
    "\\\\server\\share\\outside.txt",
    "/absolute/outside.txt",
    ".. ",
    ". ",
    "safe.txt:alternate-stream",
  ]) {
    assert.throws(
      () => joinTransferTargetPath(windowsRoot, relativePath),
      /unsafe transfer path/i,
      relativePath,
    );
  }
  assert.equal(
    joinTransferTargetPath(windowsRoot, "nested/report.txt"),
    "C:\\Users\\alice\\Downloads\\folder\\nested\\report.txt",
  );
  assert.throws(
    () => joinTransferTargetPath("/Users/alice/Downloads/folder", "../outside.txt"),
    /unsafe transfer path/i,
  );

  const uncRoot = "\\\\server\\share\\Downloads\\folder";
  assert.throws(
    () => joinTransferTargetPath(uncRoot, "..\\outside.txt"),
    /unsafe transfer path/i,
  );
  assert.equal(
    joinTransferTargetPath(uncRoot, "nested/report.txt"),
    "\\\\server\\share\\Downloads\\folder\\nested\\report.txt",
  );

  // Forward-slash UNC destinations stay POSIX-shaped for remote panes, but
  // transfer joins must still apply Windows relative-path guards so a
  // server-controlled `\` / ADS name cannot escape the selected folder.
  const forwardSlashUncRoot = "//server/share/Downloads/folder";
  for (const relativePath of [
    "..\\outside.txt",
    "safe.txt:alternate-stream",
    "nested\\escape.txt",
    "trailing. ",
  ]) {
    assert.throws(
      () => joinTransferTargetPath(forwardSlashUncRoot, relativePath),
      /unsafe transfer path/i,
      relativePath,
    );
  }
  assert.equal(
    joinTransferTargetPath(forwardSlashUncRoot, "nested/report.txt"),
    "//server/share/Downloads/folder/nested/report.txt",
  );
  assert.equal(
    getParentPath("\\\\server\\share\\Downloads\\folder"),
    "\\\\server\\share\\Downloads",
  );
  assert.equal(
    getParentPath("\\\\server\\share"),
    "\\\\server\\share",
  );
});

test("path bar keeps WSL UNC paths instead of forcing a Unix root", () => {
  const windowsPane = { acceptForwardSlashUnc: true } as const;
  assert.equal(
    normalizeSftpNavigationPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaa"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaa",
  );
  assert.equal(
    normalizeSftpNavigationPath("//wsl.localhost/Ubuntu-22.04/home/aaa", windowsPane),
    "\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaa",
  );
  assert.equal(
    normalizeSftpNavigationPath("\\\\wsl$\\Ubuntu-22.04\\home\\aaa"),
    "\\\\wsl$\\Ubuntu-22.04\\home\\aaa",
  );
  assert.equal(normalizeSftpNavigationPath("C:"), "C:\\");
  assert.equal(normalizeSftpNavigationPath("c:/"), "C:\\");
  assert.equal(normalizeSftpNavigationPath("home/aaa"), "/home/aaa");
  assert.equal(normalizeSftpNavigationPath("/var/log"), "/var/log");
  assert.equal(normalizeSftpNavigationPath("   "), "/");
});

test("path bar keeps POSIX double-slash paths outside Windows panes", () => {
  assert.equal(normalizeSftpNavigationPath("//srv/share"), "//srv/share");
  assert.equal(
    normalizeSftpNavigationPath("//srv/share/logs"),
    "//srv/share/logs",
  );
  assert.equal(
    normalizeSftpNavigationPath("//wsl.localhost/Ubuntu-22.04/home/aaa"),
    "//wsl.localhost/Ubuntu-22.04/home/aaa",
  );
  assert.equal(
    normalizeSftpNavigationPath("//srv/share\\logs"),
    "//srv/share\\logs",
  );
});

test("getParentPath preserves POSIX double-slash prefixes", () => {
  assert.equal(getParentPath("//srv/share/logs"), "//srv/share");
  assert.equal(getParentPath("//srv/share"), "//srv");
  assert.equal(getParentPath("//srv"), "/");
  assert.equal(getParentPath("//"), "/");
  assert.equal(getParentPath("/srv/share/logs"), "/srv/share");
});

test("POSIX paths with three or more leading slashes stay in the root namespace", () => {
  assert.equal(getParentPath("///srv/share/logs"), "/srv/share");
  assert.deepEqual(
    getSftpBreadcrumbSegments("///srv/share/logs"),
    {
      segments: [
        { label: "srv", path: "/srv" },
        { label: "share", path: "/srv/share" },
        { label: "logs", path: "/srv/share/logs" },
      ],
      isWindowsDrive: false,
    },
  );
});

test("getFileName preserves backslashes in POSIX path components", () => {
  assert.equal(getFileName("//srv/share\\logs"), "share\\logs");
  assert.equal(getFileName("\\\\server\\share\\logs"), "logs");
});

test("descendant checks use the path kind instead of literal backslashes", () => {
  assert.equal(isSftpDescendantPath("//srv/share\\logs/child", "//srv/share\\logs"), true);
  assert.equal(isSftpDescendantPath("//srv/share\\logs-old", "//srv/share\\logs"), false);
  assert.equal(isSftpDescendantPath("C:\\Users\\alice\\child", "C:\\Users\\alice"), true);
});

test("Windows UNC share roots are treated as path roots", () => {
  assert.equal(isWindowsRoot("\\\\wsl.localhost\\Ubuntu-22.04"), true);
  assert.equal(isWindowsRoot("\\\\wsl.localhost\\Ubuntu-22.04\\"), true);
  assert.equal(isWindowsRoot("\\\\wsl.localhost\\Ubuntu-22.04\\home"), false);
  assert.equal(isWindowsRoot("C:\\"), true);
  assert.equal(isWindowsRoot("C:\\Users"), false);
});

test("Windows panes treat forward-slash UNC share roots as roots for Up navigation", () => {
  const windowsPane = { acceptForwardSlashUnc: true } as const;
  assert.equal(isWindowsRoot("//server/share"), false);
  assert.equal(isWindowsRoot("//server/share", windowsPane), true);
  assert.equal(isWindowsRoot("//server/share/", windowsPane), true);
  assert.equal(isWindowsRoot("//server/share/logs", windowsPane), false);
  assert.equal(getParentPath("//server/share"), "//server");
  assert.equal(getParentPath("//server/share", windowsPane), "\\\\server\\share");
  assert.equal(
    getParentPath("//server/share/logs/app", windowsPane),
    "\\\\server\\share\\logs",
  );
});

test("pane context normalizes bookmark and initialPath forward-slash UNC ingress", () => {
  assert.deepEqual(resolveSftpWindowsPathOptions("C:\\Users\\alice"), {
    acceptForwardSlashUnc: true,
  });
  assert.deepEqual(resolveSftpWindowsPathOptions("/home/alice"), {});
  assert.deepEqual(
    resolveSftpWindowsPathOptions("//server/share", "C:\\Users\\alice"),
    { acceptForwardSlashUnc: true },
  );
  assert.equal(
    normalizeSftpPaneNavigationPath("//server/share", "C:\\Users\\alice"),
    "\\\\server\\share",
  );
  assert.equal(
    normalizeSftpPaneNavigationPath("//server/share", "/home/alice"),
    "//server/share",
  );
  assert.equal(
    normalizeSftpPaneNavigationPath("//wsl.localhost/Ubuntu-22.04/home", "\\\\wsl.localhost\\Ubuntu-22.04"),
    "\\\\wsl.localhost\\Ubuntu-22.04\\home",
  );
});

test("pane navigation preserves trailing whitespace; path bar still trims", () => {
  assert.equal(
    normalizeSftpPaneNavigationPath("/home/alice/dir ", "/home/alice"),
    "/home/alice/dir ",
  );
  assert.equal(
    normalizeSftpPaneNavigationPath("//server/share/logs ", "C:\\Users\\alice"),
    "\\\\server\\share\\logs ",
  );
  assert.equal(normalizeSftpNavigationPath("/home/alice/dir "), "/home/alice/dir");
  assert.equal(
    normalizeSftpNavigationPath("/home/alice/dir ", { trimWhitespace: false }),
    "/home/alice/dir ",
  );
});

test("breadcrumb segments keep WSL UNC roots intact", () => {
  assert.deepEqual(
    getSftpBreadcrumbSegments("\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaa"),
    {
      segments: [
        { label: "\\\\wsl.localhost\\Ubuntu-22.04", path: "\\\\wsl.localhost\\Ubuntu-22.04" },
        { label: "home", path: "\\\\wsl.localhost\\Ubuntu-22.04\\home" },
        { label: "aaa", path: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaa" },
      ],
      isWindowsDrive: false,
    },
  );
  assert.deepEqual(
    getSftpBreadcrumbSegments("C:\\Users\\alice"),
    {
      segments: [
        { label: "C:", path: "C:\\" },
        { label: "Users", path: "C:\\Users" },
        { label: "alice", path: "C:\\Users\\alice" },
      ],
      isWindowsDrive: true,
    },
  );
  assert.deepEqual(
    getSftpBreadcrumbSegments("/home/aaa"),
    {
      segments: [
        { label: "home", path: "/home" },
        { label: "aaa", path: "/home/aaa" },
      ],
      isWindowsDrive: false,
    },
  );
  assert.deepEqual(
    getSftpBreadcrumbSegments("//srv/share/logs"),
    {
      segments: [
        { label: "srv", path: "//srv" },
        { label: "share", path: "//srv/share" },
        { label: "logs", path: "//srv/share/logs" },
      ],
      isWindowsDrive: false,
    },
  );
  assert.deepEqual(
    getSftpBreadcrumbSegments("//srv/share\\logs"),
    {
      segments: [
        { label: "srv", path: "//srv" },
        { label: "share\\logs", path: "//srv/share\\logs" },
      ],
      isWindowsDrive: false,
    },
  );
  assert.deepEqual(
    getSftpBreadcrumbSegments("//wsl.localhost/Ubuntu-22.04/home/aaa", {
      acceptForwardSlashUnc: true,
    }),
    {
      segments: [
        { label: "\\\\wsl.localhost\\Ubuntu-22.04", path: "\\\\wsl.localhost\\Ubuntu-22.04" },
        { label: "home", path: "\\\\wsl.localhost\\Ubuntu-22.04\\home" },
        { label: "aaa", path: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaa" },
      ],
      isWindowsDrive: false,
    },
  );
});

test("concrete transfer target paths exclude temporary placeholders", () => {
  assert.equal(isConcreteTransferTargetPath({ targetPath: "/Users/alice/Downloads/report.pdf" }), true);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "C:\\Users\\alice\\Downloads\\report.pdf" }), true);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "(temp)" }), false);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "   " }), false);
});

test("SFTP filter clears when entering a different directory", () => {
  assert.equal(shouldClearSftpFilterForPathChange("/srv", "/srv/app"), true);
  assert.equal(getSftpFilterAfterPathChange("/srv", "/srv/app", "log"), "");
});

test("SFTP filter clears when navigating to the parent directory", () => {
  assert.equal(shouldClearSftpFilterForPathChange("/srv/app", getParentPath("/srv/app")), true);
  assert.equal(getSftpFilterAfterPathChange("/srv/app", getParentPath("/srv/app"), "dist"), "");
});

test("SFTP filter stays when refreshing the same directory", () => {
  assert.equal(shouldClearSftpFilterForPathChange("/srv/app", "/srv/app"), false);
  assert.equal(shouldClearSftpFilterForPathChange("/srv/app", "/srv/app/"), false);
  assert.equal(shouldClearSftpFilterForPathChange("C:\\Users\\alice", "c:/Users/alice"), false);
  assert.equal(
    shouldClearSftpFilterForPathChange("\\\\Server\\share\\folder", "\\\\server\\share\\folder\\"),
    false,
  );
  assert.equal(getSftpFilterAfterPathChange("/srv/app", "/srv/app", "log"), "log");
  assert.equal(getSftpFilterAfterPathChange("/srv/app", "/srv/app/", "log"), "log");
  assert.equal(getSftpFilterAfterPathChange("C:\\Users\\alice", "c:/Users/alice", "docs"), "docs");
});

test("SFTP filter restores when changed-directory navigation fails", () => {
  assert.equal(getSftpFilterAfterPathChangeError(true, "log", "typed-while-loading"), "log");
});

test("SFTP filter preserves in-flight edits when same-directory refresh fails", () => {
  assert.equal(getSftpFilterAfterPathChangeError(false, "log", "typed-while-loading"), "typed-while-loading");
});

test("getSftpPathRoot resolves the filesystem root for breadcrumb navigation", () => {
  assert.equal(getSftpPathRoot("/var/www"), "/");
  assert.equal(getSftpPathRoot("/"), "/");
  assert.equal(getSftpPathRoot("//srv/share/logs"), "/");
  assert.equal(getSftpPathRoot("C:\\Users\\alice"), "C:\\");
  assert.equal(getSftpPathRoot("D:/"), "D:\\");
  assert.equal(getSftpPathRoot("\\\\server\\share\\folder"), "\\\\server\\share");
  // Forward-slash //host/share stays POSIX unless UNC is explicitly accepted.
  assert.equal(getSftpPathRoot("//srv/share/logs"), "/");
  assert.equal(
    getSftpPathRoot("//srv/share/logs", { acceptForwardSlashUnc: true }),
    "\\\\srv\\share",
  );
});
