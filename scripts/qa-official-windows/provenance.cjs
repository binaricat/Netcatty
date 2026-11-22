// Only this downloader receives the standard Actions read token.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const pinned = require('./candidate.json');
const portable = process.env.QA_MODE === 'portable';
const baseline = portable ? pinned.portableBaseline : pinned.baseline;
const entry = portable ? pinned.portableZip : pinned.installer;
const root = path.resolve(process.env.QA_ROOT);
const evidence = path.join(root, 'evidence');
const digest = async file => {
  const hash = crypto.createHash('sha256');
  for await (const part of fs.createReadStream(file)) hash.update(part);
  return hash.digest('hex');
};
async function download(response, file) {
  assert(response.ok, `Download HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert(process.env.GH_TOKEN);
  fs.mkdirSync(evidence, { recursive: true });
  const base = `https://api.github.com/repos/${pinned.repository}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(route) {
    const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(30000) });
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
  const job = jobs.jobs.find(item => item.name === 'build-windows');
  assert.equal(job?.conclusion, 'success');
  const artifact = await api(`/actions/artifacts/${pinned.artifact}`);
  assert.equal(artifact.name, pinned.name);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run.id, pinned.run);
  assert.equal(artifact.workflow_run.head_sha, pinned.sha);
  assert.equal(artifact.workflow_run.head_repository_id, pinned.repositoryId);
  assert.equal(artifact.digest, `sha256:${pinned.zipSha256}`);
  const release = await api(`/releases/tags/${baseline.tag}`);
  const asset = release.assets.find(item => item.id === baseline.asset);
  assert.equal(asset?.name, baseline.installer);
  assert.equal(asset.digest, `sha256:${baseline.sha256}`);
  assert.equal(asset.browser_download_url, baseline.url);
  await download(await fetch(baseline.url, { signal: AbortSignal.timeout(120000) }), path.join(root, baseline.installer));
  assert.equal(await digest(path.join(root, baseline.installer)), baseline.sha256);
  const response = await fetch(`${base}/actions/artifacts/${pinned.artifact}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.protocol, 'https:');
  // Never forward the token to the signed artifact blob or to installers/apps.
  const zip = path.join(root, 'official.zip');
  await download(await fetch(location, { signal: AbortSignal.timeout(180000) }), zip);
  assert.equal(await digest(zip), pinned.zipSha256);
  const extract = `Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($env:QA_ZIP)
    try {
      $entries = @($z.Entries | Where-Object { $_.FullName -eq $env:QA_INSTALLER })
      if ($entries.Count -ne 1) { throw 'Expected exactly one pinned NSIS entry' }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $env:QA_OUTPUT, $false)
    } finally { $z.Dispose() }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', extract], {
    env: { ...process.env, GH_TOKEN: '', QA_ZIP: zip, QA_INSTALLER: entry, QA_OUTPUT: path.join(root, entry) }, timeout: 30000,
  });
  if (portable) {
    const unpack = `Add-Type -AssemblyName System.IO.Compression.FileSystem
      $destination = [IO.Path]::GetFullPath($env:QA_DEST) + [IO.Path]::DirectorySeparatorChar
      $z = [IO.Compression.ZipFile]::OpenRead($env:QA_ARCHIVE)
      try { foreach ($e in $z.Entries) {
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination,$e.FullName))
        if (-not $target.StartsWith($destination,[StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP path outside isolated root' }
        if ($e.Name -eq '') { [void][IO.Directory]::CreateDirectory($target) }
        else { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)); [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$target,$false) }
      }} finally { $z.Dispose() }`;
    for (const [archive, dest] of [[baseline.installer, 'baseline-portable'], [entry, 'candidate-portable']]) {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', unpack], { env: { ...process.env, GH_TOKEN: '', QA_ARCHIVE: path.join(root, archive), QA_DEST: path.join(root, dest) }, timeout: 60000 });
      assert(fs.existsSync(path.join(root, dest, 'Netcatty.exe')));
    }
  }
  const provenance = {
    ...pinned, mode: process.env.QA_MODE || 'nsis', testedBaseline: baseline,
    officialWindowsJob: job.id, verifiedAt: new Date().toISOString(),
    candidateEntry: entry, candidateEntrySha256: await digest(path.join(root, entry)),
    candidateEntryDigestSource: 'Computed from exact entry in verified official artifact ZIP',
    baselineMode: portable ? 'Public released Windows ZIP, extraction only' : 'Public released NSIS installer',
    candidateMode: portable ? 'Official CI Windows ZIP, extraction only; no installer/updater coverage' : 'Official CI NSIS installer; prerelease version, not released updater acceptance',
  };
  fs.writeFileSync(path.join(evidence, 'provenance.json'), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify(provenance, null, 2));
  console.log(`Verified ${pinned.baseline.tag} and official ${pinned.sha}, artifact ${pinned.artifact}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
