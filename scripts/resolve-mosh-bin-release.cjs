#!/usr/bin/env node
/* eslint-disable no-console */
//
// Resolve the MoshCatty mosh-client binary release used by packaging / dev.
//
// Priority:
//   1. MOSH_BIN_RELEASE from workflow input / repository variable.
//   2. Latest non-draft, non-prerelease GitHub Release whose tag is
//      moshcatty-* in MOSH_BIN_OWNER/MOSH_BIN_REPO (default binaricat/MoshCatty).
//
// In GitHub Actions, the resolved tag is written to $GITHUB_ENV.

const fs = require("node:fs");
const https = require("node:https");

// MoshCatty pure-Rust releases only.
// Minimum 0.1.4: includes the Windows ConPTY shortcut-input fix. Linux builds
// have matched Netcatty's GLIBC floors since 0.1.2.
// Allow semver prerelease (-rc1) and build metadata (+meta); no path separators.
const TAG_RE = /^moshcatty-[A-Za-z0-9._+-]+$/;
const MIN_VERSION = { major: 0, minor: 1, patch: 4 };
const MIN_TAG = `moshcatty-${MIN_VERSION.major}.${MIN_VERSION.minor}.${MIN_VERSION.patch}`;

function log(msg) {
  console.log(`[resolve-mosh-bin-release] ${msg}`);
}

/**
 * Parse moshcatty-X.Y.Z with optional prerelease (-rc1) and build (+meta).
 * Returns null if not semver-ish.
 */
function parseMoshCattyVersion(tag) {
  const match = String(tag || "").trim().match(
    /^moshcatty-(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // Present when tag is e.g. moshcatty-0.1.4-rc1 (semver: prerelease < final).
    prerelease: match[4] || null,
  };
}

function compareCoreVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * True when tag is usable for packaging (core version ≥ min, with semver
 * prerelease rules: X.Y.Z-rcN is below final X.Y.Z).
 */
function isAtLeastMinRelease(tag) {
  const version = parseMoshCattyVersion(tag);
  if (!version) return false;
  const core = compareCoreVersion(version, MIN_VERSION);
  if (core > 0) return true;
  if (core < 0) return false;
  // Equal to the floor: final only (no prerelease suffix).
  return !version.prerelease;
}

function validateReleaseTag(tag) {
  const value = String(tag || "").trim();
  if (!TAG_RE.test(value) || !parseMoshCattyVersion(value)) {
    throw new Error(`invalid mosh binary release tag: ${tag} (expected moshcatty-X.Y.Z[(-pre)|(+build)])`);
  }
  if (!isAtLeastMinRelease(value)) {
    throw new Error(
      `mosh binary release ${value} is below minimum ${MIN_TAG} `
        + "(0.1.4 includes the Windows ConPTY shortcut-input fix; "
        + "prereleases of the floor e.g. 0.1.4-rc1 are not accepted)",
    );
  }
  return value;
}

function parseRepository(env) {
  // Canonical default is always binaricat/MoshCatty. Do not derive owner from
  // GITHUB_REPOSITORY — fork packaging would otherwise look for
  // <fork-owner>/MoshCatty and fail. Override only via MOSH_BIN_OWNER/REPO.
  const owner = env.MOSH_BIN_OWNER || "binaricat";
  const repo = env.MOSH_BIN_REPO || "MoshCatty";
  return { owner, repo };
}

function releaseTimestamp(release) {
  const raw = release.published_at || release.created_at || "";
  const value = Date.parse(raw);
  return Number.isNaN(value) ? 0 : value;
}

function pickLatestMoshBinRelease(releases) {
  return releases
    .map((release, index) => ({ release, index }))
    .filter(({ release }) => {
      const tag = String(release?.tag_name || "");
      return release
        && TAG_RE.test(tag)
        && isAtLeastMinRelease(tag)
        && release.draft !== true
        && release.prerelease !== true;
    })
    .sort((a, b) => {
      const diff = releaseTimestamp(b.release) - releaseTimestamp(a.release);
      return diff || a.index - b.index;
    })[0]?.release.tag_name;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*(.+)\s*$/);
    if (!match) continue;
    const rel = match[2].split(";").some((attr) => attr.trim() === 'rel="next"');
    if (rel) return match[1];
  }
  return null;
}

function requestJsonWithHeaders(url, env, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error("too many redirects while looking up mosh binary releases"));
      return;
    }

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "netcatty-mosh-release-resolver",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    https.get(url, { headers }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        resolve(requestJsonWithHeaders(new URL(location, url).toString(), env, depth + 1));
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve({ json: JSON.parse(body), headers: res.headers });
        } catch (err) {
          reject(new Error(`GitHub API returned invalid JSON: ${err.message}`));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function loadReleases(env, request = requestJsonWithHeaders) {
  if (env.MOSH_BIN_RELEASES_JSON) {
    const parsed = JSON.parse(env.MOSH_BIN_RELEASES_JSON);
    if (!Array.isArray(parsed)) {
      throw new Error("MOSH_BIN_RELEASES_JSON must be a JSON array");
    }
    return parsed;
  }

  const { owner, repo } = parseRepository(env);
  const apiBase = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  let url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`;
  log(`looking up latest moshcatty-* release in ${owner}/${repo}`);
  const releases = [];
  const seen = new Set();
  while (url) {
    if (seen.has(url)) {
      throw new Error(`GitHub API pagination looped while looking up releases: ${url}`);
    }
    seen.add(url);

    const { json, headers = {} } = await request(url, env);
    if (!Array.isArray(json)) {
      throw new Error("GitHub API releases response was not an array");
    }
    releases.push(...json);
    url = parseNextLink(headers.link);
  }
  return releases;
}

function exportRelease(release, env) {
  if (env.GITHUB_ENV) {
    fs.appendFileSync(env.GITHUB_ENV, `MOSH_BIN_RELEASE=${release}\n`, "utf8");
  }
}

async function main(env = process.env) {
  if (String(env.MOSH_BIN_RELEASE || "").trim()) {
    const release = validateReleaseTag(env.MOSH_BIN_RELEASE);
    exportRelease(release, env);
    log(`using MOSH_BIN_RELEASE=${release}`);
    return release;
  }

  const releases = await loadReleases(env);
  const release = pickLatestMoshBinRelease(releases);
  if (!release) {
    throw new Error(
      `could not find a non-draft ${MIN_TAG}+ release in binaricat/MoshCatty. `
        + `Publish a MoshCatty GitHub Release (e.g. ${MIN_TAG}) before packaging.`,
    );
  }

  const validated = validateReleaseTag(release);
  exportRelease(validated, env);
  log(`resolved MOSH_BIN_RELEASE=${validated}`);
  return validated;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[resolve-mosh-bin-release] FATAL ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  loadReleases,
  parseNextLink,
  validateReleaseTag,
  parseMoshCattyVersion,
  isAtLeastMinRelease,
  parseRepository,
  pickLatestMoshBinRelease,
  MIN_TAG,
  main,
};
