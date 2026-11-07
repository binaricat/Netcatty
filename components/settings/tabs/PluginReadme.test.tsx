import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginReadme } from './PluginReadme';

test('README never creates active HTML, remote media or script links', () => {
  const html = renderToStaticMarkup(<PluginReadme markdown={'# Example\n\n<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel">\n\n![track](https://tracker.example/x.svg)\n\n[run](javascript:alert%281%29)\n\n[docs](https://example.com)\n\n```html\n<iframe src="file:///secret">\n```'} />);
  assert.doesNotMatch(html, /<(script|img|iframe|svg)\b/);
  assert.doesNotMatch(html, /href="(javascript|file):/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /&lt;script&gt;/);
});

test('README only renders registered local rasterized images and placeholders otherwise', () => {
  const path = `/assets/${'a'.repeat(64)}.png`;
  const html = renderToStaticMarkup(<PluginReadme markdown={`![ok](${path}) ![tracker](https://evil.test/x) ![bad](/unknown)`} images={{ [path]: 'data:image/png;base64,YQ==' }} />);
  assert.match(html, /src="data:image\/png;base64,YQ=="/);
  assert.match(html, /\[tracker\]/);
  assert.match(html, /\[bad\]/);
  assert.doesNotMatch(html, /evil\.test/);
});
