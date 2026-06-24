import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, useI18n } from "../application/i18n/I18nProvider.tsx";
import type { Snippet } from "../types.ts";
import { Dialog } from "./ui/dialog.tsx";
import SnippetsManager, {
  SNIPPET_IMPORT_SAMPLE_FILES,
  SnippetImportDialogContent,
  buildSnippetImportSamplesZip,
} from "./SnippetsManager.tsx";

const installStorageStub = () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
};

const snippet: Snippet = {
  id: "snippet-1",
  label: "Restart nginx",
  command: "sudo systemctl restart nginx",
  tags: [],
  package: "ops",
  targets: ["host-1"],
};

test("SnippetsManager renders import and multi-select controls", () => {
  installStorageStub();
  const noop = () => {};

  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SnippetsManager
        snippets={[snippet]}
        packages={["ops"]}
        hosts={[]}
        shellHistory={[]}
        hotkeyScheme="mac"
        keyBindings={[]}
        onSave={noop}
        onBulkSave={noop}
        onDelete={noop}
        onPackagesChange={noop}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Import/);
  assert.match(markup, /Select snippets/);
  assert.doesNotMatch(markup, /Snippet import format/);
});

test("SnippetImportDialog shows example JSON before import confirmation", () => {
  const noop = () => {};

  const TestDialog = () => {
    const { t } = useI18n();
    const fileInputRef = React.createRef<HTMLInputElement>();
    return (
      <Dialog open={true}>
        <SnippetImportDialogContent
          pendingImport={null}
          t={t}
          fileInputRef={fileInputRef}
          onFileSelected={noop}
          onChooseFile={noop}
          onConfirmSkip={noop}
          onConfirmOverwrite={noop}
          onCancel={noop}
          onDownloadExamples={noop}
        />
      </Dialog>
    );
  };

  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <TestDialog />
    </I18nProvider>,
  );

  assert.match(markup, /Example JSON/);
  assert.match(markup, /netcatty\.snippets/);
  assert.match(markup, /JSON array/);
  assert.match(markup, /Choose file/);
  assert.match(markup, /Download samples/);
  assert.match(markup, /Confirm import/);
  assert.match(markup, /multiple=""/);
});

test("snippet import sample files include standard and array formats", () => {
  assert.equal(SNIPPET_IMPORT_SAMPLE_FILES.length, 5);
  assert.ok(SNIPPET_IMPORT_SAMPLE_FILES.some((file) => file.name === "01-standard-netcatty-object.json"));
  assert.ok(SNIPPET_IMPORT_SAMPLE_FILES.some((file) => file.name === "02-plain-snippet-array.json"));
  assert.deepEqual(JSON.parse(SNIPPET_IMPORT_SAMPLE_FILES[1].content).map((item: { command: string }) => item.command), [
    "ss -lntp",
    "pwd",
  ]);
});

test("buildSnippetImportSamplesZip returns a zip archive", async () => {
  const blob = buildSnippetImportSamplesZip();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  assert.equal(blob.type, "application/zip");
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
});
