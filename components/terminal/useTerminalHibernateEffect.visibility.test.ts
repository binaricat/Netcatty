import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("hibernate effect keeps isVisibleRef current even when hibernate is disabled", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  // Visibility sync must not early-return when hibernate is off; otherwise
  // solo tab switches leave write/recovery paths on a stale isVisibleRef.
  assert.doesNotMatch(
    source,
    /if \(!hibernateEnabled\) \{\s*clearHibernateTimer\(\);[\s\S]*return \(\) => \{\s*unsubscribeDisabled\(\);\s*\};\s*\}/,
  );
  assert.match(source, /isVisibleRef\.current = visible;/);
  assert.match(
    source,
    /if \(hibernateEnabled\) \{\s*scheduleHibernate\(\);\s*\}/,
  );
});

test("disabling hibernate wakes already soft-hidden or hibernated panes", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(!hibernateEnabled\) \{[\s\S]*?clearHibernateTimer\(\);[\s\S]*?if \(hibernatedRef\.current \|\| softHiddenRef\.current\) \{\s*tryWake\(\);\s*\}/,
  );
  // Must not early-return before visibility sync after the disable wake path.
  const disableWakeIndex = source.indexOf("Turning hibernate off must wake");
  const applyVisibilityCallIndex = source.indexOf(
    "applyVisibility(resolveVisible());",
    disableWakeIndex,
  );
  assert.ok(disableWakeIndex !== -1);
  assert.ok(applyVisibilityCallIndex !== -1);
  assert.ok(applyVisibilityCallIndex > disableWakeIndex);
});

test("soft-hidden wake keeps its marker until the runtime has resumed", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  const softWakeBranch = source.match(
    /if \(softHiddenRef\.current\) \{([\s\S]*?)return;\s*\}/,
  )?.[1] ?? "";

  assert.match(softWakeBranch, /onSoftHideWakeRef\.current\(\)/);
  assert.doesNotMatch(softWakeBranch, /softHiddenRef\.current\s*=\s*false/);
});
