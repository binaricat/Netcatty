import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSidePanelChromeThemeFromTerminalTheme, buildTerminalAppearanceCssVars } from './terminalAppearanceTokens';

test('buildTerminalAppearanceCssVars maps core terminal colors', () => {
  const vars = buildTerminalAppearanceCssVars({
    id: 'test',
    name: 'Test',
    type: 'light',
    colors: {
      background: '#f7f7f7',
      foreground: '#100f0f',
      cursor: '#24837b',
      selection: '#24837b44',
      black: '#000',
      red: '#000',
      green: '#000',
      yellow: '#000',
      blue: '#000',
      magenta: '#000',
      cyan: '#000',
      white: '#fff',
      brightBlack: '#000',
      brightRed: '#000',
      brightGreen: '#000',
      brightYellow: '#000',
      brightBlue: '#000',
      brightMagenta: '#000',
      brightCyan: '#000',
      brightWhite: '#fff',
    },
  });

  assert.equal(vars['--nc-term-bg'], '#f7f7f7');
  assert.equal(vars['--nc-term-fg'], '#100f0f');
  assert.equal(vars['--nc-term-panel-bg'], '#f7f7f7');
  assert.equal(vars['--nc-term-host-tree-bg'], '#f7f7f7');
});

test('buildSidePanelChromeThemeFromTerminalTheme uses resolved terminal colors', () => {
  const theme = buildSidePanelChromeThemeFromTerminalTheme({
    id: 'test',
    name: 'Test',
    type: 'light',
    colors: {
      background: '#f7f7f7',
      foreground: '#100f0f',
      cursor: '#24837b',
      selection: '#24837b44',
      black: '#000',
      red: '#000',
      green: '#000',
      yellow: '#000',
      blue: '#000',
      magenta: '#000',
      cyan: '#000',
      white: '#fff',
      brightBlack: '#000',
      brightRed: '#000',
      brightGreen: '#000',
      brightYellow: '#000',
      brightBlue: '#000',
      brightMagenta: '#000',
      brightCyan: '#000',
      brightWhite: '#fff',
    },
  });

  assert.equal(theme.termBg, '#f7f7f7');
  assert.equal(theme.termFg, '#100f0f');
  assert.equal(theme.accent, '#24837b');
  assert.match(theme.separator, /^color-mix\(/);
});
