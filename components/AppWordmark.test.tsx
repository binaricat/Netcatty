import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppWordmark } from './AppWordmark';

test('AppWordmark renders decorative fixed vector outlines without font-dependent text', () => {
  const markup = renderToStaticMarkup(<AppWordmark className="h-5" />);

  assert.match(markup, /<path /);
  assert.match(markup, /aria-hidden="true"/);
  assert.doesNotMatch(markup, /<text/);
  assert.doesNotMatch(markup, /font-family/);
  assert.match(markup, /class="h-5"/);
});

test('AppWordmark exposes an accessible product name when requested', () => {
  const markup = renderToStaticMarkup(
    <AppWordmark accessibleLabel="Netcatty" className="h-8" />,
  );

  assert.match(markup, /aria-label="Netcatty"/);
  assert.match(markup, /role="img"/);
  assert.doesNotMatch(markup, /aria-hidden/);
});
