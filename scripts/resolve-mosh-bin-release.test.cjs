const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadReleases,
  main,
  parseRepository,
  parseNextLink,
  pickLatestMoshBinRelease,
  validateReleaseTag,
  isAtLeastMinRelease,
  MIN_TAG,
} = require("./resolve-mosh-bin-release.cjs");

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-resolve-mosh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("validateReleaseTag accepts only moshcatty-* tags at min version", () => {
  assert.equal(validateReleaseTag("moshcatty-0.1.4"), "moshcatty-0.1.4");
  assert.equal(validateReleaseTag("moshcatty-0.2.0"), "moshcatty-0.2.0");
  assert.equal(validateReleaseTag("moshcatty-0.1.5-rc1"), "moshcatty-0.1.5-rc1");
  assert.equal(validateReleaseTag("moshcatty-0.1.4+build.1"), "moshcatty-0.1.4+build.1");
  assert.throws(() => validateReleaseTag("mosh-bin-1.4.0-1"), /invalid mosh binary release tag/);
  assert.throws(() => validateReleaseTag("v1.2.3"), /invalid mosh binary release tag/);
  assert.throws(() => validateReleaseTag("moshcatty-../bad"), /invalid mosh binary release tag/);
  assert.throws(() => validateReleaseTag("moshcatty-not-a-version"), /invalid mosh binary release tag/);
  assert.throws(() => validateReleaseTag("moshcatty-0.1.0"), /below minimum/);
  assert.throws(() => validateReleaseTag("moshcatty-0.1.1"), /below minimum/);
  assert.throws(() => validateReleaseTag("moshcatty-0.1.2"), /below minimum/);
  assert.throws(() => validateReleaseTag("moshcatty-0.1.3"), /below minimum/);
  assert.throws(() => validateReleaseTag("moshcatty-0.1.4-rc1"), /below minimum/);
});

test("isAtLeastMinRelease enforces moshcatty-0.1.4 floor with semver prerelease rules", () => {
  assert.equal(MIN_TAG, "moshcatty-0.1.4");
  assert.equal(isAtLeastMinRelease("moshcatty-0.1.3"), false);
  assert.equal(isAtLeastMinRelease("moshcatty-0.1.4"), true);
  // Prerelease of the floor sorts below the final floor release.
  assert.equal(isAtLeastMinRelease("moshcatty-0.1.4-rc1"), false);
  // Above the floor, prereleases are fine.
  assert.equal(isAtLeastMinRelease("moshcatty-0.1.5-rc1"), true);
  assert.equal(isAtLeastMinRelease("moshcatty-0.1.4+build.1"), true);
  assert.equal(isAtLeastMinRelease("moshcatty-not-a-version"), false);
});

test("parseRepository defaults to binaricat/MoshCatty (ignores GITHUB_REPOSITORY fork owner)", () => {
  assert.deepEqual(parseRepository({}), { owner: "binaricat", repo: "MoshCatty" });
  assert.deepEqual(parseRepository({ GITHUB_REPOSITORY: "owner/project" }), {
    owner: "binaricat",
    repo: "MoshCatty",
  });
  assert.deepEqual(
    parseRepository({ GITHUB_REPOSITORY: "owner/project", MOSH_BIN_OWNER: "bin", MOSH_BIN_REPO: "binaries" }),
    { owner: "bin", repo: "binaries" },
  );
});

test("pickLatestMoshBinRelease ignores non-moshcatty and pre-0.1.4 tags", () => {
  const got = pickLatestMoshBinRelease([
    { tag_name: "v1.0.0", published_at: "2026-03-01T00:00:00Z" },
    { tag_name: "mosh-bin-1.4.0-2", published_at: "2026-06-01T00:00:00Z" },
    { tag_name: "moshcatty-0.1.4", draft: true, published_at: "2026-07-11T00:00:00Z" },
    { tag_name: "moshcatty-0.1.2", published_at: "2026-07-10T00:00:00Z" },
    { tag_name: "moshcatty-0.1.3", published_at: "2026-07-10T12:00:00Z" },
    { tag_name: "moshcatty-0.1.4", published_at: "2026-07-10T13:00:00Z" },
  ]);

  assert.equal(got, "moshcatty-0.1.4");
});

