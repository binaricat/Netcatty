"use strict";

const { ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");

const activeProcesses = new Map();

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('Failed to get port'));
      }
    });
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

let webRequestInitialized = false;

function setupAntigravityBridge() {
  if (!webRequestInitialized) {
    webRequestInitialized = true;
    const { session } = require("electron");
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['ws://127.0.0.1:*/ws*'] },
      (details, callback) => {
        try {
          const urlObj = new URL(details.url);
          const apiKey = urlObj.searchParams.get('api_key');
          if (apiKey) {
            details.requestHeaders['x-goog-api-key'] = apiKey;
          }
        } catch (e) {
          console.error("Failed to parse websocket URL", e);
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );
  }

  function getAdcProject() {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      let adcPath;
      if (process.platform === 'win32') {
        adcPath = path.join(process.env.APPDATA || '', 'gcloud', 'application_default_credentials.json');
      } else {
        adcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
      }
      if (fs.existsSync(adcPath)) {
        const adc = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
        return adc.quota_project_id || '';
      }
    } catch (e) {
      console.error("Failed to read ADC file", e);
    }
    return '';
  }

  ipcMain.handle("netcatty:ai:antigravity:start", async (event, { binaryPath, appDataDir, chatSessionId }) => {
    const port = await findFreePort();
    const apiKey = 'test_key_' + Date.now();

    return new Promise((resolve, reject) => {
      const harnessProcess = spawn(binaryPath, [], {
        env: {
          ...process.env,
          ANTIGRAVITY_APP_DATA_DIR: appDataDir,
        },
        stdio: ['pipe', 'pipe', 'inherit']
      });

      if (!harnessProcess.stdin || !harnessProcess.stdout) {
        throw new Error('Failed to open stdio to localharness');
      }

      activeProcesses.set(chatSessionId, harnessProcess);

      // Write protobuf manually
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

      harnessProcess.stdin.write(lengthPrefix);
      harnessProcess.stdin.write(payload);

      harnessProcess.stdout.once('data', (data) => {
        if (data.length < 4) {
          reject(new Error("Invalid handshake response"));
          return;
        }
        
        let actualApiKey = apiKey;
        let actualPort = port;
        let offset = 4;
        while (offset < data.length) {
          const fieldType = data[offset++];
          if (fieldType === 0x12) { // api_key field (field 2, length delimited)
            const keyLen = data[offset++];
            actualApiKey = data.toString('utf8', offset, offset + keyLen);
            offset += keyLen;
          } else if (fieldType === 0x08) { // port field (field 1, varint)
            let val = 0;
            let shift = 0;
            while (offset < data.length) {
              const b = data[offset++];
              val |= (b & 0x7F) << shift;
              shift += 7;
              if ((b & 0x80) === 0) break;
            }
            actualPort = val;
          } else {
            break;
          }
        }
        
        const detectedProject = getAdcProject();
        resolve({ port: actualPort, apiKey: actualApiKey, project: detectedProject });
      });

      harnessProcess.on('error', (err) => {
        console.error("[Antigravity] Process error:", err);
      });

      harnessProcess.on('exit', () => {
        activeProcesses.delete(chatSessionId);
      });
    });
  });

  ipcMain.handle("netcatty:ai:antigravity:stop", async (event, { chatSessionId }) => {
    const harnessProcess = activeProcesses.get(chatSessionId);
    if (harnessProcess) {
      harnessProcess.kill();
      activeProcesses.delete(chatSessionId);
    }
    return { ok: true };
  });
}

module.exports = { setupAntigravityBridge };
