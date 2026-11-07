"use strict";
if (!process.versions.electron) {
  require("node:test")("host rendered React UI", { skip: "requires Electron and fixture server" }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const electron = require("electron");
  const { createPluginHostService } = require("./hostService.cjs");
  const { registerPluginBridge } = require("./pluginBridge.cjs");
  const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");
  const appRoot = path.resolve(__dirname, "../.."); const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-host-ui-"));
  electron.app.setPath("userData", userData); electron.app.on("window-all-closed", () => {});
  electron.protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_PROTOCOL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
  void electron.app.whenReady().then(async () => {
    const runtimeAppRoot = path.join(userData, "runtime-app"); const runtimeDirectory = path.join(runtimeAppRoot, "electron/plugins/runtime");
    for (const name of ["plugin-contract", "plugin-sdk"]) fs.cpSync(path.join(appRoot, "node_modules/@netcatty", name, "dist"), path.join(runtimeAppRoot, "node_modules/@netcatty", name, "dist"), { recursive: true });
    fs.cpSync(path.join(__dirname, "runtime"), runtimeDirectory, { recursive: true });
    const service = createPluginHostService({ app: electron.app, electron, appRoot: runtimeAppRoot, runtimeDirectory, supportedFeatures: ["views.host-drawn"],
      requestPermissionDecision: async (request) => ({ requestId: request.requestId, decision: "allow", scope: "application" }) });
    await service.manager.initialize();
    const { buildPluginPackage } = await import("@netcatty/plugin-cli"); const archive = path.join(userData, "hello.ncpkg");
    await buildPluginPackage(path.join(appRoot, "examples/plugins/hello-react-host"), archive); await service.manager.install(archive, { enable: true });
    const owner = new electron.BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, "fixtures/hostReactPreload.cjs") } });
    const inputEvents = []; const dispatch = service.hostDrawnViewHost.event.bind(service.hostDrawnViewHost);
    service.hostDrawnViewHost.event = async (...args) => { inputEvents.push(args[1]); return dispatch(...args); };
    registerPluginBridge(electron.ipcMain, { ...service, isTrustedSender: (event) => event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame });
    for (const name of ['vault', 'sidebar', 'tab', 'aside', 'panel', 'modal']) {
      await owner.loadURL(`http://localhost:5182/scripts/fixtures/host-plugin-react.html?view=${name}`);
      const result = await owner.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const shadow=window.testPluginShadow;const button=shadow?.querySelector('button');if(button){const overlay=document.elementFromPoint(30,30);const input=shadow.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Catty');input.dispatchEvent(new Event('input',{bubbles:true}));setTimeout(()=>{button.click();setTimeout(()=>resolve({heading:shadow.querySelector('h1')?.textContent, text:shadow.textContent, top:overlay?.id, buttonColor:getComputedStyle(button).backgroundColor, hostHasBrowser:document.querySelector('iframe')!==null}),250)},250);return}if(document.body.dataset.failure||Date.now()>end)return reject(new Error('View did not render: '+document.body.innerText));setTimeout(check,30)};check()})`);
      assert.ok(inputEvents.some((event) => event.type === "input" && event.value === "Catty"), name);
      assert.equal(result.heading, "你好，世界！", name); assert.match(result.text, /你好，Catty！/, name); assert.equal(result.top, "host-overlay", name); assert.notEqual(result.buttonColor, "rgba(0, 0, 0, 0)", name); assert.equal(result.hostHasBrowser, false, name);
      assert.equal(owner.contentView.children.length, 0, name);
      const controls = await owner.webContents.executeJavaScript(`(async () => {
        const root = window.testPluginShadow;
        const wait = async (fn) => { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Control update timeout: ' + root.querySelector('img')?.outerHTML + ' popup=' + document.querySelector('[data-plugin-view-popover]') + ' ' + root.textContent); };
        const reset = [...root.querySelectorAll('button')].find(b => b.textContent === '填入示例'); reset.click();
        const text = root.querySelector('input[type=text]'); const checkbox = root.querySelector('input[type=checkbox]'); const select = root.querySelector('select'); const note = root.querySelector('textarea');
        await wait(() => text.value === '朋友' && checkbox.checked && select.value === 'green' && note.value === '你好，Netcatty');
        checkbox.click(); select.value = 'blue'; select.dispatchEvent(new Event('change', { bubbles: true }));
        note.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(note, '中文输入');
        note.dispatchEvent(new Event('input', { bubbles: true })); note.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文输入' }));
        await wait(() => root.querySelector('[data-testid=controls]').textContent.includes('已停用 · blue · 中文输入'));
        await wait(() => root.querySelector('img').naturalWidth === 32);
        root.getElementById('menu-trigger').click(); await wait(() => document.querySelector('[data-plugin-view-popover]'));
        const popup = document.querySelector('[data-plugin-view-popover]');
        return { image: root.querySelector('img').src.startsWith('data:image/png;base64,'), popup: popup.getBoundingClientRect().width > 0 };
      })()`);
      assert.equal(controls.image, true, name); assert.equal(controls.popup, true, name);
      await owner.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await owner.webContents.executeJavaScript(`document.querySelector('[data-plugin-view-popover]') === null`), true, name);

      const settingsModal = await owner.webContents.executeJavaScript(`(async () => {
        const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Settings entry timeout: ' + document.body.innerText); };
        await wait(() => document.querySelector('[data-plugin-settings-entry] button'));
        const gear = document.querySelector('[data-plugin-settings-entry] button');
        const oldSurface = document.querySelector('[data-plugin-remote-surface]');
        const oldRoot = window.testPluginShadow;
        const eventCount = oldRoot.querySelector('textarea').value;
        gear.focus(); gear.click();
        await wait(() => document.querySelector('[data-plugin-settings-dialog] input[aria-label="默认称呼"]'));
        const dialog = document.querySelector('[data-plugin-settings-dialog]');
        const rect = dialog.getBoundingClientRect();
        const result = { bounded: rect.top > 0 && rect.bottom < innerHeight && rect.width < innerWidth,
          separate: !oldSurface.contains(dialog), topmost: dialog.contains(document.elementFromPoint(rect.x + 30, rect.y + 30)),
          noPluginContent: !dialog.querySelector('[data-plugin-remote-surface]'), pageStillMounted: oldSurface.isConnected };
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(() => !document.querySelector('[data-plugin-settings-dialog]'));
        result.retained = oldSurface.isConnected && oldRoot === window.testPluginShadow && oldRoot.querySelector('textarea').value === eventCount;
        result.focusReturned = document.activeElement === gear;
        return result;
      })()`);
      assert.deepEqual(settingsModal, { bounded: true, separate: true, topmost: true, noPluginContent: true, pageStillMounted: true, retained: true, focusReturned: true }, name);

      if (name === 'vault') {
        const eventCount = inputEvents.length;
        await owner.webContents.executeJavaScript(`const hostInput = document.getElementById('host-private-input'); hostInput.value = 'host-only-canary'; hostInput.dispatchEvent(new Event('input', { bubbles: true }));`);
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(inputEvents.length, eventCount, 'host input is never forwarded to plugin');
        await owner.webContents.executeJavaScript("document.getElementById('toggle-plugin').click()");
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(await owner.webContents.executeJavaScript("document.querySelector('[data-plugin-remote-surface]') === null"), true);
        await owner.webContents.executeJavaScript("document.getElementById('toggle-plugin').click()");
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await owner.webContents.executeJavaScript("window.testPluginShadow.querySelector('textarea').value"), '中文输入', 'hide/reopen retains state');
        await owner.webContents.executeJavaScript("window.testPluginShadow.getElementById('menu-trigger').click()");
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(await owner.webContents.executeJavaScript("!!document.querySelector('[data-plugin-view-popover]')"), true);
        await owner.webContents.executeJavaScript(`const dialog = document.createElement('div'); dialog.id = 'trusted-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.style.cssText = 'position:fixed;inset:0;z-index:50;background:white'; document.body.append(dialog);`);
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(await owner.webContents.executeJavaScript("document.querySelector('[data-plugin-view-popover]') === null && document.elementFromPoint(30,30).id === 'trusted-dialog'"), true, 'trusted dialogs dismiss plugin popovers');
        await owner.webContents.executeJavaScript("document.getElementById('trusted-dialog').remove()");
      }

      if (name === 'vault' && process.env.NETCATTY_HOST_UI_SCREENSHOT) fs.writeFileSync(process.env.NETCATTY_HOST_UI_SCREENSHOT, (await owner.capturePage()).toPNG());
    }
    // Exercise the production settings form through the real bridge and database.
    await owner.loadURL('http://localhost:5182/scripts/fixtures/host-plugin-react.html?view=settings-form');
    const editSettings = await owner.webContents.executeJavaScript(`(async () => {
      const wait = async (fn) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Settings form timeout: ' + document.body.innerText + ' state=' + document.querySelector('[data-settings-fixture]')?.outerHTML); };
      const input = () => document.querySelector('input[aria-label="默认称呼"]');
      await wait(() => input());
      const setText = (text) => { input().focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input(), text); input().dispatchEvent(new Event('input', { bubbles: true })); input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); };
      setText('设置验收');
      await wait(() => !input().disabled);
      const select = document.querySelector('select[aria-label="强调颜色"]');
      select.value = 'green'; select.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => !select.disabled);
      return { groups: [...document.querySelectorAll('h4')].map(h => h.textContent), customSurface: !!document.querySelector('[data-plugin-remote-surface]') };
    })()`);
    assert.deepEqual(editSettings.groups, ['问候', '外观', '内容']);
    assert.equal(editSettings.customSurface, false);
    const pluginId = 'com.netcatty.hello-react-host';
    // Renderer save transitions may settle in the next task; verify stored values before reload.
    for (let i = 0; i < 100; i++) {
      if (await service.contributionService.getSetting(pluginId, `${pluginId}.name`) === '设置验收' && await service.contributionService.getSetting(pluginId, `${pluginId}.color`) === 'green') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await service.contributionService.getSetting(pluginId, `${pluginId}.name`), '设置验收');
    assert.equal(await service.contributionService.getSetting(pluginId, `${pluginId}.color`), 'green');
    await owner.reload();
    await new Promise(resolve => owner.webContents.once('did-finish-load', resolve));
    const persistence = await owner.webContents.executeJavaScript(`new Promise((resolve,reject) => { const end = Date.now()+12000; const check = () => { const input = document.querySelector('input[aria-label="默认称呼"]'); if (input) return resolve({name:input.value,color:document.querySelector('select[aria-label="强调颜色"]').value}); if(Date.now()>end)return reject(new Error('Settings reload timeout'));setTimeout(check,30); }; check(); })`);
    assert.deepEqual(persistence, { name: '设置验收', color: 'green' });
    if (process.env.NETCATTY_SETTINGS_SCREENSHOT) fs.writeFileSync(process.env.NETCATTY_SETTINGS_SCREENSHOT, (await owner.capturePage()).toPNG());
    const invalid = await owner.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('input[aria-label="默认称呼"]'); input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, 'x'.repeat(41)); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));
      for(let i=0;i<200;i++){if(document.querySelector('[role=alert]'))return true;await new Promise(r=>setTimeout(r,20));}return false;
    })()`);
    assert.equal(invalid, true, 'invalid setting is reported in its host row');
    assert.equal(await service.contributionService.getSetting(pluginId, `${pluginId}.name`), '设置验收');
    await owner.loadURL('http://localhost:5182/scripts/fixtures/host-plugin-react.html?view=vault');
    const readPage = () => owner.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const input=window.testPluginShadow?.querySelector('input');if(input?.value==='设置验收')return resolve(window.testPluginShadow.querySelector('select').value);if(Date.now()>end)return reject(new Error('Persisted preference was not applied'));setTimeout(check,30)};check()})`);
    assert.equal(await readPage(), 'green');
    await service.contributionService.updateSetting(pluginId, `${pluginId}.name`, '即时更新');
    const live = await owner.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(window.testPluginShadow?.querySelector('input')?.value==='即时更新' && window.testPluginShadow?.querySelector('img')?.naturalWidth===32)return resolve(true);if(Date.now()>end)return reject(new Error('Setting change did not reach open page'));setTimeout(check,30)};check()})`);
    assert.equal(live, true);
    await service.contributionService.resetSetting(pluginId, `${pluginId}.name`);
    assert.equal(await service.contributionService.getSetting(pluginId, `${pluginId}.name`), '');
    owner.destroy(); await service.manager.shutdown(); fs.rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log("HOST_REACT_UI_OK"); electron.app.exit(0);
  }).catch((error) => { console.error(error); electron.app.exit(1); });
}
