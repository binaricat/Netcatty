// The GitHub token exists only in this downloader process, never in Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const pinned = require(path.resolve(__dirname, process.env.QA_CANDIDATE || 'candidate.json'));
async function main() {
  assert(process.env.GH_TOKEN, 'Downloader needs actions:read token');
  const root = path.resolve(process.env.QA_ROOT);
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const base = `https://api.github.com/repos/${pinned.repository}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(route) {
    const response = await fetch(base + route, { headers });
    assert(response.ok, `GitHub metadata HTTP ${response.status}`);
    return response.json();
  }
  const run = await api(`/actions/runs/${pinned.run}`);
  assert.equal(run.head_sha, pinned.sha);
  assert.equal(run.repository.id, pinned.repositoryId);
  assert.equal(run.head_repository.id, pinned.repositoryId);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.event, 'push');
  assert.equal(run.path, '.github/workflows/build.yml');
  const jobs = await api(`/actions/runs/${pinned.run}/jobs?per_page=100`);
  const job = jobs.jobs.find(item => item.name === 'build-linux-x64');
  assert.equal(job?.conclusion, 'success', 'Official Linux job must succeed');
  const artifact = await api(`/actions/artifacts/${pinned.artifact}`);
  assert.equal(artifact.name, pinned.name);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run.id, pinned.run);
  assert.equal(artifact.workflow_run.head_sha, pinned.sha);
  assert.equal(artifact.workflow_run.head_repository_id, pinned.repositoryId);
  assert.equal(artifact.digest, `sha256:${pinned.zipSha256}`);
  const response = await fetch(`${base}/actions/artifacts/${pinned.artifact}/zip`, { headers, redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.protocol, 'https:');
  // Deliberately omit authorization from the redirected blob request.
  const archive = await fetch(location);
  assert(archive.ok, `Artifact download HTTP ${archive.status}`);
  const zip = path.join(root, 'official.zip');
  await pipeline(Readable.fromWeb(archive.body), fs.createWriteStream(zip));
  async function digest(file) {
    const hash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
  }
  assert.equal(await digest(zip), pinned.zipSha256);
  // Extract just the named deb, without trusting archive paths or executing postinst.
  execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); n=sys.argv[2]; assert z.namelist().count(n)==1; open(sys.argv[3],"wb").write(z.read(n))', zip, pinned.deb, path.join(root, pinned.deb)]);
  const deb = path.join(root, pinned.deb);
  assert.equal(await digest(deb), pinned.debSha256);
  assert.equal(execFileSync('dpkg-deb', ['-f', deb, 'Architecture'], { encoding: 'utf8' }).trim(), 'amd64');
  execFileSync('dpkg-deb', ['-x', deb, path.join(root, 'package')]);
  fs.writeFileSync(path.join(root, 'evidence/provenance.json'), JSON.stringify({ ...pinned, officialLinuxJob: job.id, officialRunStatus: run.status, mode: 'rootless deb extraction; installer scripts not executed', verifiedAt: new Date().toISOString() }, null, 2));
  console.log(`Verified official ${pinned.sha}, run ${pinned.run}, artifact ${pinned.artifact}, deb SHA-256 ${pinned.debSha256}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
