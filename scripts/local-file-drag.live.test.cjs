"use strict";

// Interactive test: native drags must be driven by the OS, not synthetic DOM
// DragEvents. All filesystem fixtures and userData live in Netcatty's temp dir.
if (!process.versions.electron) {
  require("node:test")("native local file drag (interactive Electron)", {
    skip: "run npm run test:local-file-drag:electron and follow the window instructions",
  }, () => {});
} else {
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
  const { build } = require("esbuild");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
  const { registerHandlers } = require("../electron/bridges/localFileDragBridge.cjs");
  tempDirBridge.ensureTempDir();
  const fixture = fs.mkdtempSync(tempDirBridge.getTempFilePath("local-file-drag-live-"));
  app.setPath("userData", path.join(fixture, "profile"));
  const source = path.join(fixture, "source");
  const destination = path.join(fixture, "destination");
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  fs.mkdirSync(path.join(source, "folder"));
  fs.writeFileSync(path.join(source, "certificate test.txt"), "Netcatty native drag fixture\n");
  fs.writeFileSync(path.join(source, "folder", "nested.txt"), "Nested fixture\n");
  const preload = path.join(fixture, "preload.cjs");
  fs.writeFileSync(preload, `
    const { contextBridge, ipcRenderer, webUtils } = require('electron');
    const { createPreloadApi } = require(${JSON.stringify(path.resolve(__dirname, '../electron/preload/api.cjs'))});
    const api = createPreloadApi({ ipcRenderer, webUtils });
    contextBridge.exposeInMainWorld('netcatty', {
      startLocalFileDrag: async payload => { ipcRenderer.send('test:drag-report', {kind:'START_REQUEST', files:payload.paths}); const result = await api.startLocalFileDrag(payload); ipcRenderer.send('test:drag-report', {kind:'START_RESULT', result}); return result; },
      cancelLocalFileDrag: id => { ipcRenderer.send('test:drag-report', {kind:'CANCEL_REQUEST', id}); api.cancelLocalFileDrag(id); },
      getPathForFile: api.getPathForFile,
    });
    contextBridge.exposeInMainWorld('dragTest', {
      source: ${JSON.stringify(source)}, destination: ${JSON.stringify(destination)},
      report: payload => ipcRenderer.send('test:drag-report', payload),
    });
  `);
  const renderer = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { useSftpPaneDragAndSelect } from './components/sftp/hooks/useSftpPaneDragAndSelect';
    import { netcattyBridge } from './infrastructure/services/netcattyBridge';
    const report = (kind, files) => {
      document.querySelector('#result').textContent = JSON.stringify({kind, files}, null, 2);
      window.dragTest.report({kind, files});
    };
    for (const type of ['dragstart','dragenter','drop','dragend','mouseup','mousedown','blur','keydown']) window.addEventListener(type, e => window.dragTest.report({kind:'EVENT', type, buttons:e.buttons, key:e.key, types:e.dataTransfer ? [...e.dataTransfer.types] : []}), true);
    const noop = () => {};
    const entries = [
      {name: 'certificate test.txt', type: 'file', size: 28},
      {name: 'folder', type: 'directory', size: 0}
    ];
    function Pane({side, dragged, setDragged}) {
      const [selectedFiles, setSelected] = useState(new Set());
      const [remote, setRemote] = useState(false);
      const pane = {id: side, selectedFiles, connection: {
        id: side, isLocal: !remote, currentPath: window.dragTest.source
      }};
      const drag = useSftpPaneDragAndSelect({ side, pane, sortedDisplayFiles: entries, draggedFiles: dragged,
        onDragStart: (files, origin) => setDragged(files.map(f => ({...f, side: origin}))),
        onReceiveFromOtherPane: files => report('INTERNAL_COPY', files),
        onMoveEntriesToPath: async (paths, target) => report('INTERNAL_MOVE', {paths, target}),
        onUploadExternalFiles: async data => report('EXTERNAL_UPLOAD', Array.from(data.files).map(f => netcattyBridge.require().getPathForFile(f))),
        onOpenEntry: noop, onRangeSelect: names => setSelected(new Set(names)),
        onToggleSelection: (name, multi) => setSelected(old => {
          const next = multi ? new Set(old) : new Set();
          if (next.has(name)) next.delete(name); else next.add(name);
          return next;
        }),
      });
      return <section onDragOver={drag.handlePaneDragOver} onDrop={drag.handlePaneDrop} ref={drag.paneContainerRef}>
        <h2>{side} {remote ? 'REMOTE (regression)' : 'LOCAL'}</h2>
        <button onClick={() => setRemote(!remote)}>Toggle local/remote</button>
        {entries.map((entry, i) => <div key={entry.name} draggable className={'file ' + (selectedFiles.has(entry.name) ? 'selected' : '')}
          onClick={e => drag.handleRowSelect(entry,i,e)}
          onDragStart={e => drag.handleFileDragStart(entry,e)} onDragEnd={() => setDragged(null)}
          onDragOver={e => drag.handleEntryDragOver(entry,e)} onDrop={e => drag.handleEntryDrop(entry,e)}>
          {entry.name}
        </div>)}
        <p>Drop here to copy between panes.</p>
      </section>;
    }
    function App() {
      const [dragged,setDragged] = useState(null);
      return <><h1>Netcatty native drag test</h1>
        <p>Drag a file to the blue target, another pane, or Finder/Explorer. Cmd/Ctrl-click for multi-selection. Escape cancels.</p>
        <main><Pane side='left' dragged={dragged} setDragged={setDragged}/><Pane side='right' dragged={dragged} setDragged={setDragged}/></main>
        <div id='native' onDragOver={e => {e.preventDefault();e.dataTransfer.dropEffect='copy';}}
          onDrop={e => {e.preventDefault();report('NATIVE_DROP', Array.from(e.dataTransfer.files).map(f => netcattyBridge.require().getPathForFile(f)));}}>
          Native file destination (expects real Files, never text)
        </div>
        <p>Finder/Explorer destination: {window.dragTest.destination}</p><pre id='result'>No drops yet</pre>
      </>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  let win;
  ipcMain.on("test:drag-report", (event, payload) => {
    if (event.sender !== win?.webContents) return;
    if (payload.kind === "NATIVE_DROP") {
      if (!payload.files?.length || payload.files.some(file => !fs.existsSync(file))) {
        console.error("FAIL_NATIVE_FILES", JSON.stringify(payload));
        return;
      }
    }
    console.log("DRAG_RECEIPT", JSON.stringify(payload));
  });
  app.whenReady().then(async () => {
    await build({ stdin: { contents: renderer, loader: "tsx", resolveDir: path.resolve(__dirname, "..") },
      bundle: true, platform: "browser", format: "iife", outfile: path.join(fixture, "renderer.js"),
      define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning",
    });
    const html = path.join(fixture, "index.html");
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>
      body{font:16px system-ui;margin:24px;background:#fff;color:#18243a}main{display:flex;gap:24px}
      section{padding:20px;background:#f1f4f9;flex:1;border:1px solid #ccc}.file{padding:20px;margin-top:15px;border:1px solid #ddd;cursor:grab;background:white}
      .selected{background:#bddbff}#native{padding:35px;background:#bddbff;margin-top:24px}pre{white-space:pre-wrap;font-size:12px}
      </style><div id="root"></div><script src="renderer.js"></script>`);
    win = new BrowserWindow({ width: 1000, height: 760, title: "Netcatty native drag test", webPreferences: {
      preload, contextIsolation: true, nodeIntegration: false, sandbox: false,
    }});
    registerHandlers(ipcMain, { getWindows: () => win && !win.isDestroyed() ? [win] : [], nativeImage });
    await win.loadFile(html);
    console.log("DRAG_FIXTURE", fixture);
    console.log("Close the test window when finished. Fixtures remain here for content verification.");
  }).catch(error => { console.error(error); app.exit(1); });
  app.on("window-all-closed", () => app.quit());
}
