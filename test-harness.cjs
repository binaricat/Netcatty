const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

function varIntSize(val) {
  let size = 0;
  do {
    size++;
    val >>>= 7;
  } while (val > 0);
  return size;
}

function writeVarInt(buf, offset, val) {
  let written = 0;
  while (val >= 128) {
    buf[offset + written++] = (val & 0x7F) | 0x80;
    val >>>= 7;
  }
  buf[offset + written++] = val & 0x7F;
  return written;
}

(async () => {
  const port = await findFreePort();
  const apiKey = 'test_key_123';

  const harness = spawn('/tmp/agy-sdk/google/antigravity/bin/localharness', [], {
    env: { ...process.env, ANTIGRAVITY_APP_DATA_DIR: '/tmp' },
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const apiKeyBuf = Buffer.from(apiKey, 'utf-8');
  const apiKeyLen = apiKeyBuf.length;
  
  const payloadLen = 2 + apiKeyLen + 1 + varIntSize(port);
  const payload = Buffer.alloc(payloadLen);
  let offset = 0;
  
  payload[offset++] = 0x0A;
  payload[offset++] = apiKeyLen;
  apiKeyBuf.copy(payload, offset);
  offset += apiKeyLen;
  
  payload[offset++] = 0x10;
  offset += writeVarInt(payload, offset, port);

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(payloadLen, 0);

  harness.stdin.write(lengthPrefix);
  harness.stdin.write(payload);

  harness.stdout.once('data', (data) => {
    console.log('Received raw data:', data);
    
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api_key=${apiKey}`, {
      headers: { 'x-goog-api-key': apiKey }
    });
    ws.on('open', () => {
      console.log('WS connected!');
      ws.send(JSON.stringify({
        config: {
          cascade_id: "00000000000000000000000000000000",
          session_continuation_mode: 'CREATE_OR_RESUME',
          models: [{ name: "gemini", types: ["MODEL_TYPE_TEXT"] }]
        }
      }));
      
      // Sending immediately without delay!
      ws.send(JSON.stringify({ user_input: "hello" }));
    });
    
    ws.on('message', (msg) => {
      console.log('WS msg:', msg.toString());
    });
  });
})();
