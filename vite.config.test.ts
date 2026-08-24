import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("vite dev CSP allows eval only for development runtime", () => {
  const source = readFileSync(new URL("./vite.config.ts", import.meta.url), "utf8");

  assert.match(source, /devContentSecurityPolicy/);
  assert.match(source, /'unsafe-eval'/);
  assert.match(source, /transformIndexHtml/);
  assert.doesNotMatch(source, /index\.html.*unsafe-eval/);
});
