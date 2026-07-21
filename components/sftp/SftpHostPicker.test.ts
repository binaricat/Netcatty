import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "SftpHostPicker.tsx"),
  "utf8",
);

test("sftp host picker rows reuse quick switcher selection classes", () => {
  assert.match(source, /getQuickSwitcherRowStateClass/);
  assert.match(source, /shouldUseQuickSwitcherPointerNavigation/);
  assert.match(source, /isKeyboardNavigating/);
  assert.match(source, /onMouseMove=\{\(event\) => handlePointerHover\(event\.movementX, event\.movementY\)\}/);
  assert.match(
    source,
    /const handlePointerHover = useCallback\(\(movementX: number, movementY: number\) => \{[\s\S]*if \(!isKeyboardNavigatingRef\.current\) return;[\s\S]*setIsKeyboardNavigating\(false\);[\s\S]*\}, \[\]\);/,
  );
  assert.doesNotMatch(
    source,
    /const handlePointerHover = useCallback\(\(itemIndex: number, movementX: number, movementY: number\) => \{[\s\S]*setSelectedIndex\(itemIndex\);/,
  );
});

test("sftp host picker uses single-line quick switcher row layout", () => {
  assert.match(
    source,
    /className=\{`flex items-center justify-between px-4 py-2\.5 cursor-pointer transition-colors \$\{getQuickSwitcherRowStateClass/,
  );
  assert.match(
    source,
    /className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground"/,
  );
  assert.match(
    source,
    /<span className="text-sm font-medium truncate">\{t\('sftp\.picker\.local\.title'\)\}<\/span>/,
  );
  assert.match(
    source,
    /<span className="text-sm font-medium truncate">\{host\.label\}<\/span>/,
  );
  assert.match(
    source,
    /className="ml-3 shrink-0 text-\[11px\] text-muted-foreground truncate max-w-\[12rem\]"/,
  );
  assert.match(source, /formatHostMeta\(host\)/);
  assert.doesNotMatch(source, /bg-primary\/10 border border-primary\/30/);
  assert.doesNotMatch(source, /text-xs text-muted-foreground truncate/);
});
