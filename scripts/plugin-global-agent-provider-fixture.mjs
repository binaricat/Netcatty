import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Deterministic isolated QA only. No inference, outbound network, persistence,
// request/body/header logs, or actual terminal. A test-owned worker records tools.
export function createGlobalAgentProviderFixture({ delayMs = 20, toolName = 'terminal_execute', sessionId = 'synthetic-b' } = {}) {
  const counts = { requests: 0, completed: 0, aborted: 0, rejected: 0 };
  const allowed = new Set(['get_environment', 'terminal_execute', 'terminal_start', 'terminal_poll', 'terminal_stop', 'terminal_read_context']);
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/fixture/status') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ fixture: true, inference: false, ...counts })); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let payload; let body = ''; let bytes = 0;
    try {
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_048_576) throw Error('Bounds'); body += chunk; }
      payload = JSON.parse(body);
      if (payload.model !== 'global-agent-fixture' || payload.stream !== true || !Array.isArray(payload.messages)
        || payload.tools?.some((entry) => !allowed.has(entry.function?.name))) throw Error('Shape');
    } catch { counts.rejected++; response.writeHead(400); response.end(); return; }
    counts.requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'global-agent-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'global-agent-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const hasResult = payload.messages.some((message) => message.role === 'tool');
    const requestTool = !hasResult && payload.tools?.some((entry) => entry.function?.name === toolName);
    const lastUser = [...payload.messages].reverse().find((message) => message.role === 'user');
    const wait = typeof lastUser?.content === 'string' && lastUser.content.includes('fixture:wait');
    let finished = false; let index = 0;
    const parts = wait ? Array(80).fill('Synthetic waiting output. ') : ['Synthetic global ', 'Agent result.'];
    const timer = setInterval(() => {
      if (requestTool) {
        const args = toolName === 'get_environment' ? {} : { sessionId, command: 'printf synthetic_fixture' };
        send({ tool_calls: [{ index: 0, id: 'fixture_call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] });
        send({}, 'tool_calls');
      } else if (index < parts.length) { send({ content: parts[index++] }); return; }
      else send({}, 'stop');
      response.write(`data: ${JSON.stringify({ id: 'global-agent-fixture', object: 'chat.completion.chunk', created: 1,
        model: 'global-agent-fixture', choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
      finished = true; counts.completed++; clearInterval(timer); response.end('data: [DONE]\n\n');
    }, delayMs);
    response.once('close', () => { clearInterval(timer); if (!finished) counts.aborted++; });
  });
  return { server, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port'); const port = i < 0 ? 9218 : Number(process.argv[i + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid fixture port');
  const { server } = createGlobalAgentProviderFixture({ toolName: 'get_environment', delayMs: 250 });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`DETERMINISTIC_AGENT_FIXTURE http://127.0.0.1:${port}/v1\nNo model inference or paid API.\n`));
  server.on('error', () => { process.stderr.write('Fixture could not bind its loopback port.\n'); process.exitCode = 1; });
  process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
}
