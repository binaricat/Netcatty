import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPluginViewBadgeAriaText,
  formatPluginViewBadgeLabel,
  isPluginViewBadgeVisible,
} from './pluginViewBadge';

test('formatPluginViewBadgeLabel formats counts, 99+ overflow, text, and clears empty badges', () => {
  assert.equal(formatPluginViewBadgeLabel({ count: 1 }), '1');
  assert.equal(formatPluginViewBadgeLabel({ count: 99 }), '99');
  assert.equal(formatPluginViewBadgeLabel({ count: 100 }), '99+');
  assert.equal(formatPluginViewBadgeLabel({ count: 999 }), '99+');
  assert.equal(formatPluginViewBadgeLabel({ count: 0 }), null);
  assert.equal(formatPluginViewBadgeLabel({ text: 'NEW' }), 'NEW');
  assert.equal(formatPluginViewBadgeLabel({ text: '  ' }), null);
  assert.equal(formatPluginViewBadgeLabel({ count: 5, text: 'NEW' }), '5');
  assert.equal(formatPluginViewBadgeLabel(null), null);
});

test('isPluginViewBadgeVisible and formatPluginViewBadgeAriaText handle dot, text, count, and tooltip', () => {
  assert.equal(isPluginViewBadgeVisible(null), false);
  assert.equal(isPluginViewBadgeVisible({ pluginId: 'com.a.b', viewId: 'com.a.b.v', tone: 'default' }), false);
  assert.equal(isPluginViewBadgeVisible({ pluginId: 'com.a.b', viewId: 'com.a.b.v', dot: true, tone: 'info' }), true);
  assert.equal(
    formatPluginViewBadgeAriaText({ pluginId: 'com.a.b', viewId: 'com.a.b.v', dot: true, tone: 'info' }),
    'notification',
  );
  assert.equal(
    formatPluginViewBadgeAriaText({ pluginId: 'com.a.b', viewId: 'com.a.b.v', count: 3, tone: 'warning' }),
    '3',
  );
  assert.equal(
    formatPluginViewBadgeAriaText({
      pluginId: 'com.a.b',
      viewId: 'com.a.b.v',
      count: 3,
      tone: 'danger',
      tooltip: '3 critical alerts',
    }),
    '3 critical alerts',
  );
});
