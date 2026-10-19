const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("release notes include Arch pacman downloads for x64 and arm64", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-release-note-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const script = path.join(__dirname, "..", ".github", "scripts", "generate-release-note.js");
  execFileSync(process.execPath, [script], {
    cwd: tmp,
    env: {
      ...process.env,
      VERSION: "1.2.3",
      GITHUB_REF_NAME: "v1.2.3",
      GITHUB_REPOSITORY: "binaricat/Netcatty",
      GITHUB_SHA: "0123456789abcdef",
    },
    stdio: "pipe",
  });

  const notes = fs.readFileSync(path.join(tmp, "release_notes.md"), "utf8");
  assert.match(notes, /ArchPackage x64/);
  assert.match(notes, /ArchPackage arm64/);
  assert.match(
    notes,
    /https:\/\/github\.com\/binaricat\/Netcatty\/releases\/download\/v1\.2\.3\/Netcatty-1\.2\.3-linux-x64\.pacman/,
  );
  assert.match(
    notes,
    /https:\/\/github\.com\/binaricat\/Netcatty\/releases\/download\/v1\.2\.3\/Netcatty-1\.2\.3-linux-aarch64\.pacman/,
  );
  assert.match(notes, /Code signing policy/);
  assert.doesNotMatch(notes, /Release Highlights/);
  assert.match(
    notes,
    /Free code signing provided by SignPath\.io, certificate by SignPath Foundation/,
  );
  assert.match(
    notes,
    /https:\/\/github\.com\/binaricat\/Netcatty\/blob\/v1\.2\.3\/CODE_SIGNING_POLICY\.md/,
  );
});

test("release-specific highlights precede downloads without replacing generated metadata", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-release-note-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const script = path.join(__dirname, "..", ".github", "scripts", "generate-release-note.js");
  const highlights = fs.readFileSync(path.join(__dirname, "..", ".github", "release-notes", "v1.1.84.md"), "utf8").trim();
  execFileSync(process.execPath, [script], {
    cwd: tmp,
    env: { ...process.env, VERSION: "1.1.84", GITHUB_REF_NAME: "v1.1.84", GITHUB_REPOSITORY: "binaricat/Netcatty" },
    stdio: "pipe",
  });
  const notes = fs.readFileSync(path.join(tmp, "release_notes.md"), "utf8");
  assert.ok(notes.startsWith(`${highlights}\n\n## Download based on your OS:`));
  assert.match(notes, /releases\/download\/v1\.1\.84\/Netcatty-1\.1\.84-win-x64\.exe/);
  assert.match(notes, /blob\/v1\.1\.84\/CODE_SIGNING_POLICY\.md/);
  assert.equal(notes.match(/## ✨ Release Highlights/g).length, 1);
});
