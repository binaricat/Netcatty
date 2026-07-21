import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../application/i18n/I18nProvider';
import {
  TerminalHostTreeToolbar,
  TERMINAL_HOST_TREE_TOOLBAR_MIN_REQUIRED_WIDTH,
} from './TerminalHostTreeToolbar';
import { TooltipProvider } from '../ui/tooltip';

const toolbarSource = readFileSync(new URL('./TerminalHostTreeToolbar.tsx', import.meta.url), 'utf8');
const menuSource = readFileSync(new URL('../host/HostTreeContextMenus.tsx', import.meta.url), 'utf8');

test('host tree toolbar keeps the close button outside the compact action row', () => {
  const source = readFileSync(new URL('./TerminalHostTreeToolbar.tsx', import.meta.url), 'utf8');

  assert.match(source, /data-section="terminal-host-tree-toolbar-actions"/);
  assert.match(source, /data-section="terminal-host-tree-toolbar-close"/);
  assert.match(source, /data-section="terminal-host-tree-toolbar"/);
  assert.match(source, /backgroundColor: theme\.termBg/);
  assert.doesNotMatch(source, /terminal-host-tree-toolbar-actions-fade/);
});

test('host tree toolbar keeps every action reachable at the minimum sidebar width', () => {
  const source = toolbarSource;

  assert.ok(TERMINAL_HOST_TREE_TOOLBAR_MIN_REQUIRED_WIDTH <= 160);
  assert.match(source, /<PopoverContent className="w-44 p-1"/);
  assert.match(source, /<FolderPlus size=\{14\} \/>/);
  assert.match(source, /<TerminalSquare size=\{14\} \/>/);
  assert.match(source, /<Expand size=\{14\} \/>/);
  assert.match(source, /<Minimize2 size=\{14\} \/>/);
  assert.match(source, /disabled=\{!canExpandCollapse\}/);
});

test('host tree toolbar exposes host creation alongside the context menus', () => {
  assert.match(toolbarSource, /onNewHost: \(\) => void/);
  assert.match(toolbarSource, /disabled=\{!canNewHost\}/);
  assert.match(toolbarSource, /onClick=\{onNewHost\}/);
  assert.match(toolbarSource, /<Plus size=\{14\} \/>/);
  assert.match(toolbarSource, /terminal\.layer\.hostTree\.newHost/);
});

test('host tree toolbar gives every icon-only control an accessible name', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(TerminalHostTreeToolbar, {
          theme: {
            termBg: '#000',
            termFg: '#fff',
            mutedFg: '#aaa',
            separator: '#333',
            rowHoverBg: '#222',
          },
          expandedPanel: null,
          onExpandedPanelChange: () => undefined,
          search: '',
          onSearchChange: () => undefined,
          allTags: [],
          selectedTags: [],
          onSelectedTagsChange: () => undefined,
          onNewHost: () => undefined,
          onNewRootGroup: () => undefined,
          onCreateLocalTerminal: () => undefined,
          onExpandAll: () => undefined,
          onCollapseAll: () => undefined,
          onCollapse: () => undefined,
        }),
      ),
    ),
  );

  assert.match(markup, /aria-label="New host"/);
  assert.match(markup, /aria-label="Search"/);
  assert.match(markup, /aria-label="Filter by tags"/);
  assert.match(markup, /aria-label="More actions"/);
  assert.match(markup, /aria-label="Collapse host list"/);
});

test('shared host tree menus expose optional full edit and group host creation actions', () => {
  assert.match(menuSource, /onEditHost\?: \(host: Host\) => void/);
  assert.match(menuSource, /onNewHost\?: \(groupPath: string\) => void/);
  assert.match(menuSource, /terminal\.layer\.hostTree\.editHost/);
  assert.match(menuSource, /terminal\.layer\.hostTree\.newHostInGroup/);
});

test('host tree sidebar wires expand/collapse and host creation availability', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /canExpandCollapse=\{canExpandCollapse\}/);
  assert.match(source, /canNewHost=\{Boolean\(onNewHost\)\}/);
  assert.doesNotMatch(source, /shouldCompactTerminalHostTreeToolbar/);
});
