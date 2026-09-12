'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const brave = require('./ai-brave-search.cjs');

test('isPrivateHostname blocks loopback and RFC1918', () => {
  assert.equal(brave.isPrivateHostname('localhost'), true);
  assert.equal(brave.isPrivateHostname('127.0.0.1'), true);
  assert.equal(brave.isPrivateHostname('10.0.0.8'), true);
  assert.equal(brave.isPrivateHostname('192.168.1.9'), true);
  assert.equal(brave.isPrivateHostname('::ffff:127.0.0.1'), true);
  assert.equal(brave.isPrivateHostname('[::1]'), true);
  assert.equal(brave.isPrivateHostname('example.com'), false);
});

test('extractUrlsFromSearch keeps https results only', () => {
  const extracted = brave.extractUrlsFromSearch({
    web: {
      results: [
        { title: 'Docs', url: 'https://example.com/docs', description: 'Official' },
        { title: 'Insecure', url: 'http://example.com/old', description: 'Skip' },
      ],
    },
  });
  assert.deepEqual(extracted.urls, ['https://example.com/docs']);
  assert.equal(extracted.results[0].title, 'Docs');
});

test('stripHtml removes tags and scripts', () => {
  const text = brave.stripHtml('<html><script>alert(1)</script><p>Hello world</p></html>');
  assert.match(text, /Hello world/);
  assert.doesNotMatch(text, /alert/);
});
