const { spawn } = require('child_process');
const WebSocket = require('ws');

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

const harnessProcess = spawn('/tmp/agy-sdk/google/antigravity/bin/localharness', [], {
  env: {
    ...process.env,
    ANTIGRAVITY_APP_DATA_DIR: '/tmp/test-agy',
  },
  stdio: ['pipe', 'pipe', 'inherit']
});

const portHint = 0; // We send 0 or random, see what it binds to
const apiKey = 'test_key_' + Date.now();
const apiKeyBuf = Buffer.from(apiKey, 'utf-8');
const apiKeyLen = apiKeyBuf.length;

const payloadLen = 2 + apiKeyLen + 1 + varIntSize(portHint);
const payload = Buffer.alloc(payloadLen);
let offset = 0;
payload[offset++] = 0x0A;
payload[offset++] = apiKeyLen;
apiKeyBuf.copy(payload, offset);
offset += apiKeyLen;
payload[offset++] = 0x10;
offset += writeVarInt(payload, offset, portHint);

const lengthPrefix = Buffer.alloc(4);
lengthPrefix.writeUInt32LE(payloadLen, 0);

harnessProcess.stdin.write(lengthPrefix);
harnessProcess.stdin.write(payload);

harnessProcess.stdout.once('data', (data) => {
  let actualApiKey = apiKey;
  let actualPort = portHint;
  let o = 4;
  while (o < data.length) {
    const fieldType = data[o++];
    if (fieldType === 0x12) {
      const keyLen = data[o++];
      actualApiKey = data.toString('utf8', o, o + keyLen);
      o += keyLen;
    } else if (fieldType === 0x08) {
      let val = 0;
      let shift = 0;
      while (o < data.length) {
        const b = data[o++];
        val |= (b & 0x7F) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      actualPort = val;
    } else {
      break;
    }
  }

  console.log(`Bound to port ${actualPort}, key ${actualApiKey}`);
  
  const ws = new WebSocket(`ws://127.0.0.1:${actualPort}/ws?api_key=${actualApiKey}`);
  ws.on('open', () => {
    console.log('WS connected');
    ws.send(JSON.stringify({
      initialize_conversation_event: {
        config: {
          cascade_id: "test",
          session_continuation_mode: 'CREATE_OR_RESUME',
          system_instructions: {
            custom: { part: [{ text: "You are Antigravity." }] }
          },
          harness_side_tools: []
        }
      }
    }));
    
    ws.send(JSON.stringify({
      user_input: "display hello"
    }));
  });
  
  ws.on('message', (msg) => {
    console.log('WS msg:', msg.toString());
  });
  
  ws.on('close', () => {
    console.log('WS closed');
    harnessProcess.kill();
  });
  
  ws.on('error', (err) => {
    console.log('WS err', err);
    harnessProcess.kill();
  });
});
