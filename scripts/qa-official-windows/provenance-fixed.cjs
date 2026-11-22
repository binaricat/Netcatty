// Token is scoped to public release metadata/download in this step only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pinned = require('./fixed-candidate.json');
const root = path.resolve(process.env.QA_ROOT);
const artifact = path.resolve(process.env.QA_FIXED_ARTIFACT);
async function digest(file) { const hash = crypto.createHash('sha256'); for await (const part of fs.createReadStream(file)) hash.update(part); return hash.digest('hex'); }
async function main() {
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const build = JSON.parse(fs.readFileSync(path.join(artifact, 'build-provenance.json')));
  assert.equal(build.repository, pinned.repository); assert.equal(build.sha, pinned.sha);
  assert.equal(build.status, 'passed'); assert.equal(build.logReview.startsWith('passed'), true);
  assert.equal(build.run, process.env.GITHUB_RUN_ID); assert.equal(build.qaHead, process.env.QA_HEAD_SHA);
  assert.equal(build.versionMetadata, pinned.version);
  assert.equal(build.installerSha256, process.env.QA_EXPECTED_INSTALLER_SHA);
  assert.equal(await digest(path.join(artifact, pinned.installer)), process.env.QA_EXPECTED_INSTALLER_SHA);
  fs.copyFileSync(path.join(artifact, pinned.installer), path.join(root, pinned.installer));
  const response = await fetch(`https://api.github.com/repos/${pinned.repository}/releases/tags/${pinned.baseline.tag}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
  assert(response.ok);
  const release = await response.json(), asset = release.assets.find(a => a.id === pinned.baseline.asset);
  assert.equal(asset?.name, pinned.baseline.installer); assert.equal(asset.digest, `sha256:${pinned.baseline.sha256}`); assert.equal(asset.browser_download_url, pinned.baseline.url);
  const baseline = await fetch(pinned.baseline.url, { signal: AbortSignal.timeout(120000) });
  assert(baseline.ok);
  await pipeline(Readable.fromWeb(baseline.body), fs.createWriteStream(path.join(root, pinned.baseline.installer)));
  assert.equal(await digest(path.join(root, pinned.baseline.installer)), pinned.baseline.sha256);
  fs.writeFileSync(path.join(root, 'evidence/provenance.json'), JSON.stringify({ ...pinned, build, buildArtifactId: process.env.QA_BUILD_ARTIFACT_ID, buildArtifactDigest: process.env.QA_BUILD_ARTIFACT_DIGEST, baselineVerifiedSha256: pinned.baseline.sha256, testPackageOrigin: 'Exact trusted patch SHA, CI QA-built NSIS; unsigned/unreleased, not official release/updater acceptance' }, null, 2));
  console.log(JSON.stringify({ fixedSha: pinned.sha, installerSha256: build.installerSha256, baselineSha256: pinned.baseline.sha256, buildArtifact: process.env.QA_BUILD_ARTIFACT_ID }, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
