import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppSideEffects.tsx", import.meta.url), "utf8");

test("open-terminal requests wait behind App Lock and resume after unlock", () => {
  const handlerStart = source.indexOf("const _handleOpenTerminalPath");
  const handlerEnd = source.indexOf("useEffect(() =>", handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);
  const drainStart = source.indexOf("const pending = pendingDeepLinksWhileLockedRef.current.splice(0)");
  const drainEnd = source.indexOf("}, [appLockLocked]);", drainStart);
  const drainSource = source.slice(drainStart, drainEnd);

  assert.match(handlerSource, /shouldDeferExternalActionWhileAppLocked/);
  assert.match(handlerSource, /kind: 'open-terminal-path'/);
  assert.match(drainSource, /_processOpenTerminalPath\(item\.payload\)/);
});
