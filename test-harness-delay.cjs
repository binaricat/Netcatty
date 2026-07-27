const { spawn } = require('child_process');
const WebSocket = require('ws');

const port = 44431;
const harness = spawn('/tmp/agy-sdk/google/antigravity/bin/localharness', [], {
  env: { ...process.env, ANTIGRAVITY_APP_DATA_DIR: '/tmp' },
  stdio: ['pipe', 'pipe', 'inherit']
});

harness.stdout.on('data', (data) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api_key=test`);
  ws.on('open', () => {
    ws.send(JSON.stringify({
      config: {
        cascade_id: "00000000000000000000000000000000",
        session_continuation_mode: 'CREATE_OR_RESUME',
        models: [{ name: "gemini", types: ["MODEL_TYPE_TEXT"] }]
      }
    }));
    // NO DELAY
    ws.send(JSON.stringify({ user_input: "hello" }));
  });
  ws.on('message', (msg) => console.log('RECV:', msg.toString()));
});
