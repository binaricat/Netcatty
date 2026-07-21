import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PortalContainerProvider, usePortalContainer } from './portal-container';

test('portal container is available to nested editor controls', () => {
  const marker = {} as HTMLElement;
  const Probe = () => <span>{usePortalContainer() === marker ? 'inside' : 'outside'}</span>;

  assert.equal(
    renderToStaticMarkup(
      <PortalContainerProvider container={marker}>
        <Probe />
      </PortalContainerProvider>,
    ),
    '<span>inside</span>',
  );
});

test('editor dropdown primitives use the scoped portal container', () => {
  for (const file of ['popover.tsx', 'select.tsx', 'tooltip.tsx']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /usePortalContainer\(\)/);
    assert.match(source, /Portal container=\{portalContainer \?\? undefined\}/);
  }
});
