import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import en from '../application/i18n/locales/en';
import es from '../application/i18n/locales/es';
import ru from '../application/i18n/locales/ru';
import zhCN from '../application/i18n/locales/zh-CN';
import zhTW from '../application/i18n/locales/zh-TW';
import {
  TOP_TAB_ACTIVE_BG,
  TOP_TAB_ACTIVE_BORDER,
  TOP_TAB_ACTIVE_FG,
  TOP_TAB_ACTIVE_OUTLINE,
  TOP_TAB_HOVER_BG,
  TOP_TAB_INACTIVE_FG,
  TOP_TAB_ITEM_CLASS,
  TOP_TAB_LEGACY_ACTIVE_BG,
  TOP_TAB_LEGACY_ACTIVE_FG,
  clearInactiveTopTabHover,
  paintInactiveTopTabHover,
  resolveTopTabChromeStyle,
  topTabActiveValue,
} from './top-tabs/topTabActiveStyle';

const topTabItemsSource = readFileSync(
  fileURLToPath(new URL('./top-tabs/TopTabItems.tsx', import.meta.url)),
  'utf8',
);
const indexCss = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

const TAB_TYPES = ['root', 'plugin-view', 'editor', 'session', 'workspace', 'logView'] as const;
const LOCALES = [
  { name: 'en', messages: en },
  { name: 'zh-CN', messages: zhCN },
  { name: 'zh-TW', messages: zhTW },
  { name: 'es', messages: es },
  { name: 'ru', messages: ru },
];
const HOOKS = ['--top-tab-active-bg', '--top-tab-active-fg', '--top-tab-active-border'] as const;

test('active top tab colors fall back to the current chrome colors', () => {
  assert.equal(TOP_TAB_ACTIVE_BG, `var(--top-tab-active-bg, ${TOP_TAB_LEGACY_ACTIVE_BG})`);
  assert.equal(TOP_TAB_ACTIVE_FG, `var(--top-tab-active-fg, ${TOP_TAB_LEGACY_ACTIVE_FG})`);
  assert.equal(TOP_TAB_ACTIVE_BORDER, 'var(--top-tab-active-border, transparent)');
  assert.equal(TOP_TAB_LEGACY_ACTIVE_BG, 'var(--top-tabs-active-bg, hsl(var(--background)))');
  assert.equal(TOP_TAB_LEGACY_ACTIVE_FG, 'var(--top-tabs-fg, hsl(var(--foreground)))');
  assert.equal(
    TOP_TAB_HOVER_BG,
    `color-mix(in srgb, ${TOP_TAB_ACTIVE_BG} 40%, transparent)`,
  );

  const active = resolveTopTabChromeStyle(true);
  assert.deepEqual(active, {
    backgroundColor: TOP_TAB_ACTIVE_BG,
    color: TOP_TAB_ACTIVE_FG,
  });

  const inactive = resolveTopTabChromeStyle(false);
  assert.deepEqual(inactive, {
    backgroundColor: 'transparent',
    color: TOP_TAB_INACTIVE_FG,
  });
  assert.equal(TOP_TAB_INACTIVE_FG, 'var(--top-tabs-muted, hsl(var(--muted-foreground)))');

  const vault = resolveTopTabChromeStyle(true, { suppressActiveBg: true });
  assert.equal(vault.backgroundColor, 'transparent');
  assert.equal(vault.color, TOP_TAB_ACTIVE_FG);
});

test('top tab active attribute is a stable true/false hook', () => {
  assert.equal(topTabActiveValue(true), 'true');
  assert.equal(topTabActiveValue(false), 'false');
  assert.equal(TOP_TAB_ITEM_CLASS, 'top-tab');
});

test('inactive hover uses the active-tab hook and clears back to the flat tab', () => {
  const element = { style: { backgroundColor: '', color: '' } };
  paintInactiveTopTabHover(element);
  assert.equal(element.style.backgroundColor, TOP_TAB_HOVER_BG);
  assert.equal(element.style.color, TOP_TAB_ACTIVE_FG);
  clearInactiveTopTabHover(element);
  assert.equal(element.style.backgroundColor, 'transparent');
  assert.equal(element.style.color, TOP_TAB_INACTIVE_FG);
});

