import test from "node:test";
import assert from "node:assert/strict";

import type { Snippet } from "./models.ts";
import {
  buildSnippetExportPayload,
  combineSnippetImportPayloads,
  mergeSnippetImportPayload,
  parseSnippetImportPayload,
} from "./snippetTransfer.ts";

const snippet = (overrides: Partial<Snippet> & Pick<Snippet, "id" | "label" | "command">): Snippet => ({
  tags: [],
  package: "",
  targets: [],
  ...overrides,
});

test("buildSnippetExportPayload removes host target bindings", () => {
  const payload = buildSnippetExportPayload({
    snippets: [
      snippet({
        id: "snippet-1",
        label: "Restart nginx",
        command: "sudo systemctl restart nginx",
        package: "ops/web",
        targets: ["host-1", "host-2"],
      }),
    ],
    snippetPackages: ["ops", "ops/web", "unused"],
    exportedAt: "2026-06-23T00:00:00.000Z",
  });

  assert.equal(payload.kind, "netcatty.snippets");
  assert.deepEqual(payload.snippetPackages, ["ops", "ops/web"]);
  assert.deepEqual(payload.snippets, [
    {
      label: "Restart nginx",
      command: "sudo systemctl restart nginx",
      tags: [],
      package: "ops/web",
    },
  ]);
});

test("mergeSnippetImportPayload skips snippets with duplicate commands", () => {
  const existing = [
    snippet({ id: "local-1", label: "Local uptime", command: "uptime", order: 1000 }),
  ];
  const payload = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["ops"],
    snippets: [
      { label: "Remote uptime", command: "uptime", package: "ops" },
      { label: "Disk free", command: "df -h", package: "ops" },
    ],
  }));

  const result = mergeSnippetImportPayload({
    existingSnippets: existing,
    existingSnippetPackages: [],
    payload,
    conflictAction: "skip",
    createId: () => "new-1",
  });

  assert.deepEqual(result.stats, {
    imported: 1,
    overwritten: 0,
    skipped: 1,
    conflicts: 1,
  });
  assert.deepEqual(result.snippets.map((item) => [item.id, item.label, item.command, item.package]), [
    ["local-1", "Local uptime", "uptime", ""],
    ["new-1", "Disk free", "df -h", "ops"],
  ]);
  assert.deepEqual(result.snippetPackages, ["ops"]);
});

test("parseSnippetImportPayload accepts a plain JSON array of snippets", () => {
  const payload = parseSnippetImportPayload(JSON.stringify([
    { label: "List files", command: "ls -la", package: "basics" },
    { command: "pwd" },
  ]));

  assert.equal(payload.kind, "netcatty.snippets");
  assert.deepEqual(payload.snippetPackages, ["basics"]);
  assert.deepEqual(payload.snippets.map((item) => [item.label, item.command, item.package]), [
    ["List files", "ls -la", "basics"],
    ["pwd", "pwd", ""],
  ]);
});

test("combineSnippetImportPayloads combines snippets and packages from multiple files", () => {
  const one = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["ops"],
    snippets: [
      { label: "Disk free", command: "df -h", package: "ops" },
    ],
  }));
  const two = parseSnippetImportPayload(JSON.stringify([
    { label: "Docker ps", command: "docker ps", package: "containers" },
  ]));

  const combined = combineSnippetImportPayloads([one, two]);

  assert.deepEqual(combined.snippetPackages, ["ops", "containers"]);
  assert.deepEqual(combined.snippets.map((item) => [item.label, item.command, item.package]), [
    ["Disk free", "df -h", "ops"],
    ["Docker ps", "docker ps", "containers"],
  ]);
});

test("mergeSnippetImportPayload overwrites duplicate commands while preserving local identity", () => {
  const existing = [
    snippet({
      id: "local-1",
      label: "Local uptime",
      command: "uptime",
      package: "",
      targets: ["host-1"],
      order: 1000,
    }),
  ];
  const payload = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["ops"],
    snippets: [
      {
        label: "Remote uptime",
        command: "uptime",
        package: "ops",
        tags: ["linux"],
        shortkey: "F8",
        noAutoRun: true,
        multiLineRunMode: "lineDelay",
      },
    ],
  }));

  const result = mergeSnippetImportPayload({
    existingSnippets: existing,
    existingSnippetPackages: [],
    payload,
    conflictAction: "overwrite",
    createId: () => "unused",
  });

  assert.deepEqual(result.stats, {
    imported: 0,
    overwritten: 1,
    skipped: 0,
    conflicts: 1,
  });
  assert.deepEqual(result.snippets, [
    {
      id: "local-1",
      label: "Remote uptime",
      command: "uptime",
      tags: ["linux"],
      package: "ops",
      targets: [],
      shortkey: "F8",
      noAutoRun: true,
      multiLineRunMode: "lineDelay",
      order: 1000,
    },
  ]);
});

test("buildSnippetExportPayload preserves multi-line run mode", () => {
  const payload = buildSnippetExportPayload({
    snippets: [
      snippet({
        id: "snippet-1",
        label: "Prompt login",
        command: "user\npass",
        multiLineRunMode: "lineDelay",
      }),
    ],
    snippetPackages: [],
    exportedAt: "2026-06-23T00:00:00.000Z",
  });

  assert.equal(payload.snippets[0].multiLineRunMode, "lineDelay");
});

test("mergeSnippetImportPayload keeps existing empty snippet packages", () => {
  const payload = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["imported/ops"],
    snippets: [
      { label: "Disk free", command: "df -h", package: "imported/ops" },
    ],
  }));

  const result = mergeSnippetImportPayload({
    existingSnippets: [],
    existingSnippetPackages: ["local-empty"],
    payload,
    conflictAction: "skip",
    createId: () => "new-1",
  });

  assert.deepEqual(result.snippetPackages, ["local-empty", "imported", "imported/ops"]);
});
