import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildPluginPaletteItems,
  getQuickSwitcherRowStateClass,
  shouldUseQuickSwitcherPointerNavigation,
} from './QuickSwitcher';

test('keeps the new workspace action outside the scrollable results', () => {
  const source = readFileSync(new URL('./QuickSwitcher.tsx', import.meta.url), 'utf8');
  const actionIndex = source.indexOf('{/* Jump To hint + New Workspace action */}');
  const resultsScrollIndex = source.indexOf('<ScrollArea className="flex-1 h-full">');

  assert.notEqual(actionIndex, -1);
  assert.notEqual(resultsScrollIndex, -1);
  assert.ok(actionIndex < resultsScrollIndex);
});

test('pointer hover never rewrites the keyboard selection', () => {
  const quickSwitcherSource = readFileSync(new URL('./QuickSwitcher.tsx', import.meta.url), 'utf8');
  const workspacePickerSource = readFileSync(new URL('./workspace/AddToWorkspaceDialog.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(quickSwitcherSource, /onMouseEnter/);
  assert.doesNotMatch(quickSwitcherSource, /selectWithPointer/);
  assert.doesNotMatch(workspacePickerSource, /onMouseEnter/);
  assert.doesNotMatch(workspacePickerSource, /onMouseMove/);
});

test('keyboard navigation shows only the current keyboard selection', () => {
  assert.equal(getQuickSwitcherRowStateClass(true, true), 'bg-primary/15');
  assert.equal(getQuickSwitcherRowStateClass(false, true), '');
  assert.equal(getQuickSwitcherRowStateClass(false, false), 'hover:bg-muted/50');
});

test('layout movement under a stationary pointer cannot take over keyboard navigation', () => {
  assert.equal(shouldUseQuickSwitcherPointerNavigation(0, 0), false);
  assert.equal(shouldUseQuickSwitcherPointerNavigation(1, 0), true);
  assert.equal(shouldUseQuickSwitcherPointerNavigation(0, -1), true);
});

function pluginSnapshot(menuEnabled: boolean): NetcattyPluginContributionSnapshot['plugins'] {
  return [{
    id: 'com.example.palette',
    version: '1.0.0',
    displayName: 'Palette plugin',
    description: '',
    commands: [{
      id: 'com.example.palette.run',
      title: 'Run command',
      enabled: true,
    }],
    keybindings: [],
    menus: [{
      id: 'com.example.palette:menu:0',
      command: 'com.example.palette.run',
      alt: 'com.example.palette.runAlternate',
      location: 'commandPalette',
      title: 'Run from palette',
      visible: true,
      enabled: menuEnabled,
      shortcut: 'ctrl+shift+r',
    }],
    settings: [],
    views: [],
  }];
}

test('plugin palette items preserve menu-specific enablement', () => {
  assert.deepEqual(buildPluginPaletteItems(pluginSnapshot(false), ''), [{
    type: 'plugin-command',
    id: 'com.example.palette:menu:0',
    commandId: 'com.example.palette.run',
    title: 'Run from palette',
    pluginTitle: 'Palette plugin',
    pluginId: 'com.example.palette',
    enabled: false,
    altCommand: 'com.example.palette.runAlternate',
    shortcut: 'ctrl+shift+r',
  }]);
  assert.equal(buildPluginPaletteItems(pluginSnapshot(true), '')[0]?.enabled, true);
});

test('plugin palette items honor declared menu ordering', () => {
  const plugins = pluginSnapshot(true);
  const plugin = plugins[0];
  const ordered = [{
    ...plugin,
    commands: [
      ...plugin.commands,
      { id: 'com.example.palette.first', title: 'First command', enabled: true },
    ],
    menus: [
      { ...plugin.menus[0], group: 'navigation', order: 20 },
      {
        ...plugin.menus[0],
        id: 'com.example.palette:menu:1',
        command: 'com.example.palette.first',
        title: 'First from palette',
        group: 'navigation',
        order: 10,
      },
    ],
  }];
  assert.deepEqual(buildPluginPaletteItems(ordered, '').map((item) => item.id), [
    'com.example.palette:menu:1',
    'com.example.palette:menu:0',
  ]);
});

test('plugin palette items keep repeated placements independently addressable', () => {
  const plugins = pluginSnapshot(true);
  plugins[0].menus.push({
    ...plugins[0].menus[0],
    id: 'com.example.palette:menu:1',
    title: 'Run another way',
  });

  const items = buildPluginPaletteItems(plugins, '');
  assert.deepEqual(items.map(({ id, commandId }) => ({ id, commandId })), [{
    id: 'com.example.palette:menu:0',
    commandId: 'com.example.palette.run',
  }, {
    id: 'com.example.palette:menu:1',
    commandId: 'com.example.palette.run',
  }]);
});
