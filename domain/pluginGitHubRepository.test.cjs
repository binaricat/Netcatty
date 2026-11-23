"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePluginGitHubRepository: parse } = require('./pluginGitHubRepository.cjs');
const { githubSource, assertSource } = require('../electron/plugins/sourceIdentity.cjs');

test('all Qi input forms, http, case and optional suffixes resolve to one repository and source identity', () => {
  const expected = { owner: 'owner', repo: 'repo', repository: 'owner/repo', origin: 'https://github.com/owner/repo' };
  for (const input of ['https://github.com/owner/repo', 'github.com/owner/repo', 'owner/repo', 'http://github.com/owner/repo.git/', 'HTTPS://GITHUB.COM/Owner/Repo/', ' Owner/Repo.git ']) {
    assert.deepEqual(parse(input), expected, input);
    assert.deepEqual(githubSource(input), githubSource(expected.origin), input);
    assert.deepEqual(assertSource(githubSource(input)), githubSource(expected.origin));
  }
});

test('repository grammar rejects arbitrary hosts, scripts/assets, extra paths, normalization tricks and credentials', () => {
  for (const input of ['', null, {}, 'github.com', 'https://evil.com/owner/repo', 'git@github.com:owner/repo', 'ftp://github.com/owner/repo', '//github.com/owner/repo', 'https://github.com:443/owner/repo', 'https://user:pass@github.com/owner/repo', 'owner/repo?x', 'owner/repo#x', 'owner/repo/', 'owner/repo/tree/main', 'https://github.com/owner/repo/releases/download/v1/plugin.ncpkg', 'owner/repo/../../other', 'owner/%2e%2e', 'owner/..', 'owner/.git', 'owner/repo.git.git', 'ow--ner/repo', '-owner/repo', 'owner-/repo', 'owner/repo\\path', 'owner/repo\npath', 'javascript:alert(1)', 'https://github.com/owner/repo//']) {
    // A single trailing slash is intentionally accepted for shorthand as well.
    if (input === 'owner/repo/') { assert.equal(parse(input).repository, 'owner/repo'); continue; }
    assert.throws(() => parse(input), /Use https/, String(input));
  }
  assert.throws(() => assertSource({ ...githubSource('owner/repo'), id: 'official' }), /Invalid host/);
});
