"use strict";
if (!process.versions.electron) {
  require("node:test")("host drawn plugin CSS", { skip: "requires Electron" }, () => {});
} else {
  const assert = require("node:assert/strict");
  const electron = require("electron");
  const { validatePluginStylesheet } = require("../../domain/pluginViewStylePolicy.cjs");
  electron.app.on("window-all-closed", () => {});
  void electron.app.whenReady().then(async () => {
    const win = new electron.BrowserWindow({ show: false, width: 500, height: 350,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await win.loadURL("data:text/html," + encodeURIComponent(`<!doctype html><style>body{margin:0} #surface{position:relative;isolation:isolate;contain:paint;overflow:hidden;width:300px;height:200px} #overlay{position:absolute;top:20px;left:20px;z-index:10;width:100px;height:50px;background:red}</style><p id="outside">Host</p><div id="surface"></div><div id="overlay">Host menu</div>`));
    const css = validatePluginStylesheet('.layout{display:grid;grid-template-columns:1fr 2fr;gap:10px}.card{color:rgb(0,128,0);padding:20px} p{color:blue}');
    const result = await win.webContents.executeJavaScript(`(() => {
      const root=document.querySelector('#surface').attachShadow({mode:'closed'});
      const style=document.createElement('style');style.textContent=${JSON.stringify(css)};
      const panel=document.createElement('div');panel.className='layout';
      const text=document.createElement('p');text.className='card';text.textContent='Plugin';panel.append(text);root.append(style,panel);
      return { layout:getComputedStyle(panel).display, inner:getComputedStyle(text).color, outer:getComputedStyle(document.querySelector('#outside')).color, top:document.elementFromPoint(30,30).id };
    })()`);
    assert.deepEqual(result, { layout: 'grid', inner: 'rgb(0, 128, 0)', outer: 'rgb(0, 0, 0)', top: 'overlay' });
    win.destroy(); console.log('HOST_DRAWN_STYLE_OK'); electron.app.exit(0);
  }).catch((error) => { console.error(error); electron.app.exit(1); });
}
