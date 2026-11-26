import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  resetModelCatalogWarningDismissals,
  useModelCatalogWarningDismissal,
  type ModelCatalogWarningDismissalState,
} from './useModelCatalogWarningDismissal.ts';
import { isModelCatalogWarningVisible } from '../../components/AIChatSidePanelHelpers.ts';

test('useModelCatalogWarningDismissal dismisses per cacheKey, survives remounts, and rearms on clean catalog', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;

  (globalThis as Record<string, unknown>).window = dom.window;
  (globalThis as Record<string, unknown>).document = dom.window.document;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  resetModelCatalogWarningDismissals();

  let latest!: ModelCatalogWarningDismissalState;
  const Probe: React.FC = () => {
    latest = useModelCatalogWarningDismissal();
    return null;
  };

  const container = dom.window.document.getElementById('root')!;
  let root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(Probe));
    });

    assert.equal(latest.dismissedKeys.size, 0);
    const warningK1 = { cacheKey: 'k1', message: 'Catalog unavailable' };
    const warningK2 = { cacheKey: 'k2', message: 'Other catalog unavailable' };
    assert.equal(
      isModelCatalogWarningVisible(warningK1, 'k1', latest.dismissedKeys),
      'Catalog unavailable',
    );

    // Dismissing k1 hides only k1, leaving k2 visible.
    await React.act(async () => {
      latest.dismissWarning('k1');
    });
    assert.equal(latest.dismissedKeys.has('k1'), true);
    assert.equal(isModelCatalogWarningVisible(warningK1, 'k1', latest.dismissedKeys), undefined);
    assert.equal(
      isModelCatalogWarningVisible(warningK2, 'k2', latest.dismissedKeys),
      'Other catalog unavailable',
    );

    // Unmounting and remounting (e.g., empty panel hidden on tab/tool switch)
    // must keep the dismissed cacheKey hidden until a clean catalog arrives.
    await React.act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
    });
    assert.equal(latest.dismissedKeys.has('k1'), true);
    assert.equal(isModelCatalogWarningVisible(warningK1, 'k1', latest.dismissedKeys), undefined);

    // Undefined and duplicate dismissals are no-ops that keep state identity.
    const setBeforeNoop = latest.dismissedKeys;
    await React.act(async () => {
      latest.dismissWarning(undefined);
      latest.dismissWarning('k1');
    });
    assert.equal(latest.dismissedKeys, setBeforeNoop);

    // A clean catalog for k1 re-arms k1 so future failures surface again.
    await React.act(async () => {
      latest.rearmWarning('k1');
    });
    assert.equal(latest.dismissedKeys.has('k1'), false);
    assert.equal(
      isModelCatalogWarningVisible(warningK1, 'k1', latest.dismissedKeys),
      'Catalog unavailable',
    );

    // Rearming a non-dismissed or undefined key is a no-op.
    const setAfterRearm = latest.dismissedKeys;
    await React.act(async () => {
      latest.rearmWarning('k1');
      latest.rearmWarning(undefined);
    });
    assert.equal(latest.dismissedKeys, setAfterRearm);
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    resetModelCatalogWarningDismissals();
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).document = prevDocument;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});

test('AIChatPanelContent keeps raw modelCatalogWarning for ChatInput when banner is dismissed', () => {
  const panelSource = readFileSync(new URL('../../components/AIChatPanelContent.tsx', import.meta.url), 'utf8');
  const sidePanelSource = readFileSync(new URL('../../components/AIChatSidePanel.tsx', import.meta.url), 'utf8');

  assert.match(
    panelSource,
    /modelCatalogWarning && !modelCatalogWarningDismissed \?/,
    'banner visibility must check modelCatalogWarningDismissed separately from raw modelCatalogWarning',
  );
  assert.match(
    panelSource,
    /<ChatInput[\s\S]*?modelCatalogWarning=\{modelCatalogWarning\}/,
    'ChatInput must still receive the raw modelCatalogWarning so ComposerModelPicker keeps its refresh action',
  );
  assert.match(
    sidePanelSource,
    /useModelCatalogWarningDismissal\(\)/,
    'AIChatSidePanel must consume the application/state dismissal hook rather than owning inline dismissal state',
  );
});
