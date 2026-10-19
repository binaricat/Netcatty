"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBookmarkStore } = require("./bookmarkStore.cjs");

const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==";

test("custom bookmark icons persist and survive cloud apply", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-browser-bookmarks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = { getPath: () => dir };
  const first = createBookmarkStore(app);
  const saved = first.upsert({ title: "App", url: "https://example.com/", scope: "host", hostId: "host-a", icon: "A", iconMode: "custom", iconDataUrl });
  assert.equal(saved.iconDataUrl, iconDataUrl);
  assert.equal(saved.iconMode, "custom");
  const reopened = createBookmarkStore(app);
  assert.equal(reopened.list()[0].iconDataUrl, iconDataUrl);
  reopened.apply([{ ...saved, scope: "all-hosts", hostId: null }]);
  assert.equal(createBookmarkStore(app).list()[0].iconDataUrl, iconDataUrl);
  assert.equal(createBookmarkStore(app).list()[0].iconMode, "custom");
});
