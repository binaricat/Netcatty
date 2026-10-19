/* global __dirname */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const format = require('./issue-format.cjs');

const body = [
  '## Describe the problem',
  'Upload fails on large files on the same LAN path.',
  '## Steps to reproduce',
  '1. Open SFTP and upload a large file.',
  '## Expected behavior',
  'Upload succeeds.',
  '## Actual behavior',
  'Upload fails.',
  '## Operating system',
  'Windows 11',
].join('\n');

test('title validation preserves modern, legacy, and short CJK titles', () => {
  for (const title of [
    '[Bug] SFTP upload fails',
    '[bug]upload fails',
    '[FEATURE] Sort by IP address',
    '[Other] Discussion topic',
    '[Bug]\u4e0a\u4f20\u901f\u5ea6\u592a\u6162\u4e86',
    '[Feature] \u6309IP\u6392\u5e8f',
    'Bug: upload fails',
    'Bug:\u4e0a\u4f20\u592a\u6162\u4e86',
  ]) {
    assert.equal(format.isValidIssueTitle(title), true, title);
  }
  for (const title of ['', '[Bug]', '[Bug] ab', '[Bug] \u6162', 'Upload fails']) {
    assert.equal(format.isValidIssueTitle(title), false, title);
  }
});

test('format validation preserves required title, body length, and template structure', () => {
  assert.deepEqual(format.getIssueFormatErrors({ title: '[Bug] Upload fails', body }), []);
  assert.equal(format.getIssueFormatErrors({ title: 'Upload fails', body }).length, 1);
  assert.match(
    format.getIssueFormatErrors({ title: '[Bug] Upload fails', body: 'Steps to reproduce: upload' })[0],
    /Body is too short/,
  );
  assert.match(
    format.getIssueFormatErrors({ title: '[Bug] Upload fails', body: 'x'.repeat(120) })[0],
    /issue template/,
  );
  assert.equal(format.getIssueFormatErrors(null).length, 3);
});

test('only valid issues marked invalid-format are eligible for recovery', () => {
  for (const state of ['open', 'closed']) {
    for (const labels of [['invalid-format'], [{ name: 'invalid-format' }]]) {
      assert.deepEqual(format.shouldRecoverIssueFormat({ state, labels, formatOk: true }), {
        recover: true, reopen: state === 'closed',
      });
      assert.deepEqual(format.shouldRecoverIssueFormat({ state, labels, formatOk: false }), {
        recover: false, reopen: false,
      });
    }
  }
  assert.deepEqual(format.shouldRecoverIssueFormat({
    state: 'closed', labels: ['bug'], formatOk: true,
  }), { recover: false, reopen: false });
});

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'issue-format.yml'), 'utf8',
);
const script = workflow.split('          script: |\n')[1]
  .split('\n').map((line) => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const validate = new AsyncFunction('require', 'process', 'context', 'github', 'core', script);

// Run the actual workflow script. No Actions API is provided: recovery must
// work without dispatching another workflow or needing actions:write.
async function runWorkflow(issue, comments = [], updateError) {
  const updates = [];
  const replies = [];
  await validate(require, { env: { GITHUB_WORKSPACE: path.join(__dirname, '..') } }, {
    repo: { owner: 'owner', repo: 'repo' }, payload: { issue: { number: 42, ...issue } },
  }, {
    rest: {
      issues: {
        listComments: async () => ({ data: comments }),
        update: async (update) => {
          if (updateError) throw updateError;
          updates.push(update);
        },
        createComment: async (reply) => { replies.push(reply); },
      },
    },
  }, { info: () => {} });
  return { updates, replies };
}

test('workflow accepts valid issues without posting or changing them', async () => {
  assert.deepEqual(await runWorkflow({ title: '[Bug] Upload fails', body, state: 'open' }), {
    updates: [], replies: [],
  });
});

test('workflow closes invalid issues, preserves labels, and posts format guidance once', async () => {
  const issue = { title: 'Help', body: 'short', labels: [{ name: 'bug' }], state: 'open' };
  const first = await runWorkflow(issue);
  assert.deepEqual(first.updates, [{
    owner: 'owner', repo: 'repo', issue_number: 42,
    state: 'closed', state_reason: 'not_planned', labels: ['bug', 'invalid-format'],
  }]);
  assert.equal(first.replies.length, 1);
  assert.match(first.replies[0].body, /Issue format check failed/);
  const repeated = await runWorkflow(issue, first.replies);
  assert.equal(repeated.replies.length, 0);
  assert.equal(repeated.updates.length, 1);
});

test('workflow reopens corrected issues and removes only invalid-format without dispatch', async () => {
  const result = await runWorkflow({
    title: '[Bug] Upload fails', body, state: 'closed',
    labels: [{ name: 'invalid-format' }, { name: 'bug' }, { name: 'needs-info' }],
  });
  assert.deepEqual(result.updates, [{
    owner: 'owner', repo: 'repo', issue_number: 42,
    state: 'open', labels: ['bug', 'needs-info'],
  }]);
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].body, /Reopening this issue\./);
});

test('workflow clears invalid-format from corrected open issues without changing state', async () => {
  const result = await runWorkflow({
    title: '[Feature] Sort by IP', body, state: 'open', labels: ['invalid-format', 'enhancement'],
  });
  assert.deepEqual(result.updates, [{
    owner: 'owner', repo: 'repo', issue_number: 42, labels: ['enhancement'],
  }]);
  assert.match(result.replies[0].body, /Removed the invalid-format label/);
});

test('workflow leaves valid manually closed issues closed without an invalid-format label', async () => {
  assert.deepEqual(await runWorkflow({
    title: '[Bug] Upload fails', body, state: 'closed', labels: ['bug'],
  }), { updates: [], replies: [] });
});

test('workflow reports a failed recovery update instead of posting a success reply', async () => {
  await assert.rejects(runWorkflow({
    title: '[Bug] Upload fails', body, state: 'closed', labels: ['invalid-format'],
  }, [], new Error('update failed')), /update failed/);
});
