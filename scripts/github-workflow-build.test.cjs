const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const buildWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "build.yml"),
  "utf8",
);
const etLinuxScript = fs.readFileSync(path.join(__dirname, "build-et", "build-linux.sh"), "utf8");
const etMacScript = fs.readFileSync(path.join(__dirname, "build-et", "build-macos.sh"), "utf8");

test("build workflow no longer installs removed legacy agent binaries", () => {
  for (const stale of [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/sdk",
    "@zed-industries/codex-acp",
    "codex-acp",
  ]) {
    assert.equal(
      buildWorkflow.includes(stale),
      false,
      `build workflow must not reference removed legacy package: ${stale}`,
    );
  }
});

test("build workflow uploads and releases Arch pacman artifacts", () => {
  const releaseUploadPatterns = buildWorkflow.match(/release\/\*\.pacman/g) ?? [];
  assert.equal(
    releaseUploadPatterns.length,
    3,
    "mac/windows aggregate upload plus both Linux jobs must include release/*.pacman",
  );
  assert.ok(
    buildWorkflow.includes("artifacts/*.pacman"),
    "GitHub release file list must include downloaded pacman artifacts",
  );
});

test("build workflow installs bsdtar for Arch pacman packaging", () => {
  // arm64 (Debian) uses libarchive-tools; x64 (AlmaLinux 8) uses libarchive.
  // Both packages provide bsdtar for electron-builder pacman metadata.
  assert.match(
    buildWorkflow,
    /build-linux-arm64:[\s\S]*libarchive-tools/,
    "Linux arm64 package job must install libarchive-tools for pacman metadata generation",
  );
  assert.match(
    buildWorkflow,
    /build-linux-x64:[\s\S]*\blibarchive\b/,
    "Linux x64 package job must install libarchive (bsdtar) for pacman metadata generation",
  );
  // Pin a filename that actually exists on archive.debian.org so CI does not
  // 404 when AlmaLinux's libarchive RPM ships without /usr/bin/bsdtar.
  assert.match(
    buildWorkflow,
    /libarchive-tools_3\.3\.3-4\+deb10u1_amd64\.deb/,
    "Linux x64 job must download a published Buster libarchive-tools deb for bsdtar",
  );
});

test("build workflow verifies RPM artifacts for both Linux architectures", () => {
  assert.ok(
    buildWorkflow.includes("bash scripts/verify-linux-rpm-artifact.sh x86_64"),
    "Linux x64 package job must verify the RPM artifact",
  );
  assert.ok(
    buildWorkflow.includes("bash scripts/verify-linux-rpm-artifact.sh aarch64"),
    "Linux arm64 package job must verify the RPM artifact",
  );
});

test("build workflow builds Linux x64 native modules in a glibc 2.28 container", () => {
  // Keep x64 packages loadable on RHEL 8 / UOS / Deepin (see #2062).
  // AlmaLinux 8 (glibc 2.28) replaces debian:buster so we still target the
  // same glibc floor, but gcc-toolset-13 can compile Electron 42's -std=gnu++20
  // (Buster's g++ 8 cannot).
  const x64Job = buildWorkflow.match(
    /build-linux-x64:[\s\S]*?(?=\n  build-linux-arm64:)/,
  );
  assert.ok(x64Job, "build-linux-x64 job must be present before build-linux-arm64");
  assert.match(
    x64Job[0],
    /container:\s*\n\s*image:\s*almalinux:8/,
    "Linux x64 package job must build inside almalinux:8 for glibc 2.28 + modern GCC",
  );
  assert.equal(
    x64Job[0].includes("debian:buster"),
    false,
    "Linux x64 package job must not use debian:buster (g++ 8 cannot build gnu++20 natives)",
  );
  assert.equal(
    x64Job[0].includes("ubuntu-22.04"),
    false,
    "Linux x64 package job must not build on the host ubuntu-22.04 glibc",
  );
  assert.equal(
    x64Job[0].includes("actions/setup-node@"),
    false,
    "Linux x64 package job must install Node inside the container like arm64",
  );
  assert.match(
    x64Job[0],
    /gcc-toolset-13-gcc-c\+\+/,
    "Linux x64 job must install gcc-toolset-13 for C++20 native rebuilds",
  );
  assert.match(
    x64Job[0],
    /static-libstdc\+\+/,
    "Linux x64 job must static-link libstdc++ so RHEL 8 stock libstdc++ is enough",
  );
  assert.match(
    x64Job[0],
    /unset LD_LIBRARY_PATH/,
    "Linux x64 job must wrap packaging tools to clear portable-fpm LD_LIBRARY_PATH",
  );
  assert.match(
    x64Job[0],
    /for cmd in rpmbuild bsdtar/,
    "Linux x64 job must wrap both rpmbuild and bsdtar for rpm/pacman targets",
  );
  assert.match(
    x64Job[0],
    /python3\.11/,
    "Linux x64 job must use Python >=3.8 for node-gyp 12",
  );
  assert.equal(
    x64Job[0].includes("actions/setup-python@"),
    false,
    "Linux x64 job must not rely on actions/setup-python inside the glibc container",
  );
});

test("et binary build scripts retry dependency configure and pin ninja", () => {
  for (const [name, script] of [
    ["linux", etLinuxScript],
    ["macos", etMacScript],
  ]) {
    assert.match(script, /retry_command\(\)/, `${name} et build must retry transient dependency failures`);
    assert.match(script, /retry_command cmake -S/, `${name} et build must retry CMake configure`);
    assert.match(script, /NINJA_BIN=\$\(command -v ninja\)/, `${name} et build must resolve ninja before configure`);
    assert.match(script, /-DCMAKE_MAKE_PROGRAM="\$NINJA_BIN"/, `${name} et build must pass the resolved ninja path`);
  }
});
