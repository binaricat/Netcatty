/* global __dirname, process, setTimeout, clearTimeout, console */
// Opt-in real Claude Code permission check; all model traffic stays on loopback.
// Usage: node scripts/fixtures/research-permission-probe.cjs [claude executable]
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareAiCliSettings } = require('../ai-automation.cjs');
const repository = path.resolve(__dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-research-permission-'));
const settings = path.join(root, 'settings.json');
prepareAiCliSettings({ configPath: settings, denyWeb: true, allowBrave: true, allowWrites: false });
for (const name of ['web-search', 'web-fetch', 'unrelated-helper']) {
  fs.writeFileSync(path.join(root, name), '#!/bin/sh\nprintf RESEARCH_FIXTURE_OK\n', { mode: 0o755 });
}
const workflow = fs.readFileSync(path.join(repository, '.github/workflows/ai-automation.yml'), 'utf8');
const blocks = [...workflow.matchAll(/--allowedTools "Read" "Bash\(web-search \*\)"([\s\S]*?)--disallowedTools/g)];
assert.equal(blocks.length, 2, 'classification and follow-up research must both be checked');
let command;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', data => { raw += data; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('count_tokens')) {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"input_tokens":10}');
      return;
    }
    const finished = (body.messages || []).some(message => Array.isArray(message.content)
      && message.content.some(item => item.type === 'tool_result'));
    const block = finished ? { type: 'text', text: 'DONE' }
      : { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: { command } };
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
      content: [block], stop_reason: finished ? 'end_turn' : 'tool_use', stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10 } };
    if (!body.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(message));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null } });
    emit('content_block_start', { index: 0, content_block: finished
      ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { index: 0, delta: finished
      ? { type: 'text_delta', text: 'DONE' }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    emit('message_stop', {});
    res.end();
  });
});
async function check(index, helper, expectRun, baseline = false) {
  const allowed = [...blocks[index][0].split('--disallowedTools')[0].matchAll(/"([^"]+)"/g)]
    .map(match => match[1].replaceAll('$research_dir', root))
    .filter(rule => !baseline || !rule.includes(root));
  command = `${path.join(root, helper)} smoke 2>&1 | head -40`;
  const args = ['--bare', '-p', '--permission-mode', 'dontAsk', '--settings', settings,
    '--allowedTools', ...allowed, '--disallowedTools', 'WebSearch', 'WebFetch', 'Edit', 'Write', 'NotebookEdit',
    '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', 'Run the approved helper once.'];
  const env = { PATH: `${root}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR, CLAUDE_CONFIG_DIR: path.join(root, 'config'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'synthetic-local-fixture',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  let output = '', errors = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.argv[2] || 'claude', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', value => { clearTimeout(timeout); resolve(value); });
  });
  assert.equal(code, 0, errors);
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  const result = events.findLast(event => event.type === 'result');
  assert.ok(result, 'Claude must finish the model/tool turn');
  const ran = events.some(event => Array.isArray(event.message?.content)
    && event.message.content.some(item => item.type === 'tool_result'
      && JSON.stringify(item.content).includes('RESEARCH_FIXTURE_OK') && !item.is_error));
  assert.equal(ran, expectRun, `${index}:${helper}:baseline=${baseline}`);
  assert.equal((result.permission_denials || []).length, expectRun ? 0 : 1);
  console.log(JSON.stringify({ route: index === 0 ? 'classification' : 'follow-up', helper, baseline, ran }));
}
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const index of [0, 1]) {
      await check(index, 'web-search', false, true);
      await check(index, 'web-search', true);
      await check(index, 'web-fetch', true);
      await check(index, 'unrelated-helper', false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
