import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getAppLockErrorMessageKey,
} from "./AppLockOverlay.tsx";

test("getAppLockErrorMessageKey maps unlock errors to localized message keys", () => {
  assert.equal(getAppLockErrorMessageKey("empty"), "appLock.error.emptyPassword");
  assert.equal(getAppLockErrorMessageKey("incorrect"), "appLock.error.incorrectPassword");
  assert.equal(getAppLockErrorMessageKey(null), null);
});

test("AppLockOverlay marks the backdrop as a window drag region", () => {
  const source = readFileSync(new URL("./AppLockOverlay.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /className="fixed inset-0 flex items-center justify-center bg-background px-6 text-foreground app-drag"/,
  );
  assert.match(
    source,
    /className="flex w-full max-w-\[360px\] flex-col items-center gap-5 app-no-drag"/,
  );
});
