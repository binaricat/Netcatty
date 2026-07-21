import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "ProtocolSelectDialog.tsx"),
  "utf8",
);

test("protocol select dialog uses plug header and semantic protocol icons", () => {
  assert.match(source, /quickConnect\.connectTitle/);
  assert.match(source, /<Plug size=\{18\} \/>/);
  assert.doesNotMatch(source, /Progress indicator/);
  assert.doesNotMatch(source, /DistroAvatar/);
  assert.match(source, /bg-sky-500\/10 text-sky-500/);
  assert.match(source, /bg-violet-500\/10 text-violet-500/);
  assert.match(source, /bg-emerald-500\/10 text-emerald-500/);
  assert.match(source, /bg-amber-500\/10 text-amber-500/);
  assert.match(source, /<Shield size=\{18\} \/>/);
  assert.match(source, /<Radio size=\{18\} \/>/);
  assert.match(source, /<Link2 size=\{18\} \/>/);
});
