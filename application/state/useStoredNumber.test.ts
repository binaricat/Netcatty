import test from "node:test";
import assert from "node:assert/strict";
import { createStoredNumberSyncHandler } from "./useStoredNumber.ts";

test("stored number instances adopt same-window adapter changes", () => {
  let current = 14;
  let received = 14;
  const handler = createStoredNumberSyncHandler({
    storageKey: "note-size",
    readValue: () => current,
    onValue: (value) => { received = value; },
  });

  current = 18;
  handler(new CustomEvent("netcatty:local-storage-adapter-changed", { detail: { key: "other" } }));
  assert.equal(received, 14);
  handler(new CustomEvent("netcatty:local-storage-adapter-changed", { detail: { key: "note-size" } }));
  assert.equal(received, 18);
});
