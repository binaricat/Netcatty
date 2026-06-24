import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("ssh deep link native startup sync cannot overwrite a later setting change", () => {
  const source = readFileSync(new URL("./useSettingsState.ts", import.meta.url), "utf8");
  const getEnabledIndex = source.indexOf("bridge.getSshDeepLinkEnabled()");
  const requestIdCaptureIndex = source.lastIndexOf(
    "const requestIdAtStart = sshDeepLinkSetRequestIdRef.current",
    getEnabledIndex,
  );
  const staleGuardIndex = source.indexOf(
    "if (sshDeepLinkSetRequestIdRef.current !== requestIdAtStart) return;",
    getEnabledIndex,
  );

  assert.notEqual(getEnabledIndex, -1);
  assert.notEqual(requestIdCaptureIndex, -1);
  assert.notEqual(staleGuardIndex, -1);
  assert.ok(requestIdCaptureIndex < getEnabledIndex);
  assert.ok(staleGuardIndex > getEnabledIndex);
});

test("incoming ssh deep link setting changes invalidate pending local responses", () => {
  const source = readFileSync(new URL("./useSettingsState.ts", import.meta.url), "utf8");
  const setterIndex = source.indexOf("const applyIncomingSshDeepLinkEnabled = useCallback");
  const incrementIndex = source.indexOf("sshDeepLinkSetRequestIdRef.current += 1;", setterIndex);
  const stateUpdateIndex = source.indexOf("setSshDeepLinkEnabledState((prev)", setterIndex);

  assert.notEqual(setterIndex, -1);
  assert.notEqual(incrementIndex, -1);
  assert.notEqual(stateUpdateIndex, -1);
  assert.ok(incrementIndex < stateUpdateIndex);
});
