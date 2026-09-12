import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CustomThemeEditor } from './CustomThemeEditor';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import type { TerminalTheme } from '../../domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('intense foreground can be enabled, edited, disabled and saved without changing the palette', async () => {
  let theme: TerminalTheme = structuredClone(TERMINAL_THEMES[0]);
  delete theme.colors.foregroundIntense;
  const palette = { ...theme.colors };
  let renderer: ReturnType<typeof create>;
  function Editor() {
    const [current, setCurrent] = React.useState(theme);
    return <CustomThemeEditor theme={current} onChange={(next) => { theme = next; setCurrent(next); }} />;
  }
  await act(async () => { renderer = create(<Editor />); });
  const toggle = () => renderer.root.findByProps({ role: 'switch' });
  const color = () => renderer.root.findAllByType('input').find((input) =>
    input.props.type === 'color' && input.props['aria-label'] === 'terminal.customTheme.color.foregroundIntense')!;
  assert.equal(toggle().props['aria-checked'], false);
  assert.equal(color().props.disabled, true);
  await act(async () => toggle().props.onClick());
  assert.equal(theme.colors.foregroundIntense, theme.colors.foreground);
  await act(async () => color().props.onChange({ target: { value: '#ff8800' } }));
  assert.equal(theme.colors.foregroundIntense, '#ff8800');
  assert.equal(JSON.parse(JSON.stringify(theme)).colors.foregroundIntense, '#ff8800');
  await act(async () => toggle().props.onClick());
  assert.equal(theme.colors.foregroundIntense, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(theme.colors)), palette);
  await act(async () => renderer.unmount());
});

test('iTerm import preserves Bold Color and leaves older themes disabled', async () => {
  const { JSDOM } = await import('jsdom');
  const { parseItermcolors } = await import('../../infrastructure/parsers/itermcolorsParser');
  const dom = new JSDOM();
  const original = globalThis.DOMParser;
  globalThis.DOMParser = dom.window.DOMParser;
  const color = (key: string, r: number, g: number, b: number) => `<key>${key}</key><dict><key>Red Component</key><real>${r}</real><key>Green Component</key><real>${g}</real><key>Blue Component</key><real>${b}</real></dict>`;
  const essential = color('Background Color', 0, 0, 0) + color('Foreground Color', 1, 1, 1);
  try {
    assert.equal(parseItermcolors(`<plist><dict>${essential}${color('Bold Color', 1, 0.5, 0)}</dict></plist>`, 'imported')?.colors.foregroundIntense, '#ff8000');
    assert.equal(parseItermcolors(`<plist><dict>${essential}</dict></plist>`, 'older')?.colors.foregroundIntense, undefined);
  } finally {
    if (original === undefined) delete (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    else globalThis.DOMParser = original;
    dom.window.close();
  }
});
