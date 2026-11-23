"use strict";

// Isolated proof of concept; never loads plugin code into the user's profile.
if (!process.versions.electron) {
  require('node:test')('embedded frame security proof', { skip: 'requires Electron' }, () => {});
} else {
const assert = require("node:assert/strict");
const http = require("node:http");
const dgram = require("node:dgram");
const electron = require("electron");
electron.app.on("window-all-closed", () => {});

void electron.app.whenReady().then(async () => {
  const requests = [];
  const udp = dgram.createSocket("udp4"); let udpPackets = 0;
  udp.on("message", () => { udpPackets++; });
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const server = http.createServer((req, res) => { requests.push(req.url); res.end("unexpected"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const win = new electron.BrowserWindow({ show: false, width: 500, height: 400,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  let blockedNavigations = 0;
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) { blockedNavigations++; event.preventDefault(); }
  });
  await win.loadURL("data:text/html," + encodeURIComponent(`<!doctype html><style>iframe{position:absolute;inset:0;width:100%;height:100%;border:0} #overlay{position:absolute;z-index:5;left:20px;top:20px;background:red;width:120px;height:60px}</style><iframe id="view" sandbox="allow-scripts"></iframe><div id="overlay">Host menu</div><script>window.messages=[];window.addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)window.messages.push(e.data)})</script>`));
  const child = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; frame-src 'none'; form-action 'none'"><style>body{background:#325b90;color:white}</style><p>Plugin UI</p><script>
    let parentBlocked=false, storageBlocked=false;
    try { void parent.document.body; } catch { parentBlocked=true }
    try { void localStorage.length; } catch { storageBlocked=true }
    fetch('${address}/fetch').catch(()=>{});
    try { const peer=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]}); peer.createDataChannel('probe'); peer.createOffer().then(offer=>peer.setLocalDescription(offer)); } catch {}
    const img=new Image(); img.src='${address}/image';
    parent.postMessage({parentBlocked,storageBlocked,node:typeof require,webrtc:typeof RTCPeerConnection},'*');
    window.addEventListener('message',e=>{if(e.data==='navigate') location.href='${address}/navigation'});
  </script>`;
  const escaped = JSON.stringify(child);
  await win.webContents.executeJavaScript(`document.querySelector('#view').srcdoc=${escaped}`);
  const value = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const poll=()=>{if(window.messages.length)return resolve({message:window.messages[0],top:document.elementFromPoint(30,30).id});if(Date.now()>end)return reject(new Error('timeout'));setTimeout(poll,10)};poll()})`);
  assert.equal(value.message.parentBlocked, true);
  assert.equal(value.message.storageBlocked, true);
  assert.equal(value.message.node, "undefined");
  assert.equal(value.top, "overlay");
  await win.webContents.executeJavaScript(`document.querySelector('#view').contentWindow.postMessage('navigate','*')`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(requests.length, 0, `unexpected direct network requests: ${requests}`);
  assert.ok(blockedNavigations > 0, "frame navigation must be intercepted");
  console.log(`FRAME_PROOF parent+storage isolated, fetch and image denied, host overlay on top; WebRTC constructor: ${value.message.webrtc}; local UDP packets: ${udpPackets}`);
  win.destroy(); server.close(); udp.close(); electron.app.exit(0);
}).catch((error) => { console.error(error); electron.app.exit(1); });

}
