"use strict";
// Real production monitoring components, isolated storage and deterministic readings.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const temp = require("../electron/bridges/tempDirBridge.cjs");
const profile = fs.mkdtempSync(temp.getTempFilePath("monitor-ui-"));
app.setPath("userData", profile);
let owner, vite;
const errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (code) => owner.webContents.executeJavaScript(code);
async function until(read, label) {
  for (let i = 0; i < 150; i++) {
    if (await read()) return;
    await wait(30);
  }
  assert.ok(await read(), label);
}
async function click(selector) {
  const rect = await run(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e?.scrollIntoView({block:'nearest'});const r=e?.getBoundingClientRect();return r&&{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  assert.ok(rect, selector);
  owner.webContents.focus();
  for (const type of ["mouseDown", "mouseUp"])
    owner.webContents.sendInputEvent({
      type,
      button: "left",
      clickCount: 1,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    });
  await run(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
  );
}
const watchdog = setTimeout(() => {
  console.error("Monitoring UI acceptance timed out");
  app.exit(1);
}, 90000);
async function main() {
  const { createServer } = await import("vite");
  vite = await createServer({
    root: path.resolve(__dirname, ".."),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await vite.listen();
  owner = new BrowserWindow({ width: 1280, height: 900, show: true });
  owner.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level >= 3) errors.push(event.message);
  });
  await owner.loadURL(
    `http://127.0.0.1:${vite.httpServer.address().port}/scripts/fixtures/monitor-panels.html`,
  );
  await until(
    () => run('document.querySelectorAll("[data-monitor-host]").length > 0'),
    "monitoring renders",
  );
  const screenshot = async (name) => {
    owner.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
    await wait(200);
    await run(
      "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
    );
    fs.writeFileSync(
      path.join(profile, name),
      (await owner.webContents.capturePage()).toPNG(),
    );
  };
  const count = () =>
    run('document.querySelectorAll("[data-monitor-host]").length');
  const scroll = (selector) =>
    run(
      `(()=>{const e=document.querySelector('[data-section="vault-monitor-list"]');e.scrollTop=${selector};})()`,
    );
  const hover = async (selector) => {
    owner.focus();
    owner.webContents.focus();
    owner.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
    await run(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    const point = await run(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    owner.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    // Tooltip grace areas update on movement; model the following mouse event
    // that a real pointer produces rather than teleporting between triggers.
    await run("new Promise(r=>requestAnimationFrame(r))");
    owner.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(point.x + 1),
      y: Math.round(point.y),
    });
  };
  const checkActionContrast = async (view) => {
    const keys = ["accent", "accent-foreground"];
    const saved = await run(
      `Object.fromEntries(${JSON.stringify(["accent", "accent-foreground"])}.map(k=>[k,document.documentElement.style.getPropertyValue('--'+k)]))`,
    );
    await run(
      `document.documentElement.style.setProperty('--accent','170 70% 42%');document.documentElement.style.setProperty('--accent-foreground','210 20% 12%')`,
    );
    await hover("[data-monitor-terminal=host-0]");
    await wait(200);
    const colors = await run(
      `(()=>{const e=document.querySelector('[data-monitor-terminal=host-0]');return {background:getComputedStyle(e).backgroundColor,icon:getComputedStyle(e.querySelector('svg')).color}})()`,
    );
    const luminance = (color) =>
      color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(colors.background),
      b = luminance(colors.icon);
    assert.ok(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 3,
      `${view} terminal icon stays visible on accent hover: ${JSON.stringify(colors)}`,
    );
    fs.writeFileSync(
      path.join(profile, `monitor-${view}-action-hover.png`),
      (await owner.webContents.capturePage()).toPNG(),
    );
    for (const key of keys)
      await run(
        `document.documentElement.style.setProperty('--'+${JSON.stringify(key)},${JSON.stringify(saved[key])})`,
      );
    owner.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  };
  app.focus({ steal: true });
  owner.focus();
  owner.webContents.focus();
  assert.deepEqual(
    await run(
      'Array.from(document.querySelectorAll("[data-monitor-host]")).map(e=>e.getBoundingClientRect().height)',
    ),
    [368, 368],
  );
  assert.equal(
    await run(
      'document.querySelector("[data-monitor-host=host-0] [data-monitor-latency]").getAttribute("aria-label")',
    ),
    "延迟: 12 ms",
  );
  assert.equal(
    await run(
      'document.querySelector("[data-monitor-host=host-1] [data-monitor-latency]").getAttribute("aria-label")',
    ),
    "延迟: --",
  );
  assert.equal(
    await run('document.body.textContent.includes("读数只保留在内存")'),
    false,
  );
  await hover("[data-monitor-host=host-0] [data-monitor-notes]");
  await until(
    () =>
      run(
        'Array.from(document.querySelectorAll("[role=tooltip]")).some(e=>e.textContent.includes("Maintenance window"))',
      ),
    "full notes appear on hover",
  );
  await screenshot("notes-tooltip.png");
  owner.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  await checkActionContrast("charts");
  await click("[data-monitor-terminal=host-0]");
  assert.deepEqual(await run("window.monitorFixture.connections()"), [
    "host-0",
  ]);
  assert.equal(
    await run(
      '!!document.querySelector("[data-section=vault-monitor-detail]")',
    ),
    false,
    "terminal action does not open details",
  );
  await click("[data-monitor-host=host-0] > button:first-child");
  await until(
    () => run('!!document.querySelector("[data-monitor-gpu]")'),
    "GPU details appear",
  );
  const gpu = await run(
    'document.querySelector("[data-monitor-gpu]").textContent',
  );
  for (const expected of [
    "NVIDIA GeForce RTX 4090",
    "45.0%",
    "8.0 GiB",
    "24.0 GiB",
  ])
    assert.ok(gpu.includes(expected), expected);
  await screenshot("monitor-gpu.png");
  await click("[data-section=vault-monitor-detail] button:has(.lucide-x)");
  await click("[data-monitor-host=host-1] > button:first-child");
  await until(
    () =>
      run('!!document.querySelector("[data-section=vault-monitor-detail]")'),
    "non-GPU details open",
  );
  assert.equal(
    await run('!!document.querySelector("[data-monitor-gpu]")'),
    false,
    "hosts without GPU have no empty GPU section",
  );
  await click("[data-section=vault-monitor-detail] button:has(.lucide-x)");
  await run("window.monitorFixture.seed(6,'charts')");
  await until(
    () => run('document.querySelectorAll("[data-monitor-host]").length===6'),
    "signal examples render",
  );
  assert.deepEqual(
    await run(
      'Array.from(document.querySelectorAll("[data-monitor-latency]")).map(e=>Number(e.dataset.monitorSignalBars))',
    ),
    [4, 0, 2, 1, 4, 2],
  );
  assert.ok(
    await run(
      `(()=>{const row=document.querySelector('[data-monitor-host=host-0]');const a=row.querySelector('[data-monitor-latency]').getBoundingClientRect();const b=row.querySelector('[data-monitor-tags]').getBoundingClientRect();return Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<1})()`,
    ),
    "latency and tags are vertically centered",
  );
  await hover("[data-monitor-host=host-2] [data-monitor-latency]");
  await until(
    () =>
      run(
        'Array.from(document.querySelectorAll("[role=tooltip]")).some(e=>e.textContent.includes("180 ms"))',
      ),
    "signal tooltip has exact latency",
  );
  await hover("[data-monitor-host=host-5] [data-monitor-latency]");
  await until(
    () =>
      run(
        'Array.from(document.querySelectorAll("[role=tooltip]")).some(e=>e.textContent.includes("响应延迟（含远端处理）: 145 ms"))',
      ),
    "disabled keepalive still shows response latency",
  );
  await screenshot("monitor-signals.png");
  await click("[data-monitor-host=host-2] > button:first-child");
  await until(
    () => run('!!document.querySelector("[data-monitor-gpu]")'),
    "idle GPU details open",
  );
  const idleGpu = await run(
    'document.querySelector("[data-monitor-gpu]").textContent',
  );
  assert.ok(
    idleGpu.includes("0.0%") && idleGpu.includes("0 MiB"),
    "zero GPU readings remain visible",
  );
  await click("[data-section=vault-monitor-detail] button:has(.lucide-x)");
  await run("window.monitorFixture.seed(1200,'charts')");
  await until(
    async () => (await count()) > 2 && (await count()) < 80,
    "charts render a bounded visible subset",
  );
  assert.equal(
    await run('document.querySelectorAll("[data-monitor-terminal]").length'),
    await count(),
  );
  assert.ok(
    await run(
      'Array.from(document.querySelectorAll("[data-monitor-host]")).every(e=>e.getBoundingClientRect().height===368)',
    ),
  );
  await scroll("e.scrollHeight");
  await until(
    () => run('!!document.querySelector("[data-monitor-host=host-1199]")'),
    "last card can be reached",
  );
  await click("[data-monitor-terminal=host-1199]");
  assert.deepEqual(
    await run("window.monitorFixture.connections()"),
    ["host-1199"],
    "recycled card opens the correct host",
  );
  await click("button:has(.lucide-list)");
  await until(
    () => run('!!document.querySelector("table")'),
    "list view opens",
  );
  assert.ok((await count()) < 50, "list renders only visible rows");
  for (const position of [0, 450, 100000]) {
    await run(
      `document.querySelector('[data-section=vault-monitor-list]').scrollLeft=${position}`,
    );
    await run("new Promise(r=>requestAnimationFrame(r))");
    assert.ok(
      await run(
        `(()=>{const viewport=document.querySelector('[data-section=vault-monitor-list]');const action=document.querySelector('tbody tr td:last-child');return window.innerWidth-viewport.getBoundingClientRect().right>=15 && window.innerWidth-action.getBoundingClientRect().right>=15})()`,
      ),
      "sticky actions retain the right page gutter at every horizontal scroll position",
    );
    const geometry = await run(
      `(()=>{const r=document.querySelector('tbody tr td:last-child').getBoundingClientRect();return {width:innerWidth,height:innerHeight,right:r.right,top:r.top,bottom:r.bottom}})()`,
    );
    const captured = await owner.webContents.capturePage();
    const bitmap = captured.toBitmap();
    const scale = Math.sqrt(
      bitmap.length / (4 * geometry.width * geometry.height),
    );
    const pixelWidth = Math.round(geometry.width * scale);
    const pixel = (x, y) => {
      const start =
        4 * (Math.floor(y * scale) * pixelWidth + Math.floor(x * scale));
      return [...bitmap.subarray(start, start + 4)];
    };
    const backdrop = pixel(geometry.width - 4, geometry.top + 1);
    assert.deepEqual(
      pixel(geometry.right - 1, geometry.top + 1),
      backdrop,
      `top-right corner stays visibly rounded at scroll ${position}`,
    );
    assert.deepEqual(
      pixel(geometry.right - 1, geometry.bottom - 2),
      backdrop,
      `bottom-right corner stays visibly rounded at scroll ${position}`,
    );
    assert.notDeepEqual(
      pixel(geometry.right - 2, (geometry.top + geometry.bottom) / 2),
      backdrop,
      "rounded action still paints the row background",
    );
    if (position === 0) await screenshot("monitor-rounded-row-start.png");
  }

  await scroll("0");
  await checkActionContrast("list");
  const columnOrder = await run(
    'Array.from(document.querySelectorAll("th")).map(e=>e.dataset.monitorColumn)',
  );
  assert.deepEqual(columnOrder.slice(-2), ["status", "terminal"]);
  assert.equal(
    await run(
      `Array.from(document.querySelectorAll('th [role=separator]')).every(e=>getComputedStyle(e,'::after').backgroundColor==='rgba(0, 0, 0, 0)')`,
    ),
    true,
    "column dividers are hidden at rest",
  );

  assert.equal(
    await run('document.querySelectorAll("th [role=separator]").length'),
    11,
    "every column can be resized",
  );
  await scroll("0");
  await until(
    () => run('!!document.querySelector("[data-monitor-host=host-2]")'),
    "variable-height row is rendered",
  );
  await until(
    () =>
      run(
        'document.querySelector("[data-monitor-host=host-2]").getBoundingClientRect().height>150',
      ),
    "all partitions determine row height",
  );
  assert.ok(
    await run(
      `(()=>{const rows=[...document.querySelectorAll('tbody tr')];return rows.every((r,i)=>!i||r.getBoundingClientRect().top>=rows[i-1].getBoundingClientRect().bottom)})()`,
    ),
    "variable-height rows never overlap",
  );
  await click("[data-monitor-terminal=host-0]");
  assert.deepEqual(await run("window.monitorFixture.connections()"), [
    "host-1199",
    "host-0",
  ]);
  assert.equal(
    await run(
      '!!document.querySelector("[data-section=vault-monitor-detail]")',
    ),
    false,
  );
  await run(
    "document.querySelector('[data-section=vault-monitor-list]').scrollLeft=0",
  );
  const widths = {};
  for (const key of [
    "host",
    "status",
    "latency",
    "tags",
    "notes",
    "cpu",
    "memory",
    "disks",
    "network",
    "updated",
    "terminal",
  ]) {
    const selector = `[data-monitor-column=${key}] [role=separator]`;
    const point = await run(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:Number(e.getAttribute('aria-valuenow'))}})()`,
    );
    owner.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    owner.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(point.x + 28),
      y: Math.round(point.y),
    });
    owner.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: Math.round(point.x + 28),
      y: Math.round(point.y),
    });
    await until(
      () =>
        run(
          `Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))>=${point.width + 27}`,
        ),
      `${key} width responds to dragging`,
    );
    widths[key] = await run(
      `Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))`,
    );
    assert.ok(
      await run(
        `(()=>{const h=document.querySelector('[data-monitor-column=${key}]');const i=[...h.parentElement.children].indexOf(h);const cell=document.querySelector('tbody tr').children[i];return Math.abs(h.getBoundingClientRect().width-cell.getBoundingClientRect().width)<1})()`,
      ),
      "header and body column widths stay aligned",
    );
  }
  await run(
    "document.querySelector('[data-monitor-column=host] [role=separator]').focus()",
  );
  owner.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  widths.host += 8;
  await until(
    () =>
      run(
        `Number(document.querySelector('[data-monitor-column=host] [role=separator]').getAttribute('aria-valuenow'))===${widths.host}`,
      ),
    "column size can also be adjusted by keyboard",
  );
  await run("window.monitorFixture.seed(1200,'list')");
  await until(() => run('!!document.querySelector("table")'), "list remounts");
  for (const [key, width] of Object.entries(widths))
    assert.equal(
      await run(
        `Number(document.querySelector('[data-monitor-column=${key}] [role=separator]').getAttribute('aria-valuenow'))`,
      ),
      width,
      "column widths survive remounting",
    );
  await scroll("e.scrollHeight");
  await until(
    () => run('!!document.querySelector("[data-monitor-host=host-1199]")'),
    "last table row can be reached",
  );
  await click("[data-monitor-terminal=host-1199]");
  assert.deepEqual(
    await run("window.monitorFixture.connections()"),
    ["host-1199"],
    "recycled row opens the correct host",
  );
  await run(
    `(()=>{const e=document.querySelector('input[placeholder="搜索主机、分组、标签或备注"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'1199');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await until(
    async () => (await count()) === 1,
    "filtering at the bottom does not leave a blank virtual viewport",
  );
  assert.ok(
    await run('document.body.textContent.includes("Production server 1199")'),
  );
  await run("window.monitorFixture.seed(40,'list')");
  await until(
    () => run('document.querySelectorAll("tbody tr").length>2'),
    "unfiltered list restores",
  );
  await screenshot("monitor-list.png");
  for (const width of [460, 1000]) {
    owner.setSize(width, 900);
    await wait(100);
    await run("window.monitorFixture.seed(40,'charts')");
    await until(
      () => run('!!document.querySelector("[data-monitor-host]")'),
      "cards fit resized viewport",
    );
    assert.ok(
      await run(
        'Array.from(document.querySelectorAll("[data-monitor-host]")).every(e=>e.getBoundingClientRect().height===368)',
      ),
      "card height is fixed at all widths",
    );
    assert.ok(
      await run(
        "(()=>{const e=document.querySelector('[data-section=vault-monitor-list]');return e.scrollWidth<=e.clientWidth+1})()",
      ),
      "cards do not overflow horizontally",
    );
  }
  await screenshot("monitor-charts.png");
  for (const locale of ["en", "zh-TW", "es", "ru"]) {
    await run(
      `window.monitorFixture.seed(40,'list',${JSON.stringify(locale)})`,
    );
    await until(
      () => run('!!document.querySelector("table")'),
      "translated table renders",
    );
    assert.equal(
      await run('document.body.textContent.includes("monitor.")'),
      false,
      "no missing translation keys",
    );
  }

  const openColumnMenu = async () => {
    const point = await run(
      `(()=>{document.querySelector('[data-section=vault-monitor-list]').scrollLeft=0;const r=document.querySelector('thead').getBoundingClientRect();return {x:Math.round(r.left+40),y:Math.round(r.top+20)}})()`,
    );
    for (const type of ["mouseDown", "mouseUp"])
      owner.webContents.sendInputEvent({
        type,
        button: "right",
        clickCount: 1,
        ...point,
      });
    await until(
      () => run('!!document.querySelector("[data-monitor-column-menu]")'),
      "header right-click opens column choices",
    );
  };
  await run("window.monitorFixture.seed(8,'list','zh-CN')");
  await until(
    () => run('document.querySelectorAll("th").length===11'),
    "all columns start visible",
  );
  await openColumnMenu();
  assert.equal(
    await run(
      `['host','terminal'].every(k=>{const e=document.querySelector('[data-monitor-toggle-column='+k+']');return e.getAttribute('aria-checked')==='true'&&e.getAttribute('aria-disabled')==='true'})`,
    ),
    true,
    "host and terminal cannot be hidden",
  );
  const optional = columnOrder.filter((k) => !["host", "terminal"].includes(k));
  for (const key of optional)
    await click(`[data-monitor-toggle-column=${key}]`);
  assert.deepEqual(
    await run(
      '[...document.querySelectorAll("th")].map(e=>e.dataset.monitorColumn)',
    ),
    ["host", "terminal"],
  );
  assert.ok(
    await run(
      '[...document.querySelectorAll("tbody tr")].every(e=>e.children.length===2)',
    ),
    "hidden headings and row cells stay aligned",
  );
  owner.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  owner.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await run("window.monitorFixture.seed(8,'list','zh-CN')");
  await until(
    () => run('document.querySelectorAll("th").length===2'),
    "column visibility survives reopening",
  );
  const hostWidthBefore = await run(
    'document.querySelector("tbody tr td").getBoundingClientRect().width',
  );
  await run(
    'document.querySelector("[data-monitor-column=host] [role=separator]").focus()',
  );
  owner.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  owner.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
  await until(
    () =>
      run(
        `document.querySelector('tbody tr td').getBoundingClientRect().width===${hostWidthBefore + 8}`,
      ),
    "host visibly resizes after other columns are hidden",
  );
  await openColumnMenu();
  for (const key of optional)
    await click(`[data-monitor-toggle-column=${key}]`);
  owner.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  owner.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(
    () => run('document.querySelectorAll("th").length===11'),
    "hidden columns can be restored",
  );
  for (const view of ["list", "charts"]) {
    await run(`window.monitorFixture.seed(3,'${view}','zh-CN')`);
    await until(
      () => run('!!document.querySelector("[data-monitor-host=host-0]")'),
      "status fixtures render",
    );
    for (const status of [
      "login",
      "error",
      "disconnected",
      "unsupported",
      "queued",
      "connecting",
      "limit",
    ]) {
      await run(`window.monitorFixture.status('host-0','${status}')`);
      await until(
        () =>
          run(
            `document.querySelector('[data-monitor-host=host-0] button').getAttribute('aria-disabled')==='true'`,
          ),
        "unavailable host has disabled detail action",
      );
      assert.equal(
        await run(
          "getComputedStyle(document.querySelector('[data-monitor-host=host-0]')).opacity",
        ),
        "0.5",
        "unavailable host is dimmed",
      );
      await click("[data-monitor-host=host-0] button");
      assert.equal(
        await run(
          '!!document.querySelector("[data-section=vault-monitor-detail]")',
        ),
        false,
        "unavailable host does not open details",
      );
    }
    await run("window.monitorFixture.status('host-0','live',60000)");
    await until(
      () =>
        run(
          `document.querySelector('[data-monitor-host=host-0] button').getAttribute('aria-disabled')==='true'`,
        ),
      "stale readings cannot open details",
    );
    await click("[data-monitor-host=host-0] button");
    assert.equal(
      await run(
        '!!document.querySelector("[data-section=vault-monitor-detail]")',
      ),
      false,
      "stale host stays unavailable",
    );
    await click("[data-monitor-terminal=host-0]");
    assert.deepEqual(
      await run("window.monitorFixture.connections()"),
      ["host-0"],
      "login host can still open a terminal",
    );
    await run("window.monitorFixture.status('host-0','login')");
    const recoveryPoint = await run(
      `(()=>{const e=document.querySelector('[data-monitor-host=host-0]');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.left+30),y:Math.round(r.top+20)}})()`,
    );
    for (const type of ["mouseDown", "mouseUp"])
      owner.webContents.sendInputEvent({
        type,
        button: "right",
        clickCount: 1,
        ...recoveryPoint,
      });
    await until(
      () => run('!!document.querySelector("[data-monitor-retry=host-0]")'),
      "unavailable host context menu offers recovery",
    );
    await click("[data-monitor-retry=host-0]");
    await until(
      () => run('!!document.querySelector("#monitor-login-password")'),
      "recovery dialog opens separately from details",
    );
    assert.equal(
      await run(
        '!!document.querySelector("[data-section=vault-monitor-detail]")',
      ),
      false,
    );
    await click("#monitor-login-password");
    owner.webContents.insertText("fixture-password");
    await click("[role=dialog] button[type=submit]");
    await until(
      () => run('!document.querySelector("#monitor-login-password")'),
      "recovery clears password inputs",
    );
    assert.deepEqual(
      await run("window.monitorFixture.retries()"),
      [
        {
          id: "host-0",
          credentials: { username: "fixture", password: "fixture-password" },
        },
      ],
      "recovery forwards one-time credentials to the existing monitor retry path",
    );
    await run("window.monitorFixture.status('host-0','live')");
    await until(
      () =>
        run(
          `document.querySelector('[data-monitor-host=host-0] button').getAttribute('aria-disabled')==='false'`,
        ),
      "recovered host enables details",
    );
    await click("[data-monitor-host=host-0] button");
    await until(
      () =>
        run('!!document.querySelector("[data-section=vault-monitor-detail]")'),
      "live host opens details",
    );
    await run("window.monitorFixture.status('host-0','login')");
    await until(
      () =>
        run('!document.querySelector("[data-section=vault-monitor-detail]")'),
      "unavailable details close immediately",
    );
  }

  owner.setSize(1280, 650);
  await run("window.monitorFixture.seed(3,'charts','zh-CN',1800)");
  await until(
    () => run('!!document.querySelector("[data-monitor-host=host-0]")'),
    "long monitoring history renders",
  );
  await click("[data-monitor-host=host-0] button");
  await until(
    () => run('!!document.querySelector("[data-aside-scroll-viewport]")'),
    "native monitoring detail scroll opens",
  );
  await until(
    () =>
      run(
        `document.querySelector('[data-section=vault-monitor-detail]').getAnimations().every(a=>a.playState==='finished')`,
      ),
    "sidebar opening animation finishes before wheel input",
  );
  const wheelPoint = await run(
    `(()=>{const v=document.querySelector('[data-aside-scroll-viewport]');const r=v.getBoundingClientRect();window.monitorRefreshTimer=setInterval(()=>window.monitorFixture.refresh(),200);window.monitorWheelProbe={events:0,blocking:0};window.monitorWheelListener=e=>{window.monitorWheelProbe.events++;if(e.cancelable)window.monitorWheelProbe.blocking++;};document.addEventListener('wheel',window.monitorWheelListener,{passive:true});return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+180)}})()`,
  );
  for (let i = 0; i < 60; i++) {
    owner.webContents.sendInputEvent({
      type: "mouseWheel",
      ...wheelPoint,
      deltaY: -12,
      deltaX: 0,
      canScroll: true,
    });
    await wait(17);
  }
  await until(
    () =>
      run(
        "document.querySelector('[data-aside-scroll-viewport]').scrollTop>200",
      ),
    "wheel reaches lower detail sections with a half-hour history",
  );
  const wheelResult = await run("window.monitorWheelProbe");
  assert.ok(
    wheelResult.events > 40,
    "real wheel input reached monitoring details",
  );
  assert.equal(
    wheelResult.blocking,
    0,
    "detail wheel input does not wait for a cancellable handler",
  );
  assert.equal(
    await run(
      "document.querySelector('[data-section=vault-monitor-list]').scrollTop",
    ),
    0,
    "sidebar scroll leaves host collection in place",
  );
  await screenshot("monitor-native-detail-scroll.png");
  await run(
    "clearInterval(window.monitorRefreshTimer);document.removeEventListener('wheel',window.monitorWheelListener)",
  );
  await click("[data-section=vault-monitor-detail] button:has(.lucide-x)");
  owner.setSize(1280, 900);
  await run(
    `(()=>{document.documentElement.classList.remove('dark');for(const [k,v] of Object.entries({background:'0 0% 100%',foreground:'210 20% 15%',card:'210 20% 97%',secondary:'210 20% 94%',muted:'210 20% 95%','muted-foreground':'210 10% 45%',border:'210 20% 88%',popover:'0 0% 100%','popover-foreground':'210 20% 15%'}))document.documentElement.style.setProperty('--'+k,v)})()`,
  );
  await run("window.monitorFixture.seed(40,'charts','zh-CN')");
  await until(
    () => run('!!document.querySelector("[data-monitor-host]")'),
    "light cards render",
  );
  await screenshot("monitor-light.png");
  assert.deepEqual(errors, [], "no renderer errors");
  console.log(
    JSON.stringify({
      ok: true,
      virtualHosts: 1200,
      fixedCardHeight: 368,
      terminalActions: true,
      notesTooltip: true,
      latencySignals: true,
      gpuDetails: true,
      statusBeforeAction: true,
      allColumnsResize: true,
      persistedWidths: true,
      visibleColumns: true,
      unavailableHosts: true,
      nativeDetailScroll: true,
      variableRowHeights: true,
      filterAfterScroll: true,
      locales: 5,
      profile,
    }),
  );
}
app
  .whenReady()
  .then(main)
  .catch(async (e) => {
    console.error(e);
    process.exitCode = 1;
    if (owner && !owner.isDestroyed())
      fs.writeFileSync(
        path.join(profile, "failure.png"),
        (await owner.webContents.capturePage()).toPNG(),
      );
  })
  .finally(async () => {
    clearTimeout(watchdog);
    owner?.destroy();
    await vite?.close();
    app.exit(process.exitCode || 0);
  });
