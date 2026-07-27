import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  VaultImportDestinationControls,
  VaultImportProgressPanel,
  VaultImportProgressView,
} from "./ImportVaultDialog.tsx";

const messages: Record<string, string> = {
  "vault.import.progress.title": "Importing hosts",
  "vault.import.progress.reading": "Reading file",
  "vault.import.progress.parsing": "Parsing hosts",
  "vault.import.progress.preparing": "Preparing changes",
  "vault.import.progress.saving": "Saving hosts",
  "vault.import.progress.complete": "Import complete",
  "vault.import.progress.failed": "Import failed",
  "vault.import.progress.summary": "Imported {count} hosts; skipped {skipped}; duplicates {duplicates}.",
  "vault.import.progress.keepOpen": "You can keep using Netcatty while this runs.",
  "vault.import.progress.fileSummary": "{name} · {count} files",
  "vault.import.progress.fileCount": "{completed} of {total} files",
  "common.close": "Close",
  "common.cancel": "Cancel",
};

const t = (key: string, values?: Record<string, unknown>) => {
  let value = messages[key] ?? key;
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
};

test("vault import progress renders the current background stage and percent", () => {
  const html = renderToStaticMarkup(
    <VaultImportProgressView
      progress={{
        status: "running",
        stage: "parsing",
        percent: 55,
        formatLabel: "CSV",
        fileName: "hosts.csv",
      }}
      onClose={() => {}}
      onCancel={() => {}}
      t={t}
    />,
  );

  assert.match(html, /Importing hosts/);
  assert.match(html, /hosts\.csv/);
  assert.match(html, /Parsing hosts/);
  assert.match(html, /aria-valuenow="55"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<span[^>]*role="status"[^>]*>Parsing hosts<\/span>/);
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, />Close</);
});

test("vault import progress keeps the final result visible until the user closes it", () => {
  const html = renderToStaticMarkup(
    <VaultImportProgressView
      progress={{
        status: "complete",
        stage: "complete",
        percent: 100,
        formatLabel: "CSV",
        fileName: "hosts.csv",
        imported: 8000,
        skipped: 3,
        duplicates: 2,
      }}
      onClose={() => {}}
      t={t}
    />,
  );

  assert.match(html, /Import complete/);
  assert.match(html, /Imported 8000 hosts; skipped 3; duplicates 2\./);
  assert.match(
    html,
    /<span[^>]*role="status"[^>]*>Import complete\. Imported 8000 hosts; skipped 3; duplicates 2\.<\/span>/,
  );
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, />Close</);
});

test("vault import progress announces the failure reason", () => {
  const html = renderToStaticMarkup(
    <VaultImportProgressView
      progress={{
        status: "error",
        stage: "failed",
        percent: 85,
        formatLabel: "CSV",
        fileName: "hosts.csv",
        error: "Saved Vault data is unreadable",
      }}
      onClose={() => {}}
      t={t}
    />,
  );

  assert.match(
    html,
    /<span[^>]*role="status"[^>]*>Import failed\. Saved Vault data is unreadable<\/span>/,
  );
});

test("vault import progress shows SecureCRT batch file progress", () => {
  const html = renderToStaticMarkup(
    <VaultImportProgressView
      progress={{
        status: "running",
        stage: "parsing",
        percent: 43,
        formatLabel: "SecureCRT",
        fileName: "Sessions",
        completedFiles: 2,
        totalFiles: 3,
        currentFileName: "DB.ini",
      }}
      onClose={() => {}}
      t={t}
    />,
  );

  assert.match(html, /Sessions · 3 files/);
  assert.match(html, /2 of 3 files/);
  assert.match(html, /DB\.ini/);
});

test("vault import progress is shown in a non-blocking floating panel", () => {
  const html = renderToStaticMarkup(
    <VaultImportProgressPanel
      progress={{
        status: "running",
        stage: "parsing",
        percent: 55,
        formatLabel: "CSV",
        fileName: "hosts.csv",
      }}
      onClose={() => {}}
      onCancel={() => {}}
      t={t}
    />,
  );

  assert.match(html, /data-vault-import-progress-panel/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.match(html, /fixed/);
  assert.match(html, /max-h-\[calc\(100vh-2rem\)\]/);
  assert.match(html, /overflow-y-auto/);
});

test("vault import destination controls offer preserve, existing, and new groups", () => {
  const html = renderToStaticMarkup(
    <VaultImportDestinationControls
      mode="existing"
      onModeChange={() => {}}
      groups={["Production", "Staging"]}
      existingGroup="Production"
      onExistingGroupChange={() => {}}
      newGroup=""
      onNewGroupChange={() => {}}
      t={t}
    />,
  );

  assert.equal((html.match(/data-import-destination-mode=/g) ?? []).length, 3);
  assert.match(html, /Production/);
  assert.doesNotMatch(html, /Staging/);
  assert.match(html, /vault\.import\.destination\.preserve/);
  assert.match(html, /vault\.import\.destination\.existing/);
  assert.match(html, /vault\.import\.destination\.new/);
});

test("import format step keeps destination settings off the main card grid", async () => {
  // Source-level guard: format tiles must not embed SecureCRT copy, and the
  // destination picker lives behind a dedicated footer entry point.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("./ImportVaultDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /data-import-destination-settings="true"/);
  assert.match(source, /data-import-securecrt-prompt="true"/);
  assert.match(source, /step === "destination"/);
  assert.match(source, /FolderTree/);
  assert.doesNotMatch(
    source,
    /data-import-format=\{opt\.format\}[\s\S]*securecrt\.directoryHint/,
  );
});

test("vault import destination search caps very large group suggestions", () => {
  const groups = Array.from({ length: 1000 }, (_, index) => `Group ${index}`);
  const html = renderToStaticMarkup(
    <VaultImportDestinationControls
      mode="existing"
      onModeChange={() => {}}
      groups={groups}
      existingGroup=""
      onExistingGroupChange={() => {}}
      newGroup=""
      onNewGroupChange={() => {}}
      t={t}
    />,
  );

  assert.equal((html.match(/<option/g) ?? []).length, 50);
  assert.match(html, /list=/);
});
