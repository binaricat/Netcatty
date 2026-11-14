const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { loadFigSpec } = require("../main/registerBridges.cjs");

const repoRoot = path.resolve(__dirname, "../..");
const specNames = ["base64", "date", "readlink"];

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    netcatty: {
      listFigSpecs: async () => specNames,
      loadFigSpec: async (name, hostOs) => loadFigSpec(path.join(repoRoot, "electron"), name, hostOs),
      listAutocompleteLocalDir: async (_dir, foldersOnly, prefix = "") => ({
        success: true,
        entries: [
          { name: "sample.txt", type: "file" },
          { name: "2024-report.txt", type: "file" },
        ].filter((entry) => !foldersOnly && entry.name.startsWith(prefix)),
      }),
      listAutocompleteRemoteDir: async (_sessionId, _dir, foldersOnly, prefix = "") => ({
        success: true,
        entries: [
          { name: "sample.txt", type: "file" },
          { name: "2024-report.txt", type: "file" },
        ].filter((entry) => !foldersOnly && entry.name.startsWith(prefix)),
      }),
    },
  },
  configurable: true,
});

const enginePromise = import(pathToFileURL(
  path.join(repoRoot, "components/terminal/autocomplete/completionEngine.ts"),
).href);

const completionOptions = {
  os: "linux",
  protocol: "local",
  cwd: "/repo",
  maxResults: 100,
  pathBudgetMs: Infinity,
};

test("GNU readlink offers supported quiet and verbose options with their real meanings", async () => {
  const { getCompletions } = await enginePromise;
  const options = await getCompletions("readlink -", completionOptions);
  for (const name of ["-q", "--quiet", "-s", "--silent"]) {
    const option = options.find((item) => item.source === "option" && item.displayText === name);
    assert.equal(option?.text, `readlink ${name}`);
    assert.equal(option?.description, "Suppress most error messages");
  }
  for (const name of ["-v", "--verbose"]) {
    const option = options.find((item) => item.source === "option" && item.displayText === name);
    assert.equal(option?.text, `readlink ${name}`);
    assert.equal(option?.description, "Report error messages");
  }
  assert.equal(options.some((item) => item.displayText === "--strip"), false);

  const silent = await getCompletions("readlink --s", completionOptions);
  assert.equal(silent.some((item) => item.text === "readlink --silent"), true);
  assert.equal(silent.some((item) => item.text === "readlink --strip"), false);
});

test("GNU base64 and date file arguments complete plain relative paths", async () => {
  const { getCompletions } = await enginePromise;
  for (const input of [
    "base64 sam",
    "base64 -d sam",
    "date -f sam",
    "date --file sam",
    "date -r sam",
    "date --reference sam",
  ]) {
    const options = await getCompletions(input, completionOptions);
    assert.ok(
      options.some((item) => item.source === "path" && item.text === input.replace(/sam$/, "sample.txt")),
      `expected a file path suggestion for ${input}`,
    );
  }

  const dateString = await getCompletions("date --date sam", completionOptions);
  assert.equal(dateString.some((item) => item.source === "path"), false);
});

test("real loader keeps Linux and macOS completions isolated in one renderer", async () => {
  const { getCompletions } = await enginePromise;
  const linux = await getCompletions("date -", completionOptions);
  const macosOptions = { ...completionOptions, os: "macos" };
  const macos = await getCompletions("date -", macosOptions);
  assert.ok(linux.some((item) => item.text === "date --date"));
  assert.ok(macos.some((item) => item.text === "date -j"));
  assert.equal(macos.some((item) => item.text === "date --date" || item.text === "date -d"), false);

  const macBase64 = await getCompletions("base64 -i sam", macosOptions);
  assert.ok(macBase64.some((item) => item.source === "path" && item.text === "base64 -i sample.txt"));
  const macInputFormat = await getCompletions("date -f sam", macosOptions);
  assert.equal(macInputFormat.some((item) => item.source === "path"), false);
  const macReference = await getCompletions("date -r sam", macosOptions);
  assert.ok(macReference.some((item) => item.source === "path" && item.text === "date -r sample.txt"));
  const macNumericPrefix = await getCompletions("date -r 2024", macosOptions);
  assert.ok(macNumericPrefix.some((item) => item.source === "path" && item.text === "date -r 2024-report.txt"));
  const macReadlink = await getCompletions("readlink -", macosOptions);
  assert.ok(macReadlink.some((item) => item.text === "readlink -f"));
  assert.equal(macReadlink.some((item) => item.text === "readlink --silent"), false);

  for (const [input, os] of [["base64 -i sam", "macos"], ["date --reference sam", "linux"]]) {
    const remote = await getCompletions(input, {
      ...completionOptions,
      os,
      protocol: "ssh",
      sessionId: `${os}-fixture`,
      cwd: "/remote",
    });
    assert.ok(remote.some((item) => item.source === "path" && item.text === input.replace(/sam$/, "sample.txt")));
  }
});
