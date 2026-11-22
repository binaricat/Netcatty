// Only this metadata/download step receives the built-in Actions read token.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const pinned = require('./candidate.json');
const root = path.resolve(process.env.QA_ROOT);
const arch = process.env.QA_ARCH;
async function digest(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
async function main() {
  assert.equal(process.platform, 'darwin'); assert(pinned.dmgs[arch]); assert(process.env.GH_TOKEN);
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const base = `https://api.github.com/repos/${pinned.repository}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(route) { const r = await fetch(base + route, { headers, signal: AbortSignal.timeout(30000) }); assert(r.ok, `Metadata HTTP ${r.status}`); return r.json(); }
  const run = await api(`/actions/runs/${pinned.run}`);
  assert.equal(run.head_sha, pinned.sha); assert.equal(run.repository.id, pinned.repositoryId); assert.equal(run.head_repository.id, pinned.repositoryId);
  assert.equal(run.event, 'push'); assert.equal(run.head_branch, 'main'); assert.equal(run.path, '.github/workflows/build.yml'); assert.equal(run.conclusion, 'success');
  const jobs = await api(`/actions/runs/${pinned.run}/jobs?per_page=100`);
  const job = jobs.jobs.find(j => j.id === pinned.buildJob);
  assert.equal(job?.name, 'build-macos'); assert.equal(job.conclusion, 'success');
  const artifact = await api(`/actions/artifacts/${pinned.artifact}`);
  assert.equal(artifact.name, pinned.name); assert.equal(artifact.expired, false); assert(Date.parse(artifact.expires_at) > Date.now());
  assert.equal(artifact.size_in_bytes, pinned.archiveBytes); assert.equal(artifact.digest, `sha256:${pinned.zipSha256}`);
  assert.equal(artifact.workflow_run.id, pinned.run); assert.equal(artifact.workflow_run.head_sha, pinned.sha); assert.equal(artifact.workflow_run.head_repository_id, pinned.repositoryId);
  const redirect = await fetch(`${base}/actions/artifacts/${pinned.artifact}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(redirect.status, 302); const location = new URL(redirect.headers.get('location')); assert.equal(location.protocol, 'https:');
  const response = await fetch(location, { signal: AbortSignal.timeout(180000) }); // No token forwarded to blob storage.
  assert(response.ok, `Artifact HTTP ${response.status}`);
  const archive = path.join(root, 'official.zip'); await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
  assert.equal(fs.statSync(archive).size, pinned.archiveBytes); assert.equal(await digest(archive), pinned.zipSha256);
  const dmg = path.join(root, pinned.dmgs[arch]);
  const script = 'import sys,zipfile,shutil,json; z=zipfile.ZipFile(sys.argv[1]); n=sys.argv[2]; assert z.namelist().count(n)==1; print(json.dumps(z.namelist())); src=z.open(n); dst=open(sys.argv[3],"wb"); shutil.copyfileobj(src,dst); dst.close(); src.close()';
  const entries = JSON.parse(execFileSync('python3', ['-c', script, archive, pinned.dmgs[arch], dmg], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' }, timeout: 60000, maxBuffer: 2e6 }));
  const report = { ...pinned, arch, qaHead: process.env.QA_HEAD_SHA, officialArtifactExpiresAt: artifact.expires_at, verifiedAt: new Date().toISOString(), archiveEntries: entries, selectedDmg: pinned.dmgs[arch], dmgSha256: await digest(dmg), dmgBytes: fs.statSync(dmg).size, scope: 'Exact official candidate only; not final merged revision or release updater acceptance' };
  fs.writeFileSync(path.join(root, 'evidence/provenance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
