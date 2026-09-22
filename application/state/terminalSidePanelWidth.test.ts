import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampTerminalSidePanelHeight,
  clampTerminalSidePanelWidth,
  getTerminalSidePanelAvailableWidth,
  getTerminalSidePanelMaxShownTools,
  getTerminalSidePanelMaxWidth,
  getTerminalSidePanelAvailableHeight,
  getTerminalSidePanelMaxHeight,
  TERMINAL_SIDE_PANEL_MAX_HEIGHT,
  TERMINAL_SIDE_PANEL_MIN_HEIGHT,
  TERMINAL_SIDE_PANEL_MAX_WIDTH,
  TERMINAL_SIDE_PANEL_MIN_WIDTH,
} from './terminalSidePanelWidth.ts';

test('terminal side panel can expand to the wider maximum', () => {
  assert.equal(getTerminalSidePanelMaxWidth(2000), TERMINAL_SIDE_PANEL_MAX_WIDTH);
  assert.equal(clampTerminalSidePanelWidth(1400, 2000), TERMINAL_SIDE_PANEL_MAX_WIDTH);
});

test('terminal side panel collapses tool buttons before shared actions are clipped', () => {
  assert.equal(getTerminalSidePanelMaxShownTools(280), 2);
  assert.equal(getTerminalSidePanelMaxShownTools(320), 4);
  assert.ok(getTerminalSidePanelMaxShownTools(420) >= 7);
});

test('terminal side panel uses the actual surface left after fixed sibling panels', () => {
  assert.equal(getTerminalSidePanelAvailableWidth(780, 220), 560);
  assert.equal(getTerminalSidePanelMaxWidth(560), TERMINAL_SIDE_PANEL_MIN_WIDTH);
  assert.equal(clampTerminalSidePanelWidth(680, 560), TERMINAL_SIDE_PANEL_MIN_WIDTH);
});

test('terminal side panel keeps usable terminal space in smaller windows', () => {
  assert.equal(getTerminalSidePanelMaxWidth(1000), 680);
  assert.equal(clampTerminalSidePanelWidth(900, 1000), 680);
  assert.equal(clampTerminalSidePanelWidth(100, 1000), TERMINAL_SIDE_PANEL_MIN_WIDTH);
  assert.equal(clampTerminalSidePanelWidth(280, 1000, 401), 401);
  assert.equal(clampTerminalSidePanelWidth(280, 600, 401), TERMINAL_SIDE_PANEL_MIN_WIDTH);
});

test('terminal side panel bottom dock clamps height against surface height', () => {
  assert.equal(getTerminalSidePanelAvailableHeight(1000, 200), 800);
  assert.equal(getTerminalSidePanelMaxHeight(1000), 760);
  assert.equal(clampTerminalSidePanelHeight(900, 1000), 760);
  assert.equal(clampTerminalSidePanelHeight(100, 1000), TERMINAL_SIDE_PANEL_MIN_HEIGHT);
  assert.equal(clampTerminalSidePanelHeight(300, 1000, 500), 500);
  assert.equal(clampTerminalSidePanelHeight(5000, 4000), TERMINAL_SIDE_PANEL_MAX_HEIGHT);
});
