import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dateSpec = (await import(pathToFileURL(path.join(ROOT, "electron/specs/date.js")).href)).default;
const macosDateSpec = (await import(pathToFileURL(path.join(ROOT, "electron/specs/macos/date.js")).href)).default;
const loadRequests: Array<{ name: string; os?: string }> = [];
const overlappingOptionsSpec = {
  name: "fixture",
  options: [
    { name: "-f", netcattyOptionalArgAttached: true, args: { isOptional: true, suggestions: ["astest"] } },
    { name: "-fast" },
  ],
};
const ordinaryOptionalSpec = {
  name: "ordinary",
  options: [
    { name: ["-o", "--output"], args: { isOptional: true, suggestions: ["json"] } },
    { name: ["-t", "--type"], netcattyOptionalArgAttached: false, args: { isOptional: true, suggestions: ["json"] } },
    { name: ["-q", "--quality"], netcattyOptionalArgAttached: "true", args: { isOptional: true, suggestions: ["json"] } },
  ],
};

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    netcatty: {
      listFigSpecs: async () => ["date", "fixture", "ordinary"],
      loadFigSpec: async (name: string, os?: string) => {
        loadRequests.push({ name, os });
        if (name === "date") return os === "macos" ? macosDateSpec : dateSpec;
        if (name === "fixture") return overlappingOptionsSpec;
        return name === "ordinary" ? ordinaryOptionalSpec : null;
      },
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");

test("GNU date completes an optional format attached to the short option", async () => {
  const suggestions = await getCompletions("date -Is", {
    os: "linux",
    skipPathCompletion: true,
  });
  const seconds = suggestions.find((suggestion) => suggestion.text === "date -Iseconds");
  assert.equal(seconds?.displayText, "seconds");
});

test("GNU date completes the value after the long option's equals sign", async () => {
  const suggestions = await getCompletions("date --iso-8601=s", {
    os: "linux",
    skipPathCompletion: true,
  });
  assert.equal(
    suggestions.find((suggestion) => suggestion.text === "date --iso-8601=seconds")?.displayText,
    "seconds",
  );

  const allFormats = await getCompletions("date --iso-8601=", {
    os: "linux",
    skipPathCompletion: true,
  });
  assert.deepEqual(
    allFormats.filter((suggestion) => suggestion.source === "arg").map((suggestion) => suggestion.text),
    ["date --iso-8601=date", "date --iso-8601=hours", "date --iso-8601=minutes", "date --iso-8601=seconds", "date --iso-8601=ns"],
  );
});

test("a bare -I remains a complete option and other options stay available", async () => {
  const bare = await getCompletions("date -I", { os: "linux", skipPathCompletion: true });
  assert.equal(bare.some((suggestion) => suggestion.text.startsWith("date -Iseconds")), false);

  const afterShort = await getCompletions("date -I ", { os: "linux", skipPathCompletion: true, maxResults: 100 });
  assert.equal(afterShort.some((suggestion) => suggestion.text === "date -I seconds"), false);
  const afterLong = await getCompletions("date --iso-8601 ", { os: "linux", skipPathCompletion: true, maxResults: 100 });
  assert.equal(afterLong.some((suggestion) => suggestion.text === "date --iso-8601 seconds"), false);

  const next = await getCompletions("date -I -", { os: "linux", skipPathCompletion: true, maxResults: 100 });
  assert.ok(next.some((suggestion) => suggestion.text === "date -I --utc"));
});

test("required option arguments retain their existing separated completion", async () => {
  const suggestions = await getCompletions("date --rfc-3339 s", {
    os: "linux",
    skipPathCompletion: true,
  });
  assert.ok(suggestions.some((suggestion) => suggestion.text === "date --rfc-3339 seconds"));

  const attached = await getCompletions("date --rfc-3339=s", {
    os: "linux",
    skipPathCompletion: true,
  });
  assert.equal(attached.some((suggestion) => suggestion.text === "date --rfc-3339=seconds"), false);
});

test("optional arguments without the explicit attached-value marker do not add attached suggestions", async () => {
  for (const [input, unwanted] of [
    ["ordinary -oj", "ordinary -ojson"],
    ["ordinary --output=j", "ordinary --output=json"],
    ["ordinary -tj", "ordinary -tjson"],
    ["ordinary --type=j", "ordinary --type=json"],
    ["ordinary -qj", "ordinary -qjson"],
    ["ordinary --quality=j", "ordinary --quality=json"],
  ]) {
    const suggestions = await getCompletions(input, { os: "linux", skipPathCompletion: true });
    assert.equal(suggestions.some((suggestion) => suggestion.text === unwanted), false, input);
  }
});

test("an option name takes precedence over an overlapping short-option argument", async () => {
  const suggestions = await getCompletions("fixture -fa", {
    os: "linux",
    skipPathCompletion: true,
  });
  assert.ok(suggestions.some((suggestion) => suggestion.text === "fixture -fast"));
  assert.equal(suggestions.some((suggestion) => suggestion.text === "fixture -fastest"), false);
});

test("date completion uses the selected host OS even after another host loaded a spec", async () => {
  const linux = await getCompletions("date -", { os: "linux", skipPathCompletion: true, maxResults: 100 });
  const macos = await getCompletions("date -", { os: "macos", skipPathCompletion: true, maxResults: 100 });

  assert.ok(linux.some((suggestion) => suggestion.text === "date --date"));
  assert.equal(linux.some((suggestion) => suggestion.text === "date -j"), false);
  assert.ok(macos.some((suggestion) => suggestion.text === "date -j"));
  assert.equal(macos.some((suggestion) => suggestion.text === "date --date"), false);
  assert.ok(loadRequests.some((request) => request.name === "date" && request.os === "linux"));
  assert.ok(loadRequests.some((request) => request.name === "date" && request.os === "macos"));
});

test("macOS date completes the supported short option without GNU long options", async () => {
  const short = await getCompletions("date -Is", { os: "macos", skipPathCompletion: true });
  assert.ok(short.some((suggestion) => suggestion.text === "date -Iseconds"));

  const long = await getCompletions("date --iso-8601=s", { os: "macos", skipPathCompletion: true });
  assert.equal(long.some((suggestion) => suggestion.text === "date --iso-8601=seconds"), false);
});
