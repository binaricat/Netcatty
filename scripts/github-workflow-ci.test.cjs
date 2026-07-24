const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflowsDir = path.join(__dirname, "..", ".github", "workflows");
const readWorkflow = (name) => fs.readFileSync(path.join(workflowsDir, name), "utf8");

const testWorkflow = readWorkflow("test.yml");
const buildWorkflow = readWorkflow("build.yml");
const cursorWorkflow = readWorkflow("cursor-automation.yml");
const etWorkflow = readWorkflow("build-et-binaries.yml");

test("PR validation runs once per commit and includes a production build", () => {
  assert.match(testWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(testWorkflow, /branches:\s*\n\s*- "\*\*"/);
  assert.match(testWorkflow, /- name: Build\s*\n\s*run: npm run build/);
  assert.doesNotMatch(testWorkflow, /\n  mosh-windows-conpty:/);
});

test("package validation avoids duplicate branch runs and scopes PR builds", () => {
  assert.match(buildWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(buildWorkflow, /branches:\s*\n\s*- "\*\*"/);
  assert.match(buildWorkflow, /pull_request:\s*\n\s*paths:/);
  assert.doesNotMatch(buildWorkflow, /\n  dedupe:/);
  assert.doesNotMatch(buildWorkflow, /\n  dedupe-result:/);
  for (const packagedInput of [
    "electron/entitlements.mac.plist",
    "electron/bridges/terminalBridge.cjs",
    "infrastructure/config/terminalFlowConstants.*",
    "public/icon*",
    "scripts/afterPackMacUuid.cjs",
    "scripts/beforePackCursorSdk.cjs",
    "scripts/nodePtyConptyPatch.cjs",
    "skills/**",
  ]) {
    assert.ok(buildWorkflow.includes(`- "${packagedInput}"`), `${packagedInput} must trigger package validation`);
  }
});

test("Windows packaging reuses its dependency install for the ConPTY smoke test", () => {
  const packageMatrix = buildWorkflow.match(/\n  build:\n[\s\S]*?(?=\n  build-linux-x64:)/);
  assert.ok(packageMatrix, "build matrix job must exist before build-linux-x64");
  assert.match(packageMatrix[0], /Compile ConPTY test helpers/);
  assert.match(packageMatrix[0], /Test Mosh handshake through ConPTY/);
  assert.match(packageMatrix[0], /if: matrix\.name == 'windows'/);
});

test("stable releases propose Nix metadata through a pull request", () => {
  const nixJob = buildWorkflow.match(/\n  update-nix-release:\n[\s\S]*?(?=\n  homebrew-tap:)/);
  assert.ok(nixJob, "update-nix-release job must exist before homebrew-tap");
  assert.doesNotMatch(nixJob[0], /git push origin HEAD:\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(nixJob[0], /gh pr create/);
  assert.match(nixJob[0], /automation\/nix-release-/);
});

test("Codex fix publishing treats a moved PR head as a stale result", () => {
  const publishJob = cursorWorkflow.match(/\n  publish_codex_fix:\n[\s\S]*?(?=\n  own_rerequest_codex:)/);
  assert.ok(publishJob, "publish_codex_fix job must exist before own_rerequest_codex");
  assert.match(publishJob[0], /--force-with-lease/);
  assert.match(publishJob[0], /published=false/);
  assert.match(publishJob[0], /remote_after/);
  assert.match(publishJob[0], /exit 1/);
  assert.match(publishJob[0], /steps\.publish\.outputs\.published == 'true'/);
});

test("issue implementation publishing tolerates competing automation runs", () => {
  const publishJob = cursorWorkflow.match(/\n  publish_implement:\n[\s\S]*?(?=\n  codex_loop:)/);
  assert.ok(publishJob, "publish_implement job must exist before codex_loop");
  assert.match(publishJob[0], /--force-with-lease/);
  assert.match(publishJob[0], /published=false/);
  assert.match(publishJob[0], /remote_after/);
  assert.match(publishJob[0], /exit 1/);
  assert.match(publishJob[0], /steps\.publish\.outputs\.published == 'true'/);
  assert.match(publishJob[0], /status === 403 && createPermissionDenied/);
  assert.match(publishJob[0], /resource not accessible by integration/);
  assert.match(publishJob[0], /resource not accessible by personal access token/);
  assert.match(publishJob[0], /not permitted to create/);
});

test("ET binary validation runs once and retries transient container pulls", () => {
  assert.match(etWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(etWorkflow, /branches:\s*\n\s*- "\*\*"/);
  assert.match(etWorkflow, /Pull build container with retry/g);
  assert.match(etWorkflow, /docker pull/);
  assert.match(etWorkflow, /--pull=never/);
});

test("GitHub-owned actions use current Node 24 releases", () => {
  const workflows = fs.readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, readWorkflow(name)]);
  const expectedMajors = new Map([
    ["actions/checkout", "v7"],
    ["actions/setup-node", "v7"],
    ["actions/upload-artifact", "v7"],
    ["actions/download-artifact", "v8"],
    ["actions/github-script", "v9"],
  ]);

  for (const [name, source] of workflows) {
    for (const [action, major] of expectedMajors) {
      const uses = [...source.matchAll(new RegExp(`${action.replace("/", "\\/")}@(v\\d+)`, "g"))];
      for (const match of uses) {
        assert.equal(match[1], major, `${name} must use ${action}@${major}`);
      }
    }
  }
});
