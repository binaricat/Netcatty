import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SETTINGS_SEARCH_CATALOG } from "./settingsSearchCatalog.ts";

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(tsx|ts|jsx|js)$/.test(name) && !name.includes(".test.")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

test("every settings search catalog id is wired as an anchor in components", () => {
  const roots = [
    join(process.cwd(), "components"),
  ];
  const sources = roots.flatMap((root) => collectSourceFiles(root));
  const haystack = sources.map((file) => readFileSync(file, "utf8")).join("\n");

  const missing = SETTINGS_SEARCH_CATALOG
    .map((entry) => entry.id)
    .filter((id) => {
      const asProp = `anchorId="${id}"`;
      const asPropSingle = `anchorId='${id}'`;
      return !haystack.includes(asProp) && !haystack.includes(asPropSingle);
    });

  assert.deepEqual(missing, [], `Missing anchors for: ${missing.join(", ")}`);
});