test("parseNextLink reads the next GitHub pagination URL", () => {
  const link = [
    '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=1>; rel="prev"',
    '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=3>; rel="next"',
    '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=9>; rel="last"',
  ].join(", ");

  assert.equal(
    parseNextLink(link),
    "https://api.github.com/repos/owner/repo/releases?per_page=100&page=3",
  );
  assert.equal(parseNextLink('<https://api.github.com/repos/owner/repo/releases?page=1>; rel="last"'), null);
});

test("loadReleases follows GitHub pagination until the last page", async () => {
  const requested = [];
  const got = await loadReleases({ GITHUB_REPOSITORY: "owner/repo" }, async (url) => {
    requested.push(url);
    if (url.includes("page=2")) {
      return {
        json: [{ tag_name: "moshcatty-0.1.4", published_at: "2026-01-01T00:00:00Z" }],
        headers: {},
      };
    }
    return {
      json: [{ tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z" }],
      headers: {
        link: '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next"',
      },
    };
  });

  assert.deepEqual(got.map((release) => release.tag_name), ["v1.0.0", "moshcatty-0.1.4"]);
  assert.equal(requested.length, 2);
});

test("loadReleases rejects pagination loops", async () => {
  await assert.rejects(
    loadReleases({ GITHUB_REPOSITORY: "owner/repo" }, async (url) => ({
      json: [],
      headers: { link: `<${url}>; rel="next"` },
    })),
    /pagination looped/,
  );
});

test("main keeps an explicit MOSH_BIN_RELEASE and exports it", async (t) => {
  const githubEnv = path.join(makeTmp(t), "github-env");

  const got = await main({
    MOSH_BIN_RELEASE: "moshcatty-0.1.4",
    GITHUB_ENV: githubEnv,
  });

  assert.equal(got, "moshcatty-0.1.4");
  assert.equal(fs.readFileSync(githubEnv, "utf8"), "MOSH_BIN_RELEASE=moshcatty-0.1.4\n");
});

test("main rejects explicit pre-0.1.4 MOSH_BIN_RELEASE", async () => {
  await assert.rejects(
    main({ MOSH_BIN_RELEASE: "moshcatty-0.1.3" }),
    /below minimum/,
  );
});

test("main resolves the latest moshcatty release from the list and exports it", async (t) => {
  const githubEnv = path.join(makeTmp(t), "github-env");
  const got = await main({
    GITHUB_ENV: githubEnv,
    MOSH_BIN_RELEASES_JSON: JSON.stringify([
      { tag_name: "moshcatty-0.1.0", published_at: "2026-01-01T00:00:00Z" },
      { tag_name: "moshcatty-0.1.2", published_at: "2026-07-10T00:00:00Z" },
      { tag_name: "moshcatty-0.1.3", published_at: "2026-07-10T12:00:00Z" },
      { tag_name: "moshcatty-0.1.4", published_at: "2026-07-10T13:00:00Z" },
      { tag_name: "mosh-bin-1.4.0-2", published_at: "2026-08-01T00:00:00Z" },
    ]),
  });

  assert.equal(got, "moshcatty-0.1.4");
  assert.equal(fs.readFileSync(githubEnv, "utf8"), "MOSH_BIN_RELEASE=moshcatty-0.1.4\n");
});

test("main fails when no usable moshcatty release exists", async () => {
  await assert.rejects(
    main({
      MOSH_BIN_RELEASES_JSON: JSON.stringify([
        { tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z" },
        { tag_name: "mosh-bin-1.4.0-1", published_at: "2026-02-01T00:00:00Z" },
        { tag_name: "moshcatty-0.1.3", published_at: "2026-02-01T00:00:00Z" },
        { tag_name: "moshcatty-0.1.4", draft: true, published_at: "2026-02-01T00:00:00Z" },
      ]),
    }),
    /could not find/,
  );
});
