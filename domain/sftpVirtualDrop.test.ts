import test from "node:test";
import assert from "node:assert/strict";

import {
  SFTP_VIRTUAL_FOLDER_UPLOAD_ERROR,
  isSftpVirtualFolderUploadError,
  isVirtualFolderPseudoFileDrop,
} from "./sftpVirtualDrop.ts";

const fileEntry = (overrides: Partial<Parameters<typeof isVirtualFolderPseudoFileDrop>[0]> = {}) => ({
  relativePath: "folder",
  isDirectory: false,
  localPath: undefined,
  size: 0,
  file: { size: 0 },
  ...overrides,
});

test("detects path-less extension-less empty pseudo-files as archive folder drags", () => {
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry()), true);
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ size: undefined, file: null })), true);
});

test("keeps real directory entries on the folder upload flow", () => {
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ isDirectory: true })), false);
});

test("keeps path-backed drops on the normal flow", () => {
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ localPath: "\\Temp\\folder" })), false);
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ localPath: "/tmp/folder" })), false);
});

test("keeps nested enumerated children and dotted names on the normal flow", () => {
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ relativePath: "folder/notes" })), false);
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ relativePath: "backup 2.0" })), false);
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ relativePath: "" })), false);
});

test("keeps path-less virtual files that still carry content", () => {
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ relativePath: "Makefile", size: 120, file: { size: 120 } })), false);
  assert.equal(isVirtualFolderPseudoFileDrop(fileEntry({ relativePath: "logo", size: 4096, file: { size: 4096 } })), false);
});

test("sentinel helpers only match the exact marker", () => {
  assert.equal(isSftpVirtualFolderUploadError(SFTP_VIRTUAL_FOLDER_UPLOAD_ERROR), true);
  assert.equal(isSftpVirtualFolderUploadError("stream error"), false);
  assert.equal(isSftpVirtualFolderUploadError(undefined), false);
});
