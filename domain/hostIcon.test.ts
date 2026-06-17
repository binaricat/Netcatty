import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HOST_ICON_COLOR,
  DEFAULT_HOST_ICON_ID,
  HOST_ICON_COLORS,
  clearHostIconAppearance,
  isHostIconColorId,
  isHostIconId,
  normalizeHostIconSelection,
  resolveHostIconAppearance,
  sanitizeHostIconFields,
} from "./hostIcon.ts";

test("resolveHostIconAppearance returns null for automatic hosts", () => {
  assert.equal(resolveHostIconAppearance({}), null);
  assert.equal(resolveHostIconAppearance({ iconMode: "auto", iconId: "database", iconColor: "blue" }), null);
});

test("automatic hosts may keep a custom palette color without a custom icon", () => {
  assert.deepEqual(sanitizeHostIconFields({ iconMode: "auto", iconColor: "violet" }), {
    iconMode: "auto",
    iconColor: "violet",
  });
});

test("resolveHostIconAppearance returns validated custom icon and color", () => {
  assert.deepEqual(
    resolveHostIconAppearance({ iconMode: "custom", iconId: "database", iconColor: "blue" }),
    { iconId: "database", colorId: "blue", colorHex: "#2563EB" },
  );
});

test("resolveHostIconAppearance ignores invalid custom data", () => {
  assert.equal(
    resolveHostIconAppearance({ iconMode: "custom", iconId: "bad", iconColor: "blue" } as unknown as Parameters<typeof resolveHostIconAppearance>[0]),
    null,
  );
  assert.equal(
    resolveHostIconAppearance({ iconMode: "custom", iconId: "server", iconColor: "#123456" } as unknown as Parameters<typeof resolveHostIconAppearance>[0]),
    null,
  );
});

test("normalizeHostIconSelection creates a complete UI custom selection", () => {
  assert.deepEqual(normalizeHostIconSelection({ iconMode: "custom" }), {
    iconMode: "custom",
    iconId: DEFAULT_HOST_ICON_ID,
    iconColor: DEFAULT_HOST_ICON_COLOR,
  });
});

test("sanitizeHostIconFields clears incomplete or invalid stored custom data", () => {
  assert.deepEqual(sanitizeHostIconFields({ iconMode: "custom" }), {});
  assert.deepEqual(
    sanitizeHostIconFields({ iconMode: "custom", iconId: "bad", iconColor: "blue" } as unknown as Parameters<typeof sanitizeHostIconFields>[0]),
    {},
  );
});

test("clearHostIconAppearance removes custom icon fields", () => {
  assert.deepEqual(
    clearHostIconAppearance({ iconMode: "custom", iconId: "database", iconColor: "blue", label: "DB" }),
    { label: "DB" },
  );
});

test("host icon validators accept only curated IDs and color IDs", () => {
  assert.equal(isHostIconId("server"), true);
  assert.equal(isHostIconId("globe"), true);
  assert.equal(isHostIconId("server-cog"), true);
  assert.equal(isHostIconId("uploaded-file"), false);
  assert.equal(isHostIconColorId(HOST_ICON_COLORS[0].id), true);
  assert.equal(isHostIconColorId("violet"), true);
  assert.equal(HOST_ICON_COLORS.length, 16);
  assert.equal(isHostIconColorId("#2563EB"), false);
});
