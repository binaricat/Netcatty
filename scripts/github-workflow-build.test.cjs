const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const buildWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "build.yml"),
  "utf8",
);

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
  const installMentions = buildWorkflow.match(/libarchive-tools/g) ?? [];
  assert.equal(
    installMentions.length,
    2,
    "both Linux package jobs must install libarchive-tools for pacman metadata generation",
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
  // Buster (2.28) is stricter than the prior ubuntu-22.04 host (2.35) and
  // slightly older than the arm64 Bullseye container (2.31).
  const x64Job = buildWorkflow.match(
    /build-linux-x64:[\s\S]*?(?=\n  build-linux-arm64:)/,
  );
  assert.ok(x64Job, "build-linux-x64 job must be present before build-linux-arm64");
  assert.match(
    x64Job[0],
    /container:\s*\n\s*image:\s*debian:buster/,
    "Linux x64 package job must build inside debian:buster for glibc 2.28",
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
    /name:\s*Install build dependencies[\s\S]*?\n\s+shell:\s*bash\n\s+run:/,
    "Linux x64 install step must use bash so archive-mirror rewrite works under Buster",
  );
  assert.match(
    x64Job[0],
    /uv python install 3\.11/,
    "Linux x64 job must install Python >=3.8 for node-gyp 12 on Buster",
  );
  assert.equal(
    x64Job[0].includes("actions/setup-python@"),
    false,
    "Linux x64 job must not rely on actions/setup-python inside Buster",
  );
});
