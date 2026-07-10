import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTerminalThemeSync,
  cancelTerminalThemeUpdate,
  resetTerminalThemeSchedulerForTests,
  scheduleTerminalThemeUpdate,
} from './terminalThemeScheduler';
import type { TerminalTheme } from '../../domain/models';

const theme = (id: string): TerminalTheme => ({
  id,
  name: id,
  type: 'dark',
  colors: {
    background: '#111111',
    foreground: '#eeeeee',
    cursor: '#22aaff',
    selection: '#22aaff44',
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

test('cancelTerminalThemeUpdate drops a pending hidden-pane theme flush', async () => {
  resetTerminalThemeSchedulerForTests();
  let appliedThemeId: string | null = null;
  const fakeTerm = {
    options: { theme: {} as Record<string, string> },
  };

  scheduleTerminalThemeUpdate(
    'session-1',
    theme('old-theme'),
    { visible: false, focused: false },
    () => fakeTerm as never,
  );

  cancelTerminalThemeUpdate('session-1');

  await new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

  appliedThemeId = fakeTerm.options.theme.background ?? null;
  assert.equal(appliedThemeId, null);
});

test('reapplying an unchanged theme does not repaint the terminal', () => {
  resetTerminalThemeSchedulerForTests();
  let renderCalls = 0;
  const fakeTerm = {
    rows: 24,
    options: { theme: {} as Record<string, string> },
    _core: {
      _renderService: {
        _renderRows() {
          renderCalls += 1;
        },
      },
    },
  };

  applyTerminalThemeSync(fakeTerm as never, theme('stable-theme'));
  applyTerminalThemeSync(fakeTerm as never, theme('stable-theme'));

  assert.equal(renderCalls, 1);
});
