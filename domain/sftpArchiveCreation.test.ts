import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareSftpArchiveSelection,
  validateSftpArchiveName,
  withSftpArchiveExtension,
} from "./sftpArchiveCreation.ts";

test("archive selection keeps a single folder beside its output", () => {
  assert.deepEqual(prepareSftpArchiveSelection(["/root/docker"]), {
    directory: "/root", paths: ["docker"], defaultName: "docker",
  });
});

test("tree selections use a common parent and omit duplicate descendants", () => {
  assert.deepEqual(prepareSftpArchiveSelection([
    "/srv/app/logs/old.txt", "/srv/app/logs", "/srv/config/app.json", "/srv/app/logs",
  ]), {
    directory: "/srv", paths: ["app/logs", "config/app.json"], defaultName: "srv",
  });
  assert.deepEqual(prepareSftpArchiveSelection(["/one/file", "/two/file"]), {
    directory: "/", paths: ["one/file", "two/file"], defaultName: "archive",
  });
  assert.deepEqual(prepareSftpArchiveSelection(["/a/foo", "/a/foobar"]), {
    directory: "/a", paths: ["foo", "foobar"], defaultName: "a",
  });
});

test("archive paths preserve literal shell metacharacters and Unicode", () => {
  const name = "中文 ' $(touch marker) [*]";
  assert.deepEqual(prepareSftpArchiveSelection([`/data/${name}`]), {
    directory: "/data", paths: [name], defaultName: name,
  });
});

test("invalid selections cannot archive a root or escape through parent segments", () => {
  for (const selection of [[], ["/"], ["relative"], ["/a/../b"], ["/a/./b"], ["/a\nb"], ["/a\0b"], ["C:\\data"]]) {
    assert.throws(() => prepareSftpArchiveSelection(selection), /invalidSelection/);
  }
});

test("archive format changes keep one suffix and avoid a selected archive's default name", () => {
  assert.equal(withSftpArchiveExtension("docker", "tar.gz"), "docker.tar.gz");
  assert.equal(withSftpArchiveExtension("docker.tar.gz", "zip"), "docker.zip");
  assert.equal(withSftpArchiveExtension("logs.ZIP", "zip"), "logs.ZIP");
  const selection = prepareSftpArchiveSelection(["/tmp/backup.zip"]);
  assert.notEqual(withSftpArchiveExtension(selection.defaultName, "zip"), "backup.zip");
});

test("archive names require a single filename and the selected extension", () => {
  for (const name of ["", " ", ".", "..", "../file.zip", "/file.zip", "folder\\file.zip", "bad\n.zip", "bad\0.zip"]) {
    assert.equal(validateSftpArchiveName(name, "zip"), "sftp.archive.invalidName");
  }
  for (const name of ["file", "file.tar.gz", ".zip"]) {
    assert.equal(validateSftpArchiveName(name, "zip"), "sftp.archive.invalidExtension");
  }
  assert.equal(validateSftpArchiveName("备份 ' [1].zip", "zip"), null);
  assert.equal(validateSftpArchiveName("-backup.tar.gz", "tar.gz"), null);
});
