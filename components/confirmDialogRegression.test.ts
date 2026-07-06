import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`const ${functionName} = useCallback`);
  assert.notEqual(start, -1, `${functionName} should exist`);

  const nextConst = source.indexOf("\n  const ", start + 1);
  const nextHook = source.indexOf("\n  use", start + 1);
  const candidates = [nextConst, nextHook].filter((index) => index > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("host and AI provider deletion use in-app confirmation dialogs", () => {
  const appSource = readProjectFile("App.tsx");
  const aiSettingsSource = readProjectFile("components/settings/tabs/SettingsAITab.tsx");

  assert.match(appSource, /import \{ ConfirmDialog \} from '\.\/components\/ui\/confirm-dialog';/);
  assert.match(appSource, /<ConfirmDialog[\s\S]*confirm\.deleteHost/);
  assert.doesNotMatch(functionBody(appSource, "handleDeleteHost"), /window\.confirm|globalThis\.confirm|\bconfirm\(/);

  assert.match(aiSettingsSource, /import \{ ConfirmDialog \} from "\.\.\/\.\.\/ui\/confirm-dialog";/);
  assert.match(aiSettingsSource, /<ConfirmDialog[\s\S]*confirm\.removeProvider/);
  assert.doesNotMatch(functionBody(aiSettingsSource, "handleRemoveProvider"), /window\.confirm|globalThis\.confirm|\bconfirm\(/);
});
