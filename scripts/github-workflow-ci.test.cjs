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
const appBuilderPatch = fs.readFileSync(
  path.join(__dirname, "..", "patches", "app-builder-lib+26.15.2.patch"),
  "utf8",
);
const windowsEtBuild = fs.readFileSync(
  path.join(__dirname, "build-et", "build-windows.ps1"),
  "utf8",
);
const homebrewBump = fs.readFileSync(
  path.join(__dirname, "..", ".github", "scripts", "bump-homebrew-cask.sh"),
  "utf8",
);

const pullRequestPaths = buildWorkflow
  .match(/pull_request:\s*\n\s*paths:\s*\n((?:\s+- "[^"]+"\s*\n)+)/)?.[1]
  ?.match(/^\s+- "([^"]+)"$/gm)
  ?.map((line) => line.match(/^\s+- "([^"]+)"$/)?.[1])
  .filter(Boolean);

// Portable glob matcher for Node >=22 (path.matchesGlob only landed in 22.5).
const matchesGlob = (filePath, pattern) => {
  let regex = "^";
  for (let i = 0; i < pattern.length; ) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
      continue;
    }
    if (pattern[i] === "*") {
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (pattern[i] === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    regex += pattern[i].replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    i += 1;
  }
  regex += "$";
  return new RegExp(regex).test(filePath);
};

const triggersPackageValidation = (filePath) => {
  assert.ok(pullRequestPaths, "package workflow pull_request paths must be readable");
  return pullRequestPaths.reduce((included, pattern) => {
    const excluded = pattern.startsWith("!");
    const glob = excluded ? pattern.slice(1) : pattern;
    return matchesGlob(filePath, glob) ? !excluded : included;
  }, false);
};

test("PR validation runs once per commit and includes a production build", () => {
  assert.match(testWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(testWorkflow, /branches:\s*\n\s*- "\*\*"/);
  assert.match(testWorkflow, /- name: Build\s*\n\s*run: npm run build/);
  assert.doesNotMatch(testWorkflow, /\n  mosh-windows-conpty:/);
});

test("package release concurrency is isolated per tag", () => {
  assert.match(buildWorkflow, /format\('release-\{0\}', github\.ref\)/);
  assert.doesNotMatch(buildWorkflow, /&& 'release' \|\| github\.ref/);
});

test("manual package validations do not share push concurrency", () => {
  assert.match(
    buildWorkflow,
    /github\.event_name == 'workflow_dispatch' && format\('manual-\{0\}', github\.run_id\)/,
  );
  assert.ok(
    buildWorkflow.indexOf("format('release-{0}', github.ref)") <
      buildWorkflow.indexOf("format('manual-{0}', github.run_id)"),
    "publishing a tag manually must still share that tag's release group",
  );
});

test("package validation avoids duplicate branch runs and scopes PR builds", () => {
  assert.match(buildWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(buildWorkflow, /branches:\s*\n\s*- "\*\*"/);
  assert.match(buildWorkflow, /pull_request:\s*\n\s*paths:/);
  assert.doesNotMatch(buildWorkflow, /\n  dedupe:/);
  assert.doesNotMatch(buildWorkflow, /\n  dedupe-result:/);
  for (const packagedInput of [
    "electron/**",
    "infrastructure/config/terminalFlowConstants.*",
    "public/icon*",
    "scripts/afterPackMacUuid.cjs",
    "scripts/beforePackCursorSdk.cjs",
    "scripts/nodePtyConptyPatch.cjs",
    "scripts/linux/**",
    "skills/**",
  ]) {
    assert.ok(buildWorkflow.includes(`- "${packagedInput}"`), `${packagedInput} must trigger package validation`);
  }

  for (const excludedTestInput of [
    "!electron/**/*.test.*",
    "!electron/**/*.spec.*",
    "!electron/**/__tests__/**",
    "!electron/**/test/**",
    "!electron/**/tests/**",
    "!electron/**/example/**",
    "!electron/**/examples/**",
    "!electron/plugins/fixtures/**",
  ]) {
    assert.ok(buildWorkflow.includes(`- "${excludedTestInput}"`), `${excludedTestInput} must stay out of package validation`);
  }

  assert.ok(
    buildWorkflow.indexOf('- "electron/**"') < buildWorkflow.indexOf('- "!electron/**/*.test.*"'),
    "packaged Electron files must be included before test-only exclusions",
  );

  for (const packagedPath of [
    "electron/main.cjs",
    "electron/entitlements.mac.plist",
    "electron/bridges/terminalBridge.cjs",
    "electron/preload/api.cjs",
    "electron/shared/protocol.cjs",
    "electron/mcp/server.cjs",
    "electron/plugins/pluginManager.cjs",
    "scripts/linux/after-install.tpl",
  ]) {
    assert.equal(triggersPackageValidation(packagedPath), true, `${packagedPath} must trigger package validation`);
  }

  for (const testOnlyPath of [
    "electron/main.test.cjs",
    "electron/bridges/moshHandshake.test.cjs",
    "electron/plugins/pluginManager.test.cjs",
    "electron/plugins/fixtures/example/plugin.cjs",
  ]) {
    assert.equal(triggersPackageValidation(testOnlyPath), false, `${testOnlyPath} must not trigger package validation`);
  }
});

test("Windows packaging reuses its dependency install for the ConPTY smoke test", () => {
  const packageMatrix = buildWorkflow.match(/\n  build:\n[\s\S]*?(?=\n  build-linux-x64:)/);
  assert.ok(packageMatrix, "build matrix job must exist before build-linux-x64");
  assert.match(packageMatrix[0], /Compile ConPTY test helpers/);
  assert.match(packageMatrix[0], /Test Mosh handshake through ConPTY/);
  assert.match(packageMatrix[0], /if: matrix\.name == 'windows'/);
  assert.match(packageMatrix[0], /Restore Electron download cache/);
  assert.match(packageMatrix[0], /actions\/cache@v6/);
  assert.match(packageMatrix[0], /node electron\/bridges\/terminalBridge\.moshConpty\.integration\.cjs/);
});

test("stable releases propose Nix metadata through a pull request", () => {
  const nixJob = buildWorkflow.match(/\n  update-nix-release:\n[\s\S]*?(?=\n  homebrew-tap:)/);
  assert.ok(nixJob, "update-nix-release job must exist before homebrew-tap");
  assert.doesNotMatch(nixJob[0], /git push origin HEAD:\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(nixJob[0], /gh pr create/);
  assert.match(nixJob[0], /automation\/nix-release-/);
  assert.match(nixJob[0], /candidate_tree/);
  assert.match(nixJob[0], /remote_tree/);
  assert.match(nixJob[0], /branch_prefix/);
  assert.match(nixJob[0], /headRefName/);
  assert.match(nixJob[0], /headRepositoryOwner\.login == \$owner/);
  assert.match(nixJob[0], /desired_nix_blob="\$\(git hash-object -w nix\/release\.nix\)"/);
  assert.match(nixJob[0], /existing_branch/);
  assert.match(nixJob[0], /refs\/heads\/\$\{existing_branch\}/);
  assert.match(nixJob[0], /git cat-file blob "\$desired_nix_blob" > nix\/release\.nix/);
  assert.match(nixJob[0], /git diff --quiet -- nix\/release\.nix/);
  assert.match(nixJob[0], /while IFS='\|' read -r existing existing_branch/);
  assert.match(nixJob[0], /done <<<"\$existing_prs"/);
  assert.doesNotMatch(nixJob[0], /\.\[0\] \/\//);
  assert.match(
    nixJob[0],
    /--force-with-lease="refs\/heads\/\$\{existing_branch\}:\$\{remote_before\}"/,
  );
  assert.match(nixJob[0], /origin "HEAD:\$\{existing_branch\}"/);
  assert.match(nixJob[0], /gh api --method GET "repos\/\$\{GITHUB_REPOSITORY\}\/pulls"/);
  assert.match(nixJob[0], /-f head="\$\{REPO_OWNER\}:\$\{branch\}"/);
  assert.doesNotMatch(nixJob[0], /gh pr list[^\n]*--head "\$\{REPO_OWNER\}:/);
  assert.match(nixJob[0], /\.headRefName == \$prefix/);
  assert.doesNotMatch(
    nixJob[0],
    /\.headRefName \| startswith\(\$prefix\)/,
    "v1.2.30 must not be treated as a v1.2.3 metadata branch",
  );
  assert.match(nixJob[0], /test\("\^\[0-9\]\+-\[0-9\]\+\$"\)/);
  assert.match(nixJob[0], /suffix=.*branch_prefix/);
  assert.match(nixJob[0], /\[\[ "\$suffix" =~ \^\[0-9\]\+-\[0-9\]\+\$ \]\]/);
  assert.match(nixJob[0], /ls-remote --heads origin "refs\/heads\/\$\{branch_prefix\}\*"/);
  assert.match(nixJob[0], /GITHUB_RUN_ID/);
  assert.match(nixJob[0], /--force-with-lease="refs\/heads\/\$\{branch\}:"/);
  assert.doesNotMatch(nixJob[0], /--force-with-lease="\$\{branch\}:\$\{expected\}"/);
  assert.ok(
    nixJob[0].indexOf('gh pr list') < nixJob[0].indexOf('git switch -C'),
    "an existing Nix PR must be reused before rebuilding its branch",
  );
});

test("Homebrew tap updates retry push races without downgrading newer releases", () => {
  assert.match(homebrewBump, /MAX_PUSH_ATTEMPTS/);
  assert.match(homebrewBump, /version_is_newer/);
  assert.match(homebrewBump, /git fetch --depth=1 origin main/);
  assert.match(homebrewBump, /git switch -C main origin\/main/);
  assert.match(homebrewBump, /for \(\(attempt=1; attempt<=MAX_PUSH_ATTEMPTS; attempt\+\+\)\)/);
  assert.match(homebrewBump, /if version_is_newer "\$current_version" "\$VERSION"/);
  assert.match(homebrewBump, /if push_output="\$\(git push origin HEAD:main 2>&1\)"/);
  assert.match(homebrewBump, /grep -Eqi 'non-fast-forward\|fetch first' <<<"\$push_output"/);
  assert.doesNotMatch(homebrewBump, /2> >\(tee/);
  assert.match(homebrewBump, /Tap already has newer version/);
  assert.match(homebrewBump, /Push raced with another release/);
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
  assert.match(publishJob[0], /candidate_tree/);
  assert.match(publishJob[0], /remote_tree/);
  assert.match(publishJob[0], /refs\/heads\/\$\{BRANCH\}:/);
  assert.match(publishJob[0], /fetch --depth=1 origin[\s\\]*"\+refs\/heads\/\$\{BRANCH\}:refs\/remotes\/origin\/\$\{BRANCH\}"/);
  assert.match(publishJob[0], /live_after/);
  assert.match(publishJob[0], /changed while it was being checked/);
  assert.match(publishJob[0], /reuse it without rewriting history/);
  assert.doesNotMatch(publishJob[0], /:\$\{expected\}/);
  assert.doesNotMatch(publishJob[0], /if \[\[ -n "\$expected" \]\]/);
  assert.doesNotMatch(publishJob[0], /published=false/);
  assert.match(publishJob[0], /remote_after/);
  assert.match(publishJob[0], /exit 1/);
  assert.match(publishJob[0], /echo "handoff=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    publishJob[0],
    /if: failure\(\) && steps\.publish\.outputs\.handoff == 'true'/,
  );
  assert.doesNotMatch(publishJob[0], /steps\.publish\.outcome == 'failure'/);
  assert.match(publishJob[0], /labels: \['ready-for-human'\]/);
  assert.match(publishJob[0], /could not safely publish the implementation branch/);
  assert.match(publishJob[0], /cursor-publish-handoff:/);
  assert.match(publishJob[0], /github\.paginate\(github\.rest\.issues\.listComments/);
  assert.match(publishJob[0], /steps\.publish\.outputs\.published == 'true'/);
  assert.match(publishJob[0], /group: cursor-codex-head-/);
  assert.match(publishJob[0], /status === 403 && createPermissionDenied/);
  assert.match(publishJob[0], /resource not accessible by integration/);
  assert.match(publishJob[0], /resource not accessible by personal access token/);
  assert.match(publishJob[0], /not permitted to create/);
});

test("reused automation PRs still receive labels and one source-issue backlink", () => {
  const openPr = cursorWorkflow.match(
    /\n      - name: Open draft PR[\s\S]*?(?=\n      - name: Request Codex review on implement PR)/,
  );
  assert.ok(openPr, "open-PR step must exist before Codex review request");
  assert.match(openPr[0], /github\.rest\.issues\.addLabels/);
  assert.match(openPr[0], /github\.paginate\(github\.rest\.issues\.listComments/);
  assert.match(openPr[0], /auto\.hasAutomationPullRequestBacklink/);
  assert.doesNotMatch(openPr[0], /if \(created\)/);
});

test("reused implementation PRs do not duplicate Codex requests for the same head", () => {
  const requestCodex = cursorWorkflow.match(
    /\n      - name: Request Codex review on implement PR[\s\S]*?(?=\n  codex_loop:)/,
  );
  assert.ok(requestCodex, "implement Codex request step must exist before codex_loop");
  assert.match(requestCodex[0], /github\.paginate\(github\.rest\.issues\.listComments/);
  assert.match(requestCodex[0], /github\.rest\.pulls\.get/);
  assert.match(requestCodex[0], /auto\.shouldSkipExternalCodexRerequest/);
  assert.match(requestCodex[0], /headSha/);
  assert.match(requestCodex[0], /OWN_ACTORS/);
  assert.doesNotMatch(requestCodex[0], /process\.env\.HEAD_SHA/);
});

test("all own-PR Codex request paths serialize on the head branch", () => {
  const codexLoop = cursorWorkflow.match(/\n  codex_loop:\n[\s\S]*?(?=\n  publish_codex_fix:)/);
  const ownRerequest = cursorWorkflow.match(/\n  own_rerequest_codex:\n[\s\S]*?(?=\n  external_rerequest_codex:)/);
  assert.ok(codexLoop, "codex_loop job must exist before publish_codex_fix");
  assert.ok(ownRerequest, "own_rerequest_codex must exist before external_rerequest_codex");
  assert.match(cursorWorkflow, /head_ref: \$\{\{ steps\.decide\.outputs\.head_ref \}\}/);
  assert.match(codexLoop[0], /group: cursor-codex-head-/);
  assert.match(ownRerequest[0], /group: cursor-codex-head-/);
  assert.match(codexLoop[0], /needs\.route\.outputs\.head_ref/);
  assert.match(ownRerequest[0], /needs\.route\.outputs\.head_ref/);
  assert.match(cursorWorkflow, /head_ref: pr\.head\?\.ref \|\| ''/);
  assert.match(
    cursorWorkflow,
    /issue_comment[\s\S]*?github\.rest\.pulls\.get[\s\S]*?head_ref: pr\.head\?\.ref \|\| ''/,
  );
});

test("scheduled Codex polling ignores review comments remapped from old heads", () => {
  const pollJob = cursorWorkflow.match(/\n  codex_poll:\n[\s\S]*$/);
  assert.ok(pollJob, "codex_poll job must exist");
  assert.match(pollJob[0], /auto\.filterCodexReviewCommentsForHead\(\s*reviewComments,\s*pr\.head\.sha/);
  assert.doesNotMatch(pollJob[0], /c\.commit_id \|\| c\.original_commit_id/);
});

test("clean Codex handoff updates labels without GraphQL-only organization scopes", () => {
  const markReady = cursorWorkflow.match(/\n      - name: Mark PR ready after clean Codex[\s\S]*?(?=\n      - name: Give up after max rounds)/);
  assert.ok(markReady, "mark-ready step must exist before give-up step");
  assert.match(markReady[0], /gh api/);
  assert.match(markReady[0], /issues\/\$\{PULL_NUMBER\}\/labels/);
  assert.match(markReady[0], /automation%3Acodex-loop/);
  assert.match(markReady[0], /ready-for-human/);
  assert.match(markReady[0], /labels\[\]=automation:codex-clean/);
  assert.match(markReady[0], /labels\[\]=automation:bot-pr/);
  assert.doesNotMatch(markReady[0], /nextCodexTerminalLabels/);
  assert.doesNotMatch(markReady[0], /"PUT"/);
  assert.doesNotMatch(markReady[0], /gh pr edit/);
});

test("permission handoffs use the established ready-for-human label", () => {
  assert.doesNotMatch(cursorWorkflow, /automation:needs-human/);
  assert.match(cursorWorkflow, /labels: \['ready-for-human'\]/);
  assert.match(cursorWorkflow, /-f 'labels\[\]=ready-for-human'/);
});

test("ET binary validation runs once and retries transient container pulls", () => {
  assert.match(etWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(etWorkflow, /branches:\s*\n\s*- "\*\*"/);
  assert.match(etWorkflow, /Pull build container with retry/g);
  assert.match(etWorkflow, /docker pull/);
  assert.match(etWorkflow, /--pull=never/);
  assert.match(etWorkflow, /Restore vcpkg download cache/g);
  assert.match(etWorkflow, /VCPKG_DOWNLOADS/g);
  assert.match(windowsEtBuild, /Invoke-WithRetry/);
});

test("ET pull requests reuse exact platform builds without weakening release builds", () => {
  const buildJobs = [
    ["linux-x64", etWorkflow.match(/\n  build-linux-x64:\n[\s\S]*?(?=\n  build-linux-arm64:)/)?.[0]],
    ["linux-arm64", etWorkflow.match(/\n  build-linux-arm64:\n[\s\S]*?(?=\n  build-macos-universal:)/)?.[0]],
    ["macos-universal", etWorkflow.match(/\n  build-macos-universal:\n[\s\S]*?(?=\n  build-windows-x64:)/)?.[0]],
    ["windows-x64", etWorkflow.match(/\n  build-windows-x64:\n[\s\S]*?(?=\n  # ------------------------------------------------------------------\n  # Windows arm64)/)?.[0]],
  ];
  const skipOnExactPrCacheHit =
    "if: github.event_name != 'pull_request' || steps.et-build-cache.outputs.cache-hit != 'true'";

  for (const [platform, job] of buildJobs) {
    assert.ok(job, `${platform} ET build job must be readable`);
    assert.match(job, /- name: Restore cached PR build\s*\n\s*id: et-build-cache/);
    assert.match(job, /if: github\.event_name == 'pull_request'/);
    assert.match(job, /path: out\//);
    assert.match(
      job,
      /key: et-pr-build-v1-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ env\.ET_REF \}\}-\$\{\{ hashFiles\('\.github\/workflows\/build-et-binaries\.yml', 'scripts\/build-et\/\*\*'\) \}\}/,
    );
    assert.ok(job.includes(skipOnExactPrCacheHit), `${platform} must skip compilation on an exact PR cache hit`);
    assert.match(
      job,
      /- name: Upload artifact[\s\S]*?if-no-files-found: error/,
      `${platform} must fail instead of publishing an empty cached build`,
    );
  }

  assert.equal(
    (etWorkflow.match(new RegExp(skipOnExactPrCacheHit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length,
    14,
    "all dependency setup and compilation steps must be skipped when the exact PR build is cached",
  );
  assert.doesNotMatch(
    etWorkflow.match(/\n  release:\n[\s\S]*$/)?.[0] ?? "",
    /et-build-cache|Restore cached PR build/,
    "manual releases must never reuse PR build outputs",
  );
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
    ["actions/cache", "v6"],
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

test("electron-builder retries Fetch API server errors", () => {
  assert.match(appBuilderPatch, /e\?\.response\?\.status/);
  assert.match(appBuilderPatch, /responseStatus >= 500/);
});
