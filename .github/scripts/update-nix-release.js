import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node .github/scripts/update-nix-release.js --artifacts <dir> --version <semver>');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--artifacts' || arg === '--version') {
      args[arg.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    usage();
    process.exit(2);
  }
  if (!args.artifacts || !args.version) {
    usage();
    process.exit(2);
  }
  return args;
}

function sriSha256(filePath) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('base64');
  return `sha256-${digest}`;
}

function findArtifact(artifactsDir, fileName) {
  const filePath = path.join(artifactsDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing release artifact: ${filePath}`);
  }
  return filePath;
}

function renderReleaseNix({ version, x64Hash, arm64Hash }) {
  return `{
  version = "${version}";

  sources = {
    x86_64-linux = {
      appImageArch = "x86_64";
      hash = "${x64Hash}";
    };
    aarch64-linux = {
      appImageArch = "arm64";
      hash = "${arm64Hash}";
    };
  };
}
`;
}

const args = parseArgs(process.argv);
const version = args.version.replace(/^v/, '');

if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-.+)?$/.test(version)) {
  throw new Error(`Expected semver version, got: ${args.version}`);
}

const x64AppImage = findArtifact(args.artifacts, `Netcatty-${version}-linux-x86_64.AppImage`);
const arm64AppImage = findArtifact(args.artifacts, `Netcatty-${version}-linux-arm64.AppImage`);

const releaseNix = renderReleaseNix({
  version,
  x64Hash: sriSha256(x64AppImage),
  arm64Hash: sriSha256(arm64AppImage),
});

fs.writeFileSync('nix/release.nix', releaseNix);
console.log(`Updated nix/release.nix for Netcatty ${version}`);
