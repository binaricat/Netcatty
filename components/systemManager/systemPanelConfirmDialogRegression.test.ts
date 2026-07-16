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
