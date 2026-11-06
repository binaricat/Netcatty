import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Isolated QA only: deterministic SSE, no model, outbound request, credentials,
// disk persistence, or request-body/header logging.
export function createAssistantProviderFixture({ delayMs = 250 } = {}) {
  const counts = { requests: 0, completed: 0, aborted: 0 };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/fixture/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ fixture: true, inference: false, ...counts })); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; let bytes = 0;
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 65_536) { response.writeHead(413); response.end(); return; }
        body += chunk;
      }
      const payload = JSON.parse(body);
      if (payload.model !== 'deterministic-fixture' || payload.stream !== true || payload.tools !== undefined || payload.tool_choice !== undefined
        || !Array.isArray(payload.messages) || payload.messages.some((message) => message.role === 'system' || message.role === 'tool')
        || Number(payload.max_tokens ?? payload.max_completion_tokens ?? 2048) > 2048) {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Fixture accepts only a tool-free synthetic chat stream"}}'); return;
      }
    } catch { response.writeHead(400); response.end(); return; }
    counts.requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'deterministic-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'deterministic-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant' });
    const parts = ['Synthetic plan: ', 'add a retry button ', 'and show ', 'a connection ', 'status label.'];
    let index = 0; let finished = false;
    const timer = setInterval(() => {
      if (index < parts.length) { send({ content: parts[index++] }); return; }
      send({}, 'stop');
      response.write(`data: ${JSON.stringify({ id: 'deterministic-fixture', object: 'chat.completion.chunk', created: 1,
        model: 'deterministic-fixture', choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
      finished = true; counts.completed++; clearInterval(timer); response.end('data: [DONE]\n\n');
    }, delayMs);
    response.once('close', () => { clearInterval(timer); if (!finished) counts.aborted++; });
  });
  return { server, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const position = process.argv.indexOf('--port');
  const port = position === -1 ? 9217 : Number(process.argv[position + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid fixture port');
  const { server } = createAssistantProviderFixture();
  server.listen(port, '127.0.0.1', () => process.stdout.write(`DETERMINISTIC_FIXTURE http://127.0.0.1:${port}/v1\nSTATUS http://127.0.0.1:${port}/fixture/status\nNo model inference or paid API.\n`));
  server.on('error', () => { process.stderr.write('Fixture could not bind its loopback port.\n'); process.exitCode = 1; });
  process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
}