test('every top tab kind exposes the active style hook', () => {
  for (const type of TAB_TYPES) {
    const marker = `data-tab-type="${type}"`;
    const start = topTabItemsSource.indexOf(marker);
    assert.notEqual(start, -1, marker);
    const next = topTabItemsSource.indexOf('data-tab-type=', start + marker.length);
    const slice = topTabItemsSource.slice(start, next === -1 ? undefined : next);
    assert.match(slice, /data-active=\{topTabActiveValue\(isActive\)\}/);
    assert.match(slice, /TOP_TAB_ITEM_CLASS/);
    assert.match(slice, /resolveTopTabChromeStyle\(isActive/);
  }

  assert.equal(topTabItemsSource.split('data-active={topTabActiveValue(isActive)}').length - 1, TAB_TYPES.length);
  assert.doesNotMatch(topTabItemsSource, /backgroundColor: isActive/);
});

test('selected top tab border hook defaults to a transparent inset outline', () => {
  const start = indexCss.indexOf('[data-section="top-tabs"] .top-tab[data-active="true"]');
  assert.notEqual(start, -1);
  const rule = indexCss.slice(start, indexCss.indexOf('}', start));
  assert.match(rule, /outline:\s*1px solid var\(--top-tab-active-border, transparent\)/);
  assert.match(rule, /outline-offset:\s*-1px/);
  assert.equal(TOP_TAB_ACTIVE_OUTLINE, '1px solid var(--top-tab-active-border, transparent)');
});

test('custom CSS sets the top tab hooks on the selected tab', () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div data-section="top-tabs">
      <div id="active" class="top-tab" data-active="true"></div>
      <div id="idle" class="top-tab" data-active="false"></div>
    </div>
  </body></html>`);
  const { document, getComputedStyle } = dom.window;
  const active = document.getElementById('active')!;
  const idle = document.getElementById('idle')!;
  const activeStyle = resolveTopTabChromeStyle(true);
  active.style.backgroundColor = activeStyle.backgroundColor;
  active.style.color = activeStyle.color;
  Object.assign(idle.style, resolveTopTabChromeStyle(false));

  assert.equal(active.getAttribute('data-active'), 'true');
  assert.equal(active.style.backgroundColor, TOP_TAB_ACTIVE_BG);
  assert.equal(active.style.color, TOP_TAB_ACTIVE_FG);
  assert.equal(idle.style.backgroundColor, 'transparent');
  assert.equal(getComputedStyle(active).getPropertyValue('--top-tab-active-bg').trim(), '');

  const custom = document.createElement('style');
  custom.id = 'netcatty-custom-css';
  custom.textContent = `
    .top-tab[data-active="true"] {
      --top-tab-active-bg: rgb(37, 99, 235);
      --top-tab-active-fg: rgb(255, 255, 255);
      --top-tab-active-border: rgb(29, 78, 216);
    }
  `;
  document.head.appendChild(custom);

  const styled = getComputedStyle(active);
  const normalized = (value: string) => value.replace(/\s+/g, '');
  assert.equal(normalized(styled.getPropertyValue('--top-tab-active-bg')), 'rgb(37,99,235)');
  assert.equal(normalized(styled.getPropertyValue('--top-tab-active-fg')), 'rgb(255,255,255)');
  assert.equal(normalized(styled.getPropertyValue('--top-tab-active-border')), 'rgb(29,78,216)');
  assert.equal(getComputedStyle(idle).getPropertyValue('--top-tab-active-bg').trim(), '');
  assert.match(active.style.backgroundColor, /var\(--top-tab-active-bg,/);
});

test('custom CSS help mentions the top tab hooks in every locale', () => {
  for (const locale of LOCALES) {
    const desc = locale.messages['settings.appearance.customCss.desc'];
    const help = locale.messages['settings.appearance.customCss.help.body'];
    const placeholder = locale.messages['settings.appearance.customCss.placeholder'];
    assert.equal(typeof desc, 'string', locale.name);
    assert.equal(typeof help, 'string', locale.name);
    assert.equal(typeof placeholder, 'string', locale.name);
    for (const hook of HOOKS) {
      assert.ok(!desc.includes(hook), `${locale.name} description should keep ${hook} inside help modal`);
      assert.ok(help.includes(hook), `${locale.name} help missing ${hook}`);
      assert.ok(placeholder.includes(hook), `${locale.name} placeholder missing ${hook}`);
    }
    assert.match(help, /\.top-tab\[data-active="true"\]/);
    assert.match(placeholder, /\.top-tab\[data-active="true"\]/);
  }
});
