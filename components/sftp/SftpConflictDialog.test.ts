import test from "node:test";
import assert from "node:assert/strict";

import {
  canReplaceConflict,
  getSftpConflictDialogPresentation,
} from "./SftpConflictDialog.tsx";

test("does not offer replace when a file upload conflicts with an existing directory", () => {
  assert.equal(canReplaceConflict({
    isDirectory: false,
    existingType: "directory",
  }), false);
});

test("does not offer replace when a directory upload conflicts with an existing file", () => {
  assert.equal(canReplaceConflict({
    isDirectory: true,
    existingType: "file",
  }), false);
});

test("offers replace when a file upload conflicts with an existing file", () => {
  assert.equal(canReplaceConflict({
    isDirectory: false,
    existingType: "file",
  }), true);
});

test("offers replace when a directory upload conflicts with an existing symlink", () => {
  assert.equal(canReplaceConflict({
    isDirectory: true,
    existingType: "symlink",
  }), true);
});

test("offers replace when a file upload conflicts with an existing symlink", () => {
  assert.equal(canReplaceConflict({
    isDirectory: false,
    existingType: "symlink",
  }), true);
});

test("does not offer replace when a folder conflict has an unknown destination type", () => {
  assert.equal(canReplaceConflict({
    isDirectory: true,
    existingType: undefined,
  }), false);

  const presentation = getSftpConflictDialogPresentation({
    isDirectory: true,
    existingType: undefined,
  });
  assert.equal(presentation.descriptionKey, "sftp.conflict.folderUnknownDesc");
  assert.equal(presentation.showDirectoryReplaceWarning, false);
  assert.equal(presentation.replaceVariant, "default");
});

test("makes merge the safe primary action for a same-named folder conflict", () => {
  assert.deepEqual(getSftpConflictDialogPresentation({
    isDirectory: true,
    existingType: "directory",
  }), {
    titleKey: "sftp.conflict.folderTitle",
    descriptionKey: "sftp.conflict.folderDesc",
    showFileMetadata: false,
    showDirectoryReplaceWarning: true,
    mergeVariant: "default",
    replaceVariant: "outline",
  });
});

test("keeps the existing file conflict presentation unchanged", () => {
  assert.deepEqual(getSftpConflictDialogPresentation({
    isDirectory: false,
    existingType: "file",
  }), {
    titleKey: "sftp.conflict.title",
    descriptionKey: "sftp.conflict.desc",
    showFileMetadata: true,
    showDirectoryReplaceWarning: false,
    mergeVariant: "outline",
    replaceVariant: "default",
  });
});

test("does not show the directory deletion warning when replacing a symlink", () => {
  const presentation = getSftpConflictDialogPresentation({
    isDirectory: true,
    existingType: "symlink",
  });

  assert.equal(presentation.titleKey, "sftp.conflict.folderTitle");
  assert.equal(presentation.descriptionKey, "sftp.conflict.folderSymlinkDesc");
  assert.equal(presentation.showDirectoryReplaceWarning, false);
  assert.equal(presentation.replaceVariant, "default");
});

test("explains why a folder cannot merge with an existing file", () => {
  const presentation = getSftpConflictDialogPresentation({
    isDirectory: true,
    existingType: "file",
  });

  assert.equal(presentation.titleKey, "sftp.conflict.folderTitle");
  assert.equal(presentation.descriptionKey, "sftp.conflict.folderFileDesc");
  assert.equal(presentation.showDirectoryReplaceWarning, false);
  assert.equal(presentation.mergeVariant, "outline");
});
