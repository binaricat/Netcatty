import assert from "node:assert/strict";
import test from "node:test";

import type { Snippet } from "./models.ts";
import {
  applySnippetPackagePathChange,
  collectSnippetPackageTreePaths,
  deleteSnippetPackage,
  renameSnippetPackage,
} from "./snippetPackage.ts";

const snippet = (overrides: Partial<Snippet> & Pick<Snippet, "id">): Snippet => ({
  label: overrides.label ?? overrides.id,
  command: overrides.command ?? "echo ok",
  package: "",
  ...overrides,
});

test("deleteSnippetPackage removes the package and descendants but keeps snippet bodies", () => {
  const result = deleteSnippetPackage(
    ["ops", "ops/linux", "db"],
    [
      snippet({ id: "keep-ops", label: "Restart", command: "systemctl restart nginx", package: "ops" }),
      snippet({ id: "keep-child", label: "Disk", command: "df -h", package: "ops/linux" }),
      snippet({ id: "untouched", label: "PSQL", command: "psql", package: "db" }),
      snippet({ id: "root", command: "uptime" }),
    ],
    "ops",
  );

  assert.deepEqual(result.packages, ["db"]);
  assert.deepEqual(
    result.snippets.map((item) => ({
      id: item.id,
      package: item.package,
      command: item.command,
      label: item.label,
    })),
    [
      { id: "keep-ops", package: "", command: "systemctl restart nginx", label: "Restart" },
      { id: "keep-child", package: "", command: "df -h", label: "Disk" },
      { id: "untouched", package: "db", command: "psql", label: "PSQL" },
      { id: "root", package: "", command: "uptime", label: "root" },
    ],
  );
});

test("renameSnippetPackage rewrites the package and descendant snippet paths", () => {
  const result = renameSnippetPackage(
    ["ops", "ops/linux", "db"],
    [
      snippet({ id: "a", package: "ops" }),
      snippet({ id: "b", package: "ops/linux" }),
      snippet({ id: "c", package: "db" }),
    ],
    "ops",
    "platform",
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.newPath, "platform");
  assert.deepEqual(result.packages, ["platform", "platform/linux", "db"]);
  assert.deepEqual(
    result.snippets.map((item) => item.package),
    ["platform", "platform/linux", "db"],
  );
});

test("renameSnippetPackage preserves a leading slash on absolute packages", () => {
  const result = renameSnippetPackage(["/ops"], [snippet({ id: "a", package: "/ops" })], "/ops", "infra");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.newPath, "/infra");
  assert.deepEqual(result.packages, ["/infra"]);
  assert.equal(result.snippets[0].package, "/infra");
});

test("renameSnippetPackage rejects empty, invalid, and duplicate names", () => {
  assert.deepEqual(
    renameSnippetPackage(["ops"], [], "ops", "   "),
    { ok: false, error: "empty" },
  );
  assert.deepEqual(
    renameSnippetPackage(["ops"], [], "ops", "ops/linux"),
    { ok: false, error: "invalidChars" },
  );
  assert.deepEqual(
    renameSnippetPackage(["ops", "db"], [], "ops", "DB"),
    { ok: false, error: "duplicate" },
  );
});

test("renameSnippetPackage rejects collisions with inferred ancestor packages", () => {
  assert.deepEqual(
    renameSnippetPackage(["a", "b/x"], [], "a", "b"),
    { ok: false, error: "duplicate" },
  );
  assert.deepEqual(
    renameSnippetPackage(["a", "B/x"], [], "a", "b"),
    { ok: false, error: "duplicate" },
  );
});

test("renameSnippetPackage rejects collisions with snippet-implied packages", () => {
  assert.deepEqual(
    renameSnippetPackage(
      ["a"],
      [snippet({ id: "s", package: "b/x" })],
      "a",
      "b",
    ),
    { ok: false, error: "duplicate" },
  );
});

test("collectSnippetPackageTreePaths includes persisted and inferred ancestors", () => {
  assert.deepEqual(
    collectSnippetPackageTreePaths(["a", "b/x"], [snippet({ id: "s", package: "c/y" })]).sort(),
    ["a", "b", "b/x", "c", "c/y"],
  );
});

test("renameSnippetPackage no-ops when the name is unchanged", () => {
  const packages = ["ops"];
  const snippets = [snippet({ id: "a", package: "ops" })];
  const result = renameSnippetPackage(packages, snippets, "ops", "ops");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.newPath, "ops");
  assert.equal(result.packages, packages);
  assert.equal(result.snippets, snippets);
});

test("applySnippetPackagePathChange rewrites descendants and clears deleted paths", () => {
  assert.equal(
    applySnippetPackagePathChange("ops/linux", { from: "ops", to: "platform" }),
    "platform/linux",
  );
  assert.equal(
    applySnippetPackagePathChange("ops/linux", { from: "ops", to: null }),
    "",
  );
  assert.equal(
    applySnippetPackagePathChange("other", { from: "ops", to: "platform" }),
    "other",
  );
});
