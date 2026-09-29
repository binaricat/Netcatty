import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppSideEffects.tsx", import.meta.url), "utf8");

test("deep-link tab names are applied to terminal sessions", () => {
  assert.match(source, /type DeepLinkPayload = \{[\s\S]*tabName\?: string/);
  assert.match(source, /const handleConnectToHostWithTabName = useCallback/);
  assert.match(source, /renameSessionInline\(sessionId, tabName\)/);
  assert.match(source, /handleConnectToHostWithTabName\(ephemeralHost, tabName\)/);
  assert.match(
    source,
    /handleConnectToHostWithTabName\(buildSshDeepLinkConnectionHost\(originalHost\), tabName\)/,
  );
  assert.match(
    source,
    /handleConnectToHostWithTabName\(buildTelnetDeepLinkConnectionHost\(matchedEffectiveHost\), tabName\)/,
  );
  assert.match(source, /label: tabName/);
});
