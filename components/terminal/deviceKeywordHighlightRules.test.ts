import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES,
  isDeviceConsoleHost,
  resolveDeviceConsoleKeywordHighlightRules,
} from './deviceKeywordHighlightRules.ts';

const ruleById = (id: string) => {
  const rule = DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES.find((entry) => entry.id === id);
  assert.ok(rule, `missing rule ${id}`);
  return rule;
};

const matches = (id: string, line: string): boolean =>
  ruleById(id).patterns.some((pattern) => new RegExp(pattern, 'gi').test(line));

test('serial and eNSPro sessions are device consoles regardless of device type', () => {
  assert.equal(isDeviceConsoleHost({ protocol: 'serial' }), true);
  assert.equal(isDeviceConsoleHost({ protocol: 'ensp' }), true);
  assert.equal(isDeviceConsoleHost({ protocol: 'telnet', deviceType: 'network' }), true);
  assert.equal(isDeviceConsoleHost({ protocol: 'ssh', deviceType: 'network' }), true);
});

test('plain shells keep their global rules only', () => {
  assert.equal(isDeviceConsoleHost({ protocol: 'ssh' }), false);
  assert.equal(isDeviceConsoleHost({ protocol: 'local' }), false);
  assert.equal(isDeviceConsoleHost({ protocol: 'mosh' }), false);
  assert.deepEqual(resolveDeviceConsoleKeywordHighlightRules({ protocol: 'ssh' }), []);
  assert.deepEqual(resolveDeviceConsoleKeywordHighlightRules(null), []);
});

test('telnet is treated as a device console even without a device type hint', () => {
  assert.equal(isDeviceConsoleHost({ protocol: 'telnet', deviceType: 'general' }), true);
  assert.equal(isDeviceConsoleHost({ protocol: 'telnet' }), true);
});

test('device consoles receive the built-in network rule set', () => {
  const rules = resolveDeviceConsoleKeywordHighlightRules({ protocol: 'serial' });
  assert.equal(rules, DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES);
  assert.ok(rules.length >= 5);
  for (const rule of rules) {
    assert.ok(rule.color.startsWith('#'));
    assert.ok(rule.patterns.length > 0);
  }
});

test('every device pattern compiles and rejects nothing silently', () => {
  for (const rule of DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES) {
    assert.doesNotThrow(() => new RegExp(rule.patterns[0], 'gi'));
    assert.equal(new RegExp(rule.patterns[0], 'gi').test(''), false);
  }
});

test('CLI rejections, link state, paging and prompts are matched', () => {
  assert.equal(matches('device-cli-reject', "% Invalid input detected at '^' marker."), true);
  assert.equal(matches('device-cli-reject', '                                          ^'), false);
  assert.equal(matches('device-admin-down', 'GigabitEthernet1/0/2 is administratively down, line protocol is down'), true);
  assert.equal(matches('device-link-down', 'GigabitEthernet1/0/1 is down, line protocol is down'), true);
  assert.equal(matches('device-link-up', 'MEth0/0/0 current state : UP'), true);
  assert.equal(matches('device-paging', '  ---- More ----'), true);
  assert.equal(matches('device-prompt', '<H3C>'), true);
  assert.equal(matches('device-prompt', 'Cat8kv#'), true);
  assert.equal(matches('device-prompt', 'show version'), false);
});

test('the echoed command after a prompt is matched on its own', () => {
  assert.equal(matches('device-command', '<H3C>display version'), true);
  assert.equal(matches('device-command', 'Cat8kv#show ip interface brief'), true);
  assert.equal(matches('device-command', '[H3C]interface GigabitEthernet 0/0/1'), true);
  assert.equal(matches('device-command', '<H3C>'), false);
  assert.equal(matches('device-command', 'GigabitEthernet1 is up'), false);
});

test('disabling device console highlighting yields no extra rules', () => {
  assert.deepEqual(resolveDeviceConsoleKeywordHighlightRules({ protocol: 'serial' }, false), []);
  assert.deepEqual(resolveDeviceConsoleKeywordHighlightRules({ protocol: 'telnet' }, false), []);
});

test('administratively down takes priority over the generic down rule', () => {
  const adminIndex = DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES.findIndex((rule) => rule.id === 'device-admin-down');
  const downIndex = DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES.findIndex((rule) => rule.id === 'device-link-down');
  assert.ok(adminIndex >= 0 && downIndex >= 0);
  assert.ok(adminIndex < downIndex);
});
