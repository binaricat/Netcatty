"use strict";

// Real React chrome, production preload and native page manager in an isolated profile.
// Run: electron electron/hostBrowser/hostBrowser.renderer.live.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const electron = require('electron');
const { createHostBrowserManager } = require('./hostBrowserManager.cjs');
const portForwardingBridge = require('../bridges/portForwardingBridge.cjs');
const tempDirBridge = require('../bridges/tempDirBridge.cjs');
const repo = path.join(__dirname, '../..');
const userData = fs.mkdtempSync(tempDirBridge.getTempFilePath('browser-renderer-'));
app.setPath('userData', userData);
const downloadsPath = path.join(userData, 'downloads');
fs.mkdirSync(downloadsPath);
app.setPath('downloads', downloadsPath);
let owner, manager, vite, site;
let pendingPdf;
let pendingNavigation;
const pdfBody = Buffer.concat([Buffer.from('%PDF-1.4\n% streamed inline PDF\n'), Buffer.alloc(1048576, 32)]);
const savedCopy = path.join(userData, 'saved-copy.txt');
const shellActions = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, expected, label) {
  for (let index = 0; index < 150; index++) { if (await read() === expected) return; await wait(30); }
  assert.equal(await read(), expected, label);
}
const run = (code) => owner.webContents.executeJavaScript(code).catch((error) => { throw new Error(`${error.message}\nWhile executing: ${code}`); });
async function capture(file, selector) {
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const bounds = selector ? await run(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()`) : undefined;
  fs.writeFileSync(file, (await owner.webContents.capturePage(bounds)).toPNG());
}
async function click(selector) {
  // Electron requires native focus before sendInputEvent can deliver a click.
  app.focus({ steal: true }); owner.focus(); owner.webContents.focus();
  await until(() => owner.isFocused(), true, 'acceptance window has native focus for click');
  const rect = await run(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element?.scrollIntoView({block:'nearest'}); const r = element?.getBoundingClientRect(); return r && {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.ok(rect, `missing ${selector}`);
  owner.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x), y: Math.round(rect.y) });
  await run('new Promise(resolve => requestAnimationFrame(resolve))');
  for (const type of ['mouseDown', 'mouseUp']) owner.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) });
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function pressEscape() {
  app.focus({ steal: true }); owner.focus(); owner.webContents.focus();
  await until(() => owner.isFocused(), true, 'acceptance window has native focus for Escape');
  await run('new Promise(resolve => requestAnimationFrame(resolve))');
  owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function input(selector, value) {
  await until(() => run(`!!document.querySelector(${JSON.stringify(selector)})`), true, `input exists: ${selector}`);
  await run(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
const watchdog = setTimeout(() => { console.error('Browser renderer acceptance timed out'); app.exit(1); }, 90000);

async function main() {
  const { createServer } = await import('vite');
  vite = await createServer({ root: repo, server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false, logLevel: 'error' });
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  site = http.createServer((request, response) => {
    if (request.url === '/slow-page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<title>Slow navigation</title><input autofocus>'); pendingNavigation = response; return;
    }
    if (request.url === '/inline.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf;charset=UTF-8', 'content-length': pdfBody.length,
        'content-disposition': "inline; filename*=UTF-8''%E6%85%A2%E9%80%9F%E6%8A%A5%E5%91%8A.pdf" });
      response.write(pdfBody.subarray(0, 65536)); pendingPdf = response; return;
    }
    if (request.url === '/report.txt') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' });
      response.end('Netcatty automatic download\n'); return;
    }
    if (request.url === '/slow.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 1048576 });
      response.write(Buffer.alloc(16384)); return;
    }
    response.end(`<html><title>Browser acceptance page</title><body style="background:#c8f1df;color:#142a25;font:22px sans-serif;padding:25px"><h1>This page stays visible</h1><input id="draft" value="Keep my input"><button id="count" onclick="window.count=(window.count||0)+1">Count</button><a id="next" href="/next">Next</a><a id="download" href="/report.txt">Download report</a><p>${request.url}</p></body></html>`);
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const preload = path.join(userData, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer,webUtils}=require('electron'); const {createPreloadApi}=require(${JSON.stringify(path.join(repo,'electron/preload/api.cjs'))}); contextBridge.exposeInMainWorld('netcatty',createPreloadApi({ipcRenderer,webUtils}));`);
  owner = new BrowserWindow({ width: 1000, height: 800, show: true, webPreferences: { preload, contextIsolation: true, sandbox: false } });
  const errors = [];
  owner.webContents.on('console-message', (event) => { if (event.level === 'error' || event.level >= 3) errors.push(event.message); });
  owner.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  manager = createHostBrowserManager({ electron: { ...electron,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: savedCopy }) },
    shell: { openPath: async (file) => { shellActions.push(['open', file]); return ''; }, showItemInFolder: (file) => shellActions.push(['reveal', file]) },
  }, app, portForwardingBridge });
  const event = { sender: owner.webContents };
  const browserId = 'local:renderer-acceptance';
  manager.openPanelUrl(event, { browserId, url });
  await owner.loadURL(`${base}/electron/hostBrowser/fixtures/renderer.html`);
  await until(() => run('document.querySelectorAll("[role=tab]").length'), 1, 'unified tab mounts');
  await until(() => manager.getPanelState(event, browserId).tabs[0].title, 'Browser acceptance page', 'page loads');
  let root = owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView && child.webContents.getURL() === url));
  assert.ok(root); assert.equal(root.children.length, 1, 'only the website is a separate native view');
  const page = root.children[0].webContents;
  await page.executeJavaScript("document.getElementById('draft').value='Unsaved browser input'");
  // A visible but stationary browser must not spend every frame reading the
  // whole renderer. Settle startup/FontFaceSet work before observing idle time.
  await wait(300);
  const assertIdleLayout = async () => {
    await run(`(() => {
      const query=document.querySelector.bind(document),queryAll=document.querySelectorAll.bind(document),style=getComputedStyle;
      window.layoutReads={queries:0,styles:0};
      document.querySelector=(...args)=>{window.layoutReads.queries++;return query(...args)};
      document.querySelectorAll=(...args)=>{window.layoutReads.queries++;return queryAll(...args)};
      window.getComputedStyle=(...args)=>{window.layoutReads.styles++;return style(...args)};
      window.restoreLayoutReads=()=>{document.querySelector=query;document.querySelectorAll=queryAll;window.getComputedStyle=style;};
    })()`);
    await wait(250);
    const reads=await run('window.restoreLayoutReads();window.layoutReads');
    assert.deepEqual(reads,{queries:0,styles:0},'idle browser leaves no repeated overlay/style scans');
  };
  await assertIdleLayout();

  // Position-only CSS motion does not fire ResizeObserver on the viewport.
  // Follow its real animation frames, then release the frame loop again.
  await run(`(() => {const parent=document.querySelector('[data-section=host-browser-root]').parentElement;parent.id='moving-browser-fixture';parent.style.transition='transform 300ms linear';parent.style.transform='translateX(32px)';})()`);
  const positions=[];
  for(let index=0;index<15;index++){await wait(25);positions.push(root.getBounds().x);}
  assert.ok(new Set(positions).size>=4,'the native browser follows intermediate transform positions');
  const expectedX=await run('Math.round(document.querySelector("[data-section=host-browser-panel]").getBoundingClientRect().x)');
  assert.equal(root.getBounds().x,expectedX,'native browser reaches the final CSS position');
  await assertIdleLayout();
  await run('document.getElementById("moving-browser-fixture").style.transform="none"');await wait(350);

  // Exercise continuous pointer-driven size updates through the same hook and
  // native view. No application session or real SSH host is involved.
  await run(`(() => {
    const handle=document.createElement('div');handle.id='browser-drag-fixture';handle.style.cssText='position:fixed;left:2px;top:100px;width:8px;height:200px;z-index:99999';
    const parent=document.getElementById('moving-browser-fixture');
    handle.onmousedown=()=>{const move=event=>{parent.style.width=Math.max(300,event.clientX-parent.getBoundingClientRect().x)+'px'};const up=()=>{window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up)};window.addEventListener('mousemove',move);window.addEventListener('mouseup',up)};
    document.body.append(handle);
  })()`);
  owner.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:6,y:150});
  for(const x of [850,750,650,550]){owner.webContents.sendInputEvent({type:'mouseMove',x,y:150});await wait(30);}
  owner.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:550,y:150});await wait(80);
  const expectedWidth=await run('Math.round(document.querySelector("[data-section=host-browser-panel]").getBoundingClientRect().width)');
  assert.equal(root.getBounds().width,expectedWidth,'drag-driven viewport width reaches the native browser');
  assert.ok(expectedWidth<600,'the pointer drag actually resized the fixture');
  await run('document.getElementById("moving-browser-fixture").style.width="";document.getElementById("browser-drag-fixture").remove()');await wait(100);

  await run('document.documentElement.style.colorScheme="light";document.documentElement.style.setProperty("--background","40 70% 90%")');
  await until(()=>manager.getPanelState(event,browserId).theme,'light','theme reaches native browser without a frame poll');
  await run('document.documentElement.style.colorScheme="dark";document.documentElement.style.setProperty("--background","210 25% 18%")');
  await until(()=>manager.getPanelState(event,browserId).theme,'dark','theme restores');
  await run(`document.body.insertAdjacentHTML('beforeend','<div id="modal-layout-fixture" role="dialog" aria-modal="true" style="position:fixed;left:0;top:0;width:1px;height:1px"></div>')`);
  await until(()=>owner.contentView.children.includes(root),false,'modal beside the viewport still covers native content');
  await run('document.getElementById("modal-layout-fixture").remove()');
  await until(()=>owner.contentView.children.includes(root),true,'closing modal restores native content');
  await run(`document.body.insertAdjacentHTML('beforeend','<div id="lock-layout-fixture" data-app-lock-overlay></div>')`);
  await until(()=>owner.contentView.children.includes(root),false,'app lock hides native content');
  await run('document.getElementById("lock-layout-fixture").remove()');
  await until(()=>owner.contentView.children.includes(root),true,'unlock restores native content');
  assert.equal(await page.executeJavaScript("document.getElementById('draft').value"),'Unsaved browser input');

  for (let index = 0; index < 2; index++) {
    app.focus({ steal: true });
    owner.focus(); owner.webContents.focus();
    await until(() => owner.isFocused(), true, 'acceptance window has native focus');
    owner.webContents.sendInputEvent({ type: 'mouseMove', x: 980, y: 740 });
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const rect = await run(`(() => { const r = document.getElementById('split-${index}').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    owner.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x), y: Math.round(rect.y) });
    await until(() => run('!!document.querySelector("[role=tooltip]")'), true, 'split hover tooltip opens');
    await wait(100);
    assert.equal(owner.contentView.children.includes(root), true, 'hover leaves the website live');
    assert.equal(await run('document.querySelectorAll("[data-section=host-browser-panel] img").length'), 0, 'hover does not replace the page with a frozen picture');
    await click(`#split-${index}`);
    await until(() => run('document.querySelectorAll("[data-section=host-browser-panel] img").length'), 1, 'overlapping split menu preserves a picture of the webpage');
    assert.equal(owner.contentView.children.includes(root), false, 'the split menu is above the native content');
    await click(`#choice-${index}-0`);
    await until(() => run(`document.getElementById('choice-${index}-0').dataset.chosen`), 'true', 'split menu choices are clickable');
    await pressEscape();
    owner.webContents.sendInputEvent({ type: 'mouseMove', x: 980, y: 740 });
    await until(() => owner.contentView.children.includes(root), true, 'closing menu restores live content');
    assert.equal(await page.executeJavaScript("document.getElementById('draft').value"), 'Unsaved browser input');
  }
  await click('[aria-label="新标签页"]');
  await until(() => run('document.querySelectorAll("[role=tab]").length'), 2, 'new tab');
  await until(() => run('document.activeElement.getAttribute("aria-label")'), '输入网址', 'new tab focuses the app address input');
  assert.equal(owner.contentView.children.includes(root), false, 'the default tab must not be covered by an empty native container');
  await click('[role=tab]');
  await until(() => owner.contentView.children.includes(root), true, 'return to original tab');
  assert.equal(await page.executeJavaScript("document.getElementById('draft').value"), 'Unsaved browser input');
  page.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  await until(() => run('document.activeElement.getAttribute("aria-label")'), '输入网址', 'page shortcut focuses unified address input');
  await input('[aria-label="输入网址"]', `${url}next`);
  await run('document.querySelector("[aria-label=输入网址]").form.requestSubmit()');
  await until(() => page.getURL(), `${url}next`, 'address navigation');
  await until(() => run('document.querySelector("[aria-label=后退]").disabled'), false, 'history back is enabled');
  await click('[aria-label="后退"]');
  await until(() => page.getURL(), url, 'back navigation');
  await click('[aria-label="应用与书签"]');
  await until(() => run('!!document.querySelector("aside[aria-label=应用与书签]")'), true, 'bookmarks share the app layout');
  await until(() => root.getBounds().width < 800, true, 'bookmark sidebar resizes only the webpage viewport');
  await click('aside [aria-label="添加应用"]');
  await until(() => run('!!document.querySelector("aside input[type=url]")'), true, 'bookmark editor');
  await input('aside input[maxlength="120"]', 'Saved acceptance app');
  await input('aside input[type="url"]', url);
  await click('aside [data-section="browser-icon-editor"] button:nth-child(3)');
  await run(`(() => {
    const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=320;
    const context=canvas.getContext('2d'); context.fillStyle='#247969'; context.fillRect(0,0,640,320);
    context.fillStyle='white'; context.font='bold 180px sans-serif'; context.fillText('N',245,225);
    const source=atob(canvas.toDataURL('image/png').split(',')[1]);
    const bytes=Uint8Array.from(source,c=>c.charCodeAt(0));
    const files=new DataTransfer(); files.items.add(new File([bytes],'team-app.png',{type:'image/png'}));
    const element=document.querySelector('aside input[type=file]'); element.files=files.files; element.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(() => run('!!document.querySelector("aside img[alt=图标预览]")'), true, 'chosen image has a real preview');
  assert.equal(await run('document.querySelector("aside input[type=file]").classList.contains("hidden")'), true, 'native file picker chrome is hidden');
  assert.equal(await run('document.querySelector("aside button[type=submit]").disabled'), false, 'processed image can be saved');
  const imageSize = await run(`new Promise(resolve=>{const image=new Image();image.onload=()=>resolve([image.width,image.height]);image.src=document.querySelector('aside img[alt=图标预览]').src;})`);
  assert.deepEqual(imageSize, [96, 48], 'large images are resized proportionally');
  await click('aside [aria-label="移除图片"]');
  await until(() => run('document.querySelector("aside button[type=submit]").disabled'), true, 'an empty image choice cannot be saved');
  await click('aside [data-section="browser-icon-editor"] button:nth-child(2)');
  await input('aside [aria-label="图标文字"]', 'N');
  await click('aside label:has(input[value="all-hosts"])');
  const editorTextScreenshot = path.join(userData, 'bookmark-editor-text.png');
  await capture(editorTextScreenshot, 'aside');
  await click('aside [data-section="browser-icon-editor"] button:nth-child(3)');
  await run(`(() => {
    const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;
    const context=canvas.getContext('2d');context.fillStyle='#247969';context.fillRect(0,0,96,96);context.fillStyle='white';context.font='bold 58px sans-serif';context.fillText('N',25,69);
    const source=atob(canvas.toDataURL().split(',')[1]); const files=new DataTransfer();
    files.items.add(new File([Uint8Array.from(source,c=>c.charCodeAt(0))],'new-icon.png',{type:'image/png'}));
    document.querySelector('aside input[type=file]').parentElement.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:files}));
  })()`);
  await until(() => run('!!document.querySelector("aside img[alt=图标预览]")'), true, 'a dropped replacement image loads');
  await run(`(() => {
    const files=new DataTransfer();files.items.add(new File(['not an image'],'invalid.txt',{type:'text/plain'}));
    const element=document.querySelector('aside input[type=file]');element.files=files.files;element.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(() => run('!!document.querySelector("aside [role=alert]")'), true, 'unsupported files show an inline explanation');
  assert.equal(await run('!!document.querySelector("aside img[alt=图标预览]")'), true, 'a failed replacement keeps the previous image');
  for (const [source, expected] of [["new Uint8Array(6*1024*1024)", '图片太大'], ["'broken PNG'", '无法读取']]) {
    await run(`(() => {const files=new DataTransfer();files.items.add(new File([${source}],'bad.png',{type:'image/png'}));const input=document.querySelector('aside input[type=file]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => run(`document.querySelector('aside [role=alert]')?.textContent.includes(${JSON.stringify(expected)})`), true, 'invalid image has a specific inline explanation');
  }
  await run('document.querySelector("aside form").requestSubmit()');
  await until(() => run('!!Array.from(document.querySelectorAll("aside button")).find(b=>b.textContent.includes("Saved acceptance app"))'), true, 'saved bookmark is shown');
  await click('aside [aria-label="编辑"]');
  await until(() => run('!!document.querySelector("aside img[alt=图标预览]")'), true, 'the saved image is restored when editing');
  assert.equal(await run('document.querySelector("aside input[value=all-hosts]").checked'), true, 'scope survives saving');
  const editorScreenshot=path.join(userData,'bookmark-editor-image.png');
  await capture(editorScreenshot, 'aside');
  for (const width of [400, 1000]) {
    owner.setSize(width, 800); await wait(150);
    assert.equal(await run('document.querySelector("aside").scrollWidth <= document.querySelector("aside").clientWidth'), true, 'the editor fits a narrow panel');
    await click('aside button[type=submit]');
    await until(() => run('!document.querySelector("aside input[type=url]")'), true, 'footer remains reachable after resizing');
    await click('aside [aria-label="编辑"]');
    await until(() => run('!!document.querySelector("aside input[type=url]")'), true, 'reopen after resizing');
  }
  await click('aside [aria-label="关闭"]');
  await click('[role=tab]:nth-child(2)');
  await until(() => owner.contentView.children.includes(root), false, 'returning to the default tab removes the native input blocker');
  await click('[data-section=host-browser-panel] button');
  await until(() => run('!!document.querySelector("aside input[type=url]")'), true, 'default-tab Add app opens the editor');
  await click('aside [aria-label="关闭"]');
  await click(`[data-section=host-browser-panel] button[title="${url}"]`);
  await until(() => manager.getPanelState(event, browserId).tabs.find(tab => tab.id === manager.getPanelState(event, browserId).activeTabId)?.url, url, 'default-tab bookmark opens its website');
  await until(() => owner.contentView.children.includes(root), true, 'bookmark navigation attaches the website again');
  await click('[aria-label="下载"]');
  await until(() => run('document.body.textContent.includes("暂无下载")'), true, 'downloads use the app popover');
  await pressEscape();
  fs.writeFileSync(path.join(downloadsPath, 'report.txt'), 'Keep the existing file');
  const activePage = root.children[0].webContents;
  await activePage.executeJavaScript("document.getElementById('download').click()");
  await until(() => run('document.body.textContent.includes("report (1).txt") && document.body.textContent.includes("已完成")'), true, 'a website download saves immediately and opens its progress list');
  await until(() => !owner.contentView.children.includes(root), true, 'the automatic download list is above the native webpage before interacting');
  assert.equal(fs.readFileSync(path.join(downloadsPath, 'report (1).txt'), 'utf8'), 'Netcatty automatic download\n');
  assert.equal(fs.readFileSync(path.join(downloadsPath, 'report.txt'), 'utf8'), 'Keep the existing file');
  await click('[aria-label="更多操作"]');
  await until(() => run('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "另存为…")'), true, 'download actions menu opens');
  await run('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "另存为…").click()');
  await until(() => fs.existsSync(savedCopy), true, 'Save as writes a separate copy');
  assert.equal(fs.readFileSync(savedCopy, 'utf8'), 'Netcatty automatic download\n');
  assert.equal(fs.existsSync(path.join(downloadsPath, 'report (1).txt')), true, 'Save as retains the original downloaded file');
  await pressEscape();
  await click('[title="在文件夹中显示"]');
  assert.deepEqual(shellActions.at(-1), ['reveal', path.join(downloadsPath, 'report (1).txt')]);
  await click('[aria-label="打开下载文件夹"]');
  assert.deepEqual(shellActions.at(-1), ['open', downloadsPath]);
  await pressEscape();
  await activePage.executeJavaScript("document.getElementById('download').click()");
  await until(() => run('document.body.textContent.includes("report (2).txt") && document.querySelectorAll("[data-download-id]").length === 2'), true, 'a second download also gets a new name and reopens the list');
  await pressEscape();
  activePage.downloadURL(`${url}slow.bin`);
  await until(() => run('!!document.querySelector("[aria-label=取消下载]") && document.body.textContent.includes("正在下载")'), true, 'progress is visible while the server is still sending the file');
  await until(() => !owner.contentView.children.includes(root), true, 'the progress popover has acquired the webpage surface');
  await click('[aria-label="下载"]');
  await until(() => run('!!document.querySelector("[aria-label=取消下载]")'), false, 'the download toggle closes its progress list');
  await wait(350);
  assert.equal(await run('!!document.querySelector("[aria-label=取消下载]")'), false, 'progress updates do not reopen a dismissed list');
  await click('[aria-label="下载"]');
  await click('[aria-label="取消下载"]');
  await until(() => run('document.body.textContent.includes("已取消")'), true, 'download can be cancelled from the list');
  await pressEscape();
  await activePage.executeJavaScript("(() => { const a=document.createElement('a');a.href='/inline.pdf';document.body.append(a);a.click();a.remove(); })()");
  await until(() => run('document.body.textContent.includes("慢速报告.pdf") && !!document.querySelector("[aria-label=取消下载]") && document.body.textContent.includes("正在下载")'), true, 'inline PDF navigation opens progress before the response finishes');
  assert.equal(pendingPdf.writableEnded, false, 'the server has not sent the rest of the PDF');
  await until(() => run('document.body.textContent.includes("64.0 KB")'), true, 'received PDF bytes are visible while its body is held open');
  const pdfProgressScreenshot = path.join(userData, 'inline-pdf-progress.png');
  await capture(pdfProgressScreenshot);
  await click('[aria-label="取消下载"]');
  await until(() => pendingPdf.destroyed, true, 'cancelling an inline PDF stops the network transfer');
  await pressEscape();
  pendingPdf = undefined;
  await input('[aria-label="输入网址"]', `${url}inline.pdf`);
  await run('document.querySelector("[aria-label=输入网址]").form.requestSubmit()');
  await until(() => !!pendingPdf && !pendingPdf.destroyed, true, 'another inline PDF starts');
  await until(() => run('!!document.querySelector("[aria-label=取消下载]")'), true, 'another PDF also opens progress');
  pendingPdf.end(pdfBody.subarray(65536));
  await until(() => run('Array.from(document.querySelectorAll("[data-download-id]")).some(row => row.textContent.includes("慢速报告.pdf") && row.textContent.includes("已完成"))'), true, 'PDF progress becomes completed after the response finishes');
  assert.deepEqual(fs.readFileSync(path.join(downloadsPath, '慢速报告.pdf')), pdfBody, 'the PDF is saved without changing its contents');
  assert.equal(await run('document.body.textContent.includes("ERR_FAILED")'), false, 'address-bar downloads do not show a false page error');
  const downloadScreenshot=path.join(userData,'automatic-downloads.png');
  await capture(downloadScreenshot);
  // Close the list through its own trigger before testing independent
  // navigation focus. A prior Escape may leave the baseline list open.
  await click('[aria-label="下载"]');
  await until(() => run('!!document.querySelector("[data-radix-popper-content-wrapper] > [role=dialog]")'), false, 'download list is closed before starting navigation');
  await input('[aria-label="输入网址"]', `${url}slow-page`);
  await run('document.querySelector("[aria-label=输入网址]").form.requestSubmit()');
  await until(() => !!pendingNavigation, true, 'slow navigation is waiting for its response to finish');
  assert.equal(activePage.isLoading(), true, 'the response remains unfinished while switching tabs');
  // Exercise the native page shortcut while its response remains unfinished.
  // The new-tab button is covered above with the same real mouse input helper.
  activePage.focus();
  activePage.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  activePage.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  await until(() => run('document.activeElement.getAttribute("aria-label")'), '输入网址', 'new tab receives input focus while the previous page is loading');
  await input('[aria-label="输入网址"]', 'keep my address draft');
  pendingNavigation.end();
  await until(() => !activePage.isLoading(), true, 'the background page finishes loading');
  await wait(100);
  assert.equal(owner.webContents.isFocused(), true, 'background navigation must not steal the new tab input focus');
  assert.equal(await run('document.activeElement.getAttribute("aria-label")'), '输入网址');
  assert.equal(await run('document.querySelector("[aria-label=输入网址]").value'), 'keep my address draft');
  await click('[role=tab]:nth-child(2)');
  await until(() => owner.contentView.children.includes(root), true, 'return to the loaded page');
  await click('#visibility');
  await until(() => owner.contentView.children.includes(root), false, 'hidden terminal hides only its page');
  await click('#visibility');
  await until(() => owner.contentView.children.includes(root), true, 'returning terminal restores page');
  for (const width of [400, 1000]) {
    owner.setSize(width, 800); await wait(150);
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no document overflow at narrow and wide sizes');
  }
  for (const locale of ['en', 'zh-TW', 'es', 'ru', 'zh-CN']) {
    await run(`(() => { const el=document.querySelector('select'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(el,${JSON.stringify(locale)}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await wait(50);
    assert.equal(await run('document.body.textContent.includes("terminal.browser.")'), false, 'no untranslated browser labels');
  }
  const screenshot = path.join(userData, 'unified-browser.png');
  fs.writeFileSync(screenshot, (await owner.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log(JSON.stringify({ ok: true, rendererChrome: true, idleLayout: true, animatedLayout: true, dragLayout: true, themeLayout: true, modalAndLockLayout: true, hoverKeepsPageLive: true, splitMenusClickable: true, tabs: true, addressAndHistory: true, shortcuts: true, bookmarks: true, iconUpload: true, imageResize: true, imageReplaceAndRemove: true, editPersistence: true, downloads: true, automaticDownloads: true, duplicateNames: true, saveAs: true, downloadProgressAndCancel: true, inlinePdfProgressAndCancel: true, hiddenRestore: true, narrowLayout: true, locales: 5, screenshot, editorScreenshot, editorTextScreenshot, downloadScreenshot, pdfProgressScreenshot }));
}
app.whenReady().then(main).catch(async (error) => { console.error(error); if (owner && !owner.isDestroyed()) { const screenshot=path.join(userData,'failure.png'); fs.writeFileSync(screenshot,(await owner.webContents.capturePage()).toPNG()); console.error(screenshot); } process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog);
  manager?.closeAll(); if (owner && !owner.isDestroyed()) owner.destroy();
  if (site) { site.closeAllConnections(); site.close(); }
  await vite?.close();
  // Keep the isolated screenshot and profile under Netcatty's managed temp directory for inspection.
  app.exit(process.exitCode || 0);
});
