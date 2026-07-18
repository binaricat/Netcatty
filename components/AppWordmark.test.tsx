import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppWordmark } from './AppWordmark';

test('AppWordmark renders fixed vector outlines without font-dependent text', () => {
  const markup = renderToStaticMarkup(<AppWordmark className="h-5" />);

  assert.match(markup, /<path /);
  assert.doesNotMatch(markup, /<text/);
  assert.doesNotMatch(markup, /font-family/);
  assert.match(markup, /class="h-5"/);
});
