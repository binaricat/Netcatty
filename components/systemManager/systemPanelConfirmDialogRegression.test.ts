import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const SYSTEM_MANAGER_PANELS = [
  "components/systemManager/ProcessManagerTab.tsx",
  "components/systemManager/TmuxSessionCard.tsx",
  "components/systemManager/DockerContainersPanel.tsx",
  "components/systemManager/DockerImagesPanel.tsx",
] as const;

test("system manager destructive actions use in-app confirm dialogs", () => {
  for (const path of SYSTEM_MANAGER_PANELS) {
    const source = readProjectFile(path);
    assert.match(
      source,
      /import \{ SystemPanelConfirmDialog \} from ['"]\.\/SystemPanelConfirmDialog['"]/,
      `${path} should import SystemPanelConfirmDialog`,
    );
    assert.match(
      source,
      /<SystemPanelConfirmDialog/,
      `${path} should render SystemPanelConfirmDialog`,
    );
    assert.doesNotMatch(
      source,
      /window\.confirm|globalThis\.confirm/,
      `${path} must not use native confirm dialogs`,
    );
  }
});

test("process and docker confirm dialogs reset when sessionId changes", () => {
  const processSource = readProjectFile("components/systemManager/ProcessManagerTab.tsx");
  const containersSource = readProjectFile("components/systemManager/DockerContainersPanel.tsx");
  const imagesSource = readProjectFile("components/systemManager/DockerImagesPanel.tsx");

  assert.match(processSource, /setPendingSignal\(null\)/);
  assert.match(processSource, /}, \[sessionId\]\);/);

  assert.match(containersSource, /setConfirmAction\(null\)/);
  assert.match(containersSource, /}, \[sessionId\]\);/);

  assert.match(imagesSource, /setConfirmTarget\(null\)/);
  assert.match(imagesSource, /setActionBusy\(false\)/);
  assert.match(imagesSource, /}, \[sessionId\]\);/);
});
