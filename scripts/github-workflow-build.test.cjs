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
