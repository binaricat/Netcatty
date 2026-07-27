import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  VaultImportDestinationControls,
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
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, />Close</);
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
  assert.match(html, /Staging/);
  assert.match(html, /vault\.import\.destination\.preserve/);
  assert.match(html, /vault\.import\.destination\.existing/);
  assert.match(html, /vault\.import\.destination\.new/);
});
