import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../Terminal.tsx', import.meta.url), 'utf8');

test('safeFit skips only renderers suspended by hibernate unless explicitly allowed', () => {
  assert.match(
    source,
    /if \(!isRendererActiveRef\.current && !options\?\.allowHidden\) \{\s*lastFittedSizeRef\.current = null;\s*return;\s*\}/,
  );
});

test('safeFit can run synchronously for immediate layout changes', () => {
  assert.match(source, /immediate\?: boolean/);
  assert.match(
    source,
    /XTERM_PERFORMANCE_CONFIG\.resize\.useRAF &&\s*typeof requestAnimationFrame === "function" &&\s*!options\?\.immediate/,
  );
});

test('safeFit clears the WebGL atlas on pixel-only layout changes', () => {
  // Opening the SFTP side panel often changes container px without changing
  // cols/rows, so term.onResize (which clears the atlas) never fires. Without
  // this else-branch recovery, WebGL paints stale glyphs as black squares (#2013).
  assert.match(
    source,
    /if \(term\.cols !== dimensions\.cols \|\| term\.rows !== dimensions\.rows\) \{\s*term\.resize\(dimensions\.cols, dimensions\.rows\);\s*forceSyncRenderAfterResize\(term\);\s*\} else \{\s*[\s\S]*?xtermRuntimeRef\.current\?\.clearTextureAtlas\(\);\s*forceSyncRenderAfterResize\(term\);\s*\}/,
  );
});
