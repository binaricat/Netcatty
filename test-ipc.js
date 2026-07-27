const { ipcRenderer } = require('electron');
async function test() {
  console.log('Invoking netcatty:ai:capability...');
  const res = await ipcRenderer.invoke("netcatty:ai:capability", { rpcMethod: "netcatty/getContext" });
  console.log('Result:', res);
}
test().catch(console.error);
