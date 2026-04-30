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
} = require("./resolve-mosh-bin-release.cjs");

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-resolve-mosh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("validateReleaseTag accepts only mosh binary release tags", () => {
  assert.equal(validateReleaseTag("mosh-bin-1.4.0-1"), "mosh-bin-1.4.0-1");
  assert.throws(() => validateReleaseTag("v1.2.3"), /invalid mosh binary release tag/);
  assert.throws(() => validateReleaseTag("mosh-bin-../bad"), /invalid mosh binary release tag/);
});

test("parseRepository falls back to Netcatty release repository", () => {
  assert.deepEqual(parseRepository({}), { owner: "binaricat", repo: "Netcatty" });
  assert.deepEqual(parseRepository({ GITHUB_REPOSITORY: "owner/project" }), { owner: "owner", repo: "project" });
  assert.deepEqual(
    parseRepository({ GITHUB_REPOSITORY: "owner/project", MOSH_BIN_OWNER: "bin", MOSH_BIN_REPO: "binaries" }),
    { owner: "bin", repo: "binaries" },
  );
});

test("pickLatestMoshBinRelease ignores non-packaging releases", () => {
  const got = pickLatestMoshBinRelease([
    { tag_name: "v1.0.0", published_at: "2026-03-01T00:00:00Z" },
    { tag_name: "mosh-bin-1.4.0-3", draft: true, published_at: "2026-04-01T00:00:00Z" },
    { tag_name: "mosh-bin-1.4.0-4", prerelease: true, published_at: "2026-04-02T00:00:00Z" },
    { tag_name: "mosh-bin-1.4.0-1", published_at: "2026-02-01T00:00:00Z" },
    { tag_name: "mosh-bin-1.4.0-2", published_at: "2026-03-01T00:00:00Z" },
  ]);

  assert.equal(got, "mosh-bin-1.4.0-2");
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
        json: [{ tag_name: "mosh-bin-1.4.0-1", published_at: "2026-01-01T00:00:00Z" }],
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

  assert.deepEqual(got.map((release) => release.tag_name), ["v1.0.0", "mosh-bin-1.4.0-1"]);
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
    MOSH_BIN_RELEASE: "mosh-bin-1.4.0-1",
    GITHUB_ENV: githubEnv,
  });

  assert.equal(got, "mosh-bin-1.4.0-1");
  assert.equal(fs.readFileSync(githubEnv, "utf8"), "MOSH_BIN_RELEASE=mosh-bin-1.4.0-1\n");
});

test("main resolves the latest release from the release list and exports it", async (t) => {
  const githubEnv = path.join(makeTmp(t), "github-env");
  const got = await main({
    GITHUB_ENV: githubEnv,
    MOSH_BIN_RELEASES_JSON: JSON.stringify([
      { tag_name: "mosh-bin-1.4.0-1", published_at: "2026-01-01T00:00:00Z" },
      { tag_name: "mosh-bin-1.4.0-2", published_at: "2026-02-01T00:00:00Z" },
    ]),
  });

  assert.equal(got, "mosh-bin-1.4.0-2");
  assert.equal(fs.readFileSync(githubEnv, "utf8"), "MOSH_BIN_RELEASE=mosh-bin-1.4.0-2\n");
});

test("main fails when no usable release exists", async () => {
  await assert.rejects(
    main({
      MOSH_BIN_RELEASES_JSON: JSON.stringify([
        { tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z" },
        { tag_name: "mosh-bin-1.4.0-1", draft: true, published_at: "2026-02-01T00:00:00Z" },
      ]),
    }),
    /could not find/,
  );
});
