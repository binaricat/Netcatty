import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const hookSource = readFileSync(new URL('./useManualTerminalChromeSurfaceInjection.ts', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../../components/terminalLayer/TerminalLayerTabBridge.tsx', import.meta.url), 'utf8');
const varsSource = readFileSync(new URL('../../infrastructure/theme/terminalAppearanceVars.ts', import.meta.url), 'utf8');

test('manual mode injects chrome surfaces from focused session theme', () => {
  assert.match(appSource, /includeChromeSurfaces: followAppTerminalTheme/);
  assert.match(bridgeSource, /useManualTerminalChromeSurfaceInjection/);
  assert.match(bridgeSource, /!s\.followAppTerminalTheme && isTerminalLayerVisible/);
  assert.match(readFileSync(new URL('../app/AppHostTreeLayer.tsx', import.meta.url), 'utf8'), /useManualTerminalChromeSurfaceInjection/);
  assert.match(appSource, /resolveSessionAppearance=\{themeRuntime\.resolveFocusedAppearance\}/);
  assert.match(hookSource, /applyTopTabsChromeThemeVars\(theme\)/);
  assert.match(hookSource, /injectTerminalLayerChromeSurfaceVars\(theme\)/);
  assert.match(hookSource, /if \(wasEnabled\) \{[\s\S]*clearTerminalLayerChromeSurfaceVars\(\)/);
  assert.doesNotMatch(hookSource, /clearTopTabsChromeThemeVars\(\)/);
  assert.match(varsSource, /injectTerminalLayerChromeSurfaceVars/);
  assert.match(varsSource, /clearTerminalLayerChromeSurfaceVars/);
});
