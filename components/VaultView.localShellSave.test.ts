import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { upsertHostById } from "../domain/host";
import { saveWorkSurfaceHostDraft } from "../application/state/useWorkSurfaceHostEditor";
import { createLocalShellHost } from "../domain/localShellHost";
import type { Host } from "../types";

// Execute the actual Vault save callback with its persistence boundary stubbed.
const source = readFileSync(new URL("./VaultView.tsx", import.meta.url), "utf8");
const callback = source.match(/const handleSaveLocalShellHost = useCallback\((\(host: Host, connectNow\?: boolean\) => \{[\s\S]*?)\}, \[/)?.[1];
assert.ok(callback);
const compiled = ts.transpile(`const save = ${callback}};`, { target: ts.ScriptTarget.ES2022 });

for (const editing of [false, true]) {
  for (const connectNow of [false, true]) {
    test(`local shell save: editing=${editing}, connect=${connectNow}`, () => {
      const opened = createLocalShellHost({ id: "local-1", label: "old", tags: ["old"], notes: "clear me" });
      const latest = { ...opened, showLineTimestamps: true, lastConnectedAt: 42 };
      const draft = { ...opened, tags: ["edited"], notes: undefined };
      let saved: Host[] = [];
      let connected: Host | undefined;
      // Mirror useVaultState.updateHosts: hostsRef holds the freshest host
      // array and accepts an array or functional updater argument.
      const hostsRef: { current: Host[] } = { current: editing ? [latest] : [] };
      const save = new Function(
        "hosts", "editingLocalShellHost", "onUpdateHosts", "onConnect",
        "setIsLocalShellHostPanelOpen", "setEditingLocalShellHost",
        "upsertHostById", "saveWorkSurfaceHostDraft",
        `${compiled} return save;`,
      )(
        editing ? [latest] : [], editing ? opened : null,
        (data: Host[] | ((prev: Host[]) => Host[])) => {
          const next = typeof data === "function" ? data(hostsRef.current) : data;
          if (next) hostsRef.current = next;
          saved = next ?? hostsRef.current;
        },
        (host: Host) => { connected = host; },
        () => {}, () => {}, upsertHostById, saveWorkSurfaceHostDraft,
      );
      save(draft, connectNow);
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0], editing ? { ...latest, tags: ["edited"], notes: undefined } : draft);
      assert.deepEqual(connected, connectNow ? saved[0] : undefined);
    });
  }
}

// Saving must apply the draft against the freshest host array, not the array
// captured at render time — a concurrent vault write between render and Save
// would otherwise be replaced wholesale by the stale snapshot.
test("local shell save: updater merges against the latest host array", () => {
  const opened = createLocalShellHost({ id: "local-1", label: "old", tags: ["old"] });
  const draft = { ...opened, tags: ["edited"] };
  // A concurrent write lands after the render that captured `hosts`.
  const concurrent = createLocalShellHost({ id: "local-2", label: "later" });
  const renderedHosts = [opened];
  const actualHosts = [...renderedHosts, concurrent];
  // Mirror useVaultState.updateHosts: hostsRef holds the freshest host array
  // (including the concurrent write) and accepts an array or updater argument.
  let saved: Host[] = [];
  const hostsRef: { current: Host[] } = { current: actualHosts };
  const save = new Function(
    "hosts", "editingLocalShellHost", "onUpdateHosts", "onConnect",
    "setIsLocalShellHostPanelOpen", "setEditingLocalShellHost",
    "upsertHostById", "saveWorkSurfaceHostDraft",
    `${compiled} return save;`,
  )(
    renderedHosts, opened,
    (data: Host[] | ((prev: Host[]) => Host[])) => {
      const next = typeof data === "function" ? data(hostsRef.current) : data;
      if (next) hostsRef.current = next;
      saved = next ?? hostsRef.current;
    },
    () => {}, () => {}, () => {}, upsertHostById, saveWorkSurfaceHostDraft,
  );
  save(draft, false);
  assert.equal(saved.length, 2, "concurrently added host must survive the save");
  assert.ok(saved.some((host) => host.id === "local-2"));
  assert.ok(saved.some((host) => host.id === "local-1" && host.tags.includes("edited")));
});

// Duplicating a local-shell host opens its copy under a newly generated ID
// that is not in the vault yet; it must be saved as a new entry, not as an
// edit (which would no-op and silently discard the duplicate).
test("local shell save: duplicated host with a new id saves as a new entry", () => {
  const opened = createLocalShellHost({ label: "cmd (copy)" });
  const draft = { ...opened, notes: "tweaked" };
  let saved: Host[] = [];
  let connected: Host | undefined;
  const save = new Function(
    "hosts", "editingLocalShellHost", "onUpdateHosts", "onConnect",
    "setIsLocalShellHostPanelOpen", "setEditingLocalShellHost",
    "upsertHostById", "saveWorkSurfaceHostDraft",
    `${compiled} return save;`,
  )(
    [], opened,
    // Mirror useVaultState.updateHosts: accepts an array or a functional
    // updater applied against the freshest host array (here, the vault is
    // empty at render time and stays empty in prev too).
    (data: Host[] | ((prev: Host[]) => Host[])) => { saved = typeof data === "function" ? data(saved) : data; },
    (host: Host) => { connected = host; },
    () => {}, () => {}, upsertHostById, saveWorkSurfaceHostDraft,
  );
  save(draft, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, draft.id);
  assert.equal(saved[0].notes, "tweaked");
  assert.equal(connected, undefined);
});
